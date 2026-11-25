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
  stable waits for the next stable version above the installed beta. A tag with a prerelease part
  (`v0.2.0-beta.1`) produces `beta*.yml`; `generateUpdatesFilesForAllChannels: true` makes stable tags
  publish `beta*.yml` too, so beta users also get stable releases. Changing the channel forgets an
  update that was found but not downloaded.
- **Release feed (build time).** There is no default feed: the GitHub org `oide-dev` is not claimed
  yet, so `electron-builder.yml` has `publish: null` and a default build writes no `app-update.yml`.
  The release workflow reads two repository variables, `OIDE_PUBLISH_OWNER` and `OIDE_PUBLISH_REPO`:
  when both are set it builds main with them (`define` in `electron.vite.config.ts` →
  `buildPublishTarget()` in `updater.ts`) and passes `-c.publish.provider=github -c.publish.owner=…
  -c.publish.repo=… -c.publish.releaseType=draft` to electron-builder; when either is missing it
  builds with `--publish never` and a warning, uploads nothing, and the app's updater is off
  ("This build has no release feed"). Settings › Updates then shows no releases link.
- **What the owner sets after claiming the org:** in the repo's Settings › Variables, set
  `OIDE_PUBLISH_OWNER` (e.g. `oide-dev`) and `OIDE_PUBLISH_REPO` (`oide`). Nothing else changes; the
  names are validated (`publishTarget()` in `packages/protocol/src/distribution.ts`), and the
  marketplace index default is separate ([marketplace](marketplace.md#distribution-defaults)).
- **Telemetry endpoint:** official builds compile in the Umami host and website id from
  `packages/protocol/src/distribution.ts`; `OIDE_UMAMI_HOST` / `OIDE_UMAMI_WEBSITE_ID` at build time
  override them, and an empty value compiles telemetry out ([telemetry](telemetry.md#forks-and-builds)).
- **Off when:** no release feed was compiled in (above), development builds (`!app.isPackaged`), `OIDE_DISABLE_UPDATES=1`, builds without
  `resources/app-update.yml` (portable zip), Linux installs that are not an AppImage (`APPIMAGE` unset:
  deb/rpm users update through their package manager). The state is `disabled` with a reason.
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
- **Publishing.** Release CI uploads to a **draft** GitHub Release; electron-updater cannot see drafts,
  so nothing reaches users until a maintainer publishes the release. Beta tags are marked prerelease.
- Tests: `updater.test.ts` (mocked electron-updater: consent, channels, disabled cases, unsigned
  macOS, errors, background timer), `UpdatesSection.test.tsx`, store default in `settings.test.ts`.

## CI and release workflows

- `.github/workflows/ci.yml` (push to main, every PR): matrix ubuntu / windows / macos, Node 24,
  pnpm from `packageManager`. Steps: `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm lint`,
  `pnpm test` (Vitest), `pnpm wiki:lint` and `pnpm licenses:check` (Linux), `pnpm --filter @oide/desktop
  build`, Playwright for Electron (under `xvfb-run` on Linux, where the e2e launcher adds
  `--no-sandbox`). Playwright output is uploaded on failure.
- `release.yml` (tags `v*`, or manual): a verify job fails unless the tag equals `v` + the
  `apps/desktop/package.json` version, then typecheck, lint, test, licences. One build job per OS runs
  `electron-builder --publish always` to a draft release. Signing is gated per secret (a step exposes
  only whether each is set): Windows Azure Trusted Signing (`AZURE_*` secrets + signing vars →
  `-c.win.azureSignOptions.*`) or `WIN_CSC_LINK`; macOS `CSC_LINK` + `MAC_SIGNING_IDENTITY` →
  `-c.mac.identity`, notarization with Apple ID or App Store Connect API key secrets; otherwise
  `identity: null` / `CSC_IDENTITY_AUTO_DISCOVERY=false` and a warning. A last job uploads
  `SHA256SUMS`, optional GPG signatures (`GPG_PRIVATE_KEY`) and marks prerelease tags as prerelease.
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
  `pnpm docs:build`, base `/oide/` for `oide-dev.github.io/oide`. Holds the user guide, the extension
  author guide, the security model and the FAQ; it links here for internals.
## Local commands

```
pnpm --filter @oide/desktop build      # out/
pnpm --filter @oide/desktop preview    # run the built app
pnpm --filter @oide/desktop e2e        # build + Playwright smoke
pnpm --filter @oide/desktop dist       # build + installers for this OS (unsigned, no publish)
pnpm --filter @oide/desktop exec electron-builder --config electron-builder.yml --dir   # unpacked app only
```
