# Packaging, updates and CI

How oIDE becomes installers and how CI checks every change. Config lives in
`apps/desktop/electron-builder.yml` and `.github/workflows/`. App structure: [desktop-shell](desktop-shell.md).
Source: "Packaging, updates and CI" in the [build brief](../raw/build-brief.md).

## What ships

electron-vite bundles everything into `apps/desktop/out/` (main ESM, preload CJS, renderer assets).
Workspace packages (`@oide/*`, TypeScript source, ADR 0002), React, zod and the other renderer/main
libraries are **devDependencies** of `@oide/desktop`, so they are bundled and never packaged.
`dependencies` holds only what must exist at runtime as real modules:

| Dependency | Why it is not bundled |
| --- | --- |
| `@lydell/node-pty` | Native N-API prebuild per platform (ADR 0003), loaded lazily |
| `@parcel/watcher` | Native N-API prebuild per platform |
| `electron-updater` | Auto-update runtime |

`asarUnpack` keeps `@lydell/node-pty*`, `@parcel/watcher*` and any `*.node` outside the asar so they
can be loaded. `npmRebuild: false`: both natives are N-API prebuilds and work in Electron unchanged.
`node:sqlite` is built into Electron's Node (ADR 0001). `electronVersion` is pinned in the config
because the hoisted `node_modules` layout keeps electron-builder from reading it; bump it together
with the `electron` devDependency. `tslib` is an explicit devDependency because pnpm's hoisted linker
otherwise skips it (it is only reachable through optional wasm packages) and electron-builder needs it.

## Targets

| OS | Artifacts | Signing |
| --- | --- | --- |
| Windows x64/arm64 | NSIS installer (per-user, choose folder), zip | Unsigned unless release secrets exist (Azure Trusted Signing or a certificate) |
| macOS arm64/x64 | dmg, zip (for updates) | Unsigned by default (`identity: null`); hardened runtime on; release CI signs and notarizes when the Apple secrets exist |
| Linux x64/arm64 | AppImage, deb, rpm | Optional GPG `.asc` + `SHA256SUMS` on the release; Flatpak after v1 |

`appId: dev.oide.app`, `productName: oIDE`, output `apps/desktop/release/<version>/`.

## Electron fuses

Set by electron-builder at package time (`electronFuses`):

| Fuse | Value | Effect |
| --- | --- | --- |
| RunAsNode | off | `ELECTRON_RUN_AS_NODE` cannot turn the app into a Node runtime |
| EnableNodeOptionsEnvironmentVariable | off | `NODE_OPTIONS` is ignored |
| EnableNodeCliInspectArguments | off | `--inspect` and friends are ignored |
| EnableEmbeddedAsarIntegrityValidation | on | the app refuses a tampered `app.asar` |
| OnlyLoadAppFromAsar | on | code only loads from the asar |
| EnableCookieEncryption | on | cookies encrypted with the OS keychain key |

GrantFileProtocolExtraPrivileges stays at its default: the renderer is loaded from `file://` with ES
module scripts, which needs it. Because Node inspection is fused off, Playwright cannot drive a
packaged build; e2e tests run against `out/` (unpackaged), and a packaged build can be inspected with
`--remote-debugging-port`.

## Auto-update (M7)

`apps/desktop/src/main/services/updater.ts` (`UpdaterService`) wraps electron-updater (lazy
`import('electron-updater')`, externalized from the main bundle). Created in `services/index.ts` as
`services.updates` (Electron only; plain-Node integration tests have none and `handlers/updates.ts`
answers `disabled`). Renderer: Settings › Updates ([screen-settings](screen-settings.md)).

- **Consent.** `autoDownload` and `autoInstallOnAppQuit` are off. A check only finds out whether a
  newer version exists. Download is a click (`updates.download`); install is a second click plus an
  inline confirm (`updates.install` with `consent: true`), which runs `quitAndInstall(false, true)`:
  oIDE quits through the normal quit hooks (pending permissions deny, agents stop and resume after the
  restart), the installer runs and oIDE starts again.
- **Checks.** With Settings › Updates › Check automatically on (default), 15 s after startup and
  every 6 h; Check now at any time. `lastCheckedAt` is kept in `<userData>/updates.json`.
- **Channels.** `settings.updates.channel`: `stable` → `channel = latest`, no prereleases; `beta` →
  `channel = beta`, `allowPrerelease`. `allowDowngrade` stays off on both, so moving from beta back to
  stable waits for the next stable version above the installed beta. Changing the channel forgets an
  update that was found but not downloaded. How electron-updater's GitHub provider resolves them
  (checked against electron-updater 6 / electron-builder 26 and the v0.2.0 release):
  - stable asks `github.com/<owner>/<repo>/releases/latest` (published, non-prerelease releases
    only) and reads that release's `latest.yml` / `latest-mac.yml` / `latest-linux.yml` /
    `latest-linux-arm64.yml`.
  - beta takes the newest entry of `releases.atom` (stable or prerelease), tries `beta*.yml` and
    falls back to `latest*.yml`. electron-builder's GitHub publisher only ever writes `latest*.yml`
    (it ignores `generateUpdatesFilesForAllChannels`, which oIDE therefore no longer sets), so the
    fallback is what beta users read, for betas and stable releases alike.
  - `releases.atom` lists a tag as soon as it exists, before its draft is published. Beta users who
    check in that window get "no update file for this platform" (`ERR_UPDATER_CHANNEL_FILE_NOT_FOUND`)
    until finalize publishes the release, and a draft whose build failed (v0.2.0) keeps blocking beta
    checks that way until a newer release is published or the stuck tag is deleted. Stable is not
    affected. "No published versions on GitHub" (no release marked latest, or a repository with no
    tags at all) is shown as no newer version, not as an error.
  - Windows picks the per-arch installer (`oIDE-X-win-x64.exe` / `-arm64.exe`, matched on
    `process.arch`) from `latest.yml`, not the combined `oIDE-X-win.exe`.
- **Release feed (build time).** `electron-builder.yml` keeps `publish: null`, so a local or
  default build writes no `app-update.yml` and its updater is off ("This build has no release
  feed"). The release workflow's "Release feed" step picks the feed: the repository variables
  `OIDE_PUBLISH_OWNER` / `OIDE_PUBLISH_REPO` when set, otherwise the repository the workflow runs in
  (`frostlogic-ab/oIDE` for official builds; a fork publishes to and updates from itself). It builds
  main with them (`define` in `electron.vite.config.ts` → `buildPublishTarget()` in `updater.ts`)
  and passes `-c.publish.provider=github -c.publish.owner=… -c.publish.repo=…
  -c.publish.releaseType=draft` to electron-builder. The names are validated (`publishTarget()` in
  `packages/protocol/src/distribution.ts`); the marketplace index default is separate
  ([marketplace](marketplace.md#distribution-defaults)).
- **Telemetry endpoint:** official builds compile in the Umami host and website id from
  `packages/protocol/src/distribution.ts`; `OIDE_UMAMI_HOST` / `OIDE_UMAMI_WEBSITE_ID` at build time
  override them, and an empty value compiles telemetry out ([telemetry](telemetry.md#forks-and-builds)).
- **Off when:** no release feed was compiled in (above), development builds (`!app.isPackaged`), `OIDE_DISABLE_UPDATES=1`, builds without
  `resources/app-update.yml`, the Windows portable zip, Linux installs that are not an AppImage (`APPIMAGE` unset:
  deb/rpm users update through their package manager). The state is `disabled` with a reason.
  The Windows zip does carry `app-update.yml` (electron-builder packs it and the NSIS installer from
  the same `win-unpacked` folder), so the service also requires `Uninstall oIDE.exe` next to the
  exe, which only the NSIS installer writes; otherwise an update would install a second copy.
- **Telemetry.** Each finished check sends `update_checked` (`outcome`, `channel`) when usage
  analytics are on ([telemetry](telemetry.md)).
- **Unsigned builds.**
  - Windows: NSIS updates install. Without signing, electron-updater has no `publisherName` to verify,
    so the download is checked only by the sha512 in `latest.yml` (fetched over HTTPS from GitHub);
    SmartScreen may warn when the new installer runs. With Azure Trusted Signing or a certificate,
    electron-builder writes `publisherName` into `app-update.yml` and updates are signature-checked.
  - macOS: Squirrel.Mac installs only Developer ID signed apps. The service asks `codesign -dv` for a
    `Developer ID Application` authority; without it `canInstall` is false and Settings shows
    "Open release page" instead of Download.
  - Linux AppImage: updates in place (no signature check beyond sha512); optional GPG `.asc` files on
    the release are for people verifying by hand.
- **Publishing.** Release CI uploads to a **draft** GitHub Release (created by release-please) and
  publishes it only after every platform's installers, update files and `SHA256SUMS` are attached;
  electron-updater cannot see drafts, so users never get a half-uploaded release. Prerelease versions
  are published as pre-releases (beta channel), the others as *latest*. `OIDE_RELEASE_KEEP_DRAFT=true`
  leaves them as drafts for a maintainer. Full flow: [release-pipeline](release-pipeline.md).
- Tests: `updater.test.ts` (mocked electron-updater: consent, channels, disabled cases, unsigned
  macOS, errors, background timer), `UpdatesSection.test.tsx`, store default in `settings.test.ts`.

## CI and release workflows

- `.github/workflows/ci.yml` (push to main, every PR, manual). Node 24, pnpm from `packageManager`,
  `pnpm install --frozen-lockfile` in every job. What runs where:

  | Job | Pull request | Push to main |
  |---|---|---|
  | `changes` | classifies the PR's files (GitHub API) into code / docs site / docs only | everything counts as code |
  | `checks` (ubuntu) | `typecheck`, `lint` (skipped for docs-only PRs), `wiki:lint`, `licenses:check`, `docs:build` when `docs/site/**` changed | same, no docs build (`docs.yml` builds and deploys) |
  | `test` | Vitest on ubuntu, windows, macos (skipped for docs-only PRs) | same |
  | `e2e` | desktop build + Playwright on ubuntu under `xvfb-run` | on ubuntu, windows and macos |
  | `CI ok` | the one check to require in branch protection: fails if any job failed or was cancelled, skipped jobs pass | same |

  Why: typecheck and lint give the same answer on every OS, so they run once. Unit tests stay on
  three OSes because path handling (worktrees, junctions, `PATHEXT`, macOS `/private/var`
  realpaths) is core to oIDE and breaks per OS: the first runs on GitHub (2026-11-26) failed 5 tests
  on Linux, 11 on macOS and 10 on Windows, all of which pass on a Windows dev machine. Windows and
  macOS e2e are the slowest jobs and run on main only. "Docs only" means every changed file is under
  `docs/` or is a root `*.md`, except `docs/wiki/pages/telemetry.md` (read by
  `test/telemetry-docs.test.ts`). A new push to a PR cancels its older run; runs on main are never
  cancelled (one concurrency group per commit), so every commit on main gets a full result.
  Playwright output is uploaded on failure. `codeql.yml` (security-extended, no build) runs on PRs
  except docs-only ones, on every push to main (the baseline PR alerts are compared against, also
  never cancelled) and weekly.
- `release-please.yml` (push to main): release-please keeps the release PR current; merging it
  creates a draft release + tag and calls `release.yml`. `pr-title.yml` checks that PR titles follow
  Conventional Commits. See [release-pipeline](release-pipeline.md).
- `release.yml` (`workflow_call` from release-please with a `tag`, or manual `workflow_dispatch` with
  an optional tag): a verify job checks out the tag and fails unless it equals `v` + the
  `apps/desktop/package.json` version, then typecheck, lint, test, licences. One build job per OS runs
  `electron-builder --publish always` to the draft release (manual runs without a tag: `--publish
  never`, installers as workflow artifacts only). Signing is gated per secret (a step exposes
  only whether each is set): Windows Azure Trusted Signing (`AZURE_*` secrets + signing vars →
  `-c.win.azureSignOptions.*`) or `WIN_CSC_LINK`; macOS `CSC_LINK` + `MAC_SIGNING_IDENTITY` →
  `-c.mac.identity`, notarization with Apple ID or App Store Connect API key secrets; otherwise
  `identity: null` / `CSC_IDENTITY_AUTO_DISCOVERY=false` and a warning. A last job uploads
  `SHA256SUMS`, optional GPG signatures (`GPG_PRIVATE_KEY`), then publishes the release (pre-release
  for prerelease versions, *latest* otherwise).
  The header of the workflow lists every secret and variable.
- `nightly-real-cli.yml`: opt-in (repo variable `OIDE_NIGHTLY_REAL_CLI=true`), self-hosted runner
  labelled `oide-real-cli`, runs `test/conformance/real-cli.test.ts` with `OIDE_REAL_CLI=1` on the
  runner's existing sign-in. Off until Anthropic answers whether CI may use a maintainer's
  subscription ([open questions](open-questions.md) row 17).
- `cli-compat.yml` (weekly): a hosted job installs the latest CLI and records `--version` / `--help`
  with `tools/fake-claude/record.mjs` (allow-listed env, never reads credentials, sanitizes paths,
  names, ids, emails and token-like strings); `test/conformance/cli-compat.test.ts` (gated by
  `OIDE_COMPAT_DIR`) diffs them against `tools/fake-claude/fixtures` (detected flags, permission modes,
  `TESTED_CLI_RANGE`, every stream-json line through the real parser). Drift opens or comments on a
  `cli-compat` issue. An opt-in self-hosted `session` job (`OIDE_CLI_COMPAT_SESSION=true`) also records
  a scripted stream-json session.
- `codeql.yml` (javascript-typescript; push, PR, weekly), `.github/dependabot.yml` (npm and actions
  weekly, grouped; Electron majors ignored and done by hand), `docs.yml` (VitePress site to GitHub
  Pages; Pages source must be "GitHub Actions").
- Supply chain (security round 2, SEC-34): every `uses:` is pinned to a full commit SHA with a
  `# vN` comment (Dependabot's `github-actions` updates keep both current), release jobs restore no
  dependency cache, and no workflow uses `pull_request_target` or expands PR titles or branch names
  in a `run:` step. `test/security/round2-workflows.test.ts` fails when a new workflow breaks one of
  these rules. Unsigned Windows betas install updates without a publisher check (SEC-40): sign
  stable releases.

## Icon, licences and the docs site

- Icon: the Signal mark on a dark rounded tile ([docs/brand](../../brand/README.md)). Sources
  `apps/desktop/build/icon.svg` (48 px and up) and `icon-small.svg` (16-32 px: heavier ring, larger
  agent, tighter tile), both written by `node tools/brand/build-brand.mjs`. `pnpm icons`
  (`tools/icons/build-icons.mjs`, @resvg/resvg-js, build-time only) rasterises them to `icon.png` (1024),
  `icons/<n>x<n>.png` (Linux, `linux.icon: build/icons`), `icon.ico` and `icon.icns` (containers
  written by the script), using `icon-small.svg` for every entry up to 32 px. electron-builder picks
  them up from `build/`.
- Runtime icon (`apps/desktop/src/main/app-icon.ts`): unpackaged runs (`pnpm dev`, e2e) set
  `BrowserWindow({ icon })` to `build/icon.ico` (Windows) or `build/icons/512x512.png` (Linux) and
  `app.dock.setIcon(build/icon.png)` on macOS, so the taskbar/dock no longer shows Electron's icon.
  Packaged Windows/macOS use the exe/bundle icon; packaged Linux reads `<resources>/icon.png`
  (`linux.extraResources`). On Windows `app.setAppUserModelId('dev.oide.app')` (= `appId`) runs before
  ready so dev and installed windows group under the oIDE icon. Windows draws a window with an explicit
  AUMID with the icon of the Start Menu shortcut that carries that AUMID, not the window icon. Electron
  writes such a shortcut itself for toast notifications (`<exe ProductName>.lnk`, so `Electron.lnk` →
  `electron.exe` in dev, with no icon), which made the dev taskbar show Electron's logo. Unpackaged Windows
  runs therefore set `build/icon.ico` on every Start Menu shortcut that targets the running exe with our
  AUMID (`brandAppShortcuts`, at ready and again after 1, 3, 10 and 30 s, since Electron writes it off-thread). Electron's rewrite check ignores the icon, so
  it sticks. Packaged builds skip this: that shortcut targets `oide.exe`, which carries the oIDE icon.
- Licences: `pnpm licenses:notices` (`tools/licenses/notices.mjs`) writes `THIRD_PARTY_NOTICES.md` for
  everything a packaged build ships (desktop `dependencies`, libraries bundled into `out/`, Electron);
  `pnpm licenses:check` fails on a licence outside the MIT-compatible allow-list or a stale file.
  `LICENSE` and `THIRD_PARTY_NOTICES.md` are copied to `resources/` (`extraResources`). As of
  2026-11-25: 368 shipped packages, all MIT-compatible (dompurify is dual MPL-2.0 OR Apache-2.0, used
  under Apache-2.0). Build-only MPL tools (@resvg/resvg-js, lightningcss) do not ship.
  The file must come out byte-identical on every OS, since the check runs in each release build.
  Per-platform prebuilds (`<parent>-<platform>`) and other optional dependencies that `pnpm-lock.yaml`
  restricts by `os`/`cpu`/`libc` (e.g. `fsevents` under chokidar, macOS only) are listed by name from
  the lockfile, never from what this machine installed; their licence is checked where installed.
- Fonts (`tools/licenses/fonts.mjs`, section "Bundled fonts" of the notices): 12 families. Excalidraw's
  folders (Assistant, Cascadia Code, Excalifont, Lilita One, Nunito, Virgil, Xiaolai SC: OFL-1.1; Comic
  Shanns: MIT; Liberation Sans 1.05: GPL-2.0 with the font exception, shipped unmodified as a separate
  file, with the Red Hat licence and GPL text reproduced), Inter and JetBrains Mono (`@fontsource`,
  OFL-1.1) and Monaco's Codicons (CC-BY-4.0). Licences are verified against the shipped files' name
  tables (a small WOFF2 reader) and upstream licence files; texts the packages lack are kept in
  `tools/licenses/texts/` (OFL, GPL-2.0, Liberation, Excalidraw's MIT, whose npm package has no
  LICENSE). The check fails for an Excalidraw font folder without a record, an embedded licence that
  disagrees, a non-MIT-compatible licence without a recorded reason, and, when `out/renderer` exists,
  any built font file that matches no record. `release.yml` runs it again after `Build app` for that
  reason. Test: `tools/licenses/test/fonts.test.ts`.
- Docs site: VitePress 2 (alpha, matches the repo's vite 8) in `docs/site/`, `pnpm docs:dev` /
  `pnpm docs:build`, base `/` for the custom domain `getoide.com`. Holds the user guide, the extension
  author guide, the security model and the FAQ; it links here for internals. Home page and theme:
  [docs-site](docs-site.md).
## Local commands

```
pnpm --filter @oide/desktop build      # out/
pnpm --filter @oide/desktop preview    # run the built app
pnpm --filter @oide/desktop e2e        # build + Playwright smoke
pnpm --filter @oide/desktop dist       # build + installers for this OS (unsigned, no publish)
pnpm --filter @oide/desktop exec electron-builder --config electron-builder.yml --dir   # unpacked app only
```
