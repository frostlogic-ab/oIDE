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
| Windows x64/arm64 | NSIS installer (per-user, choose folder), zip | Unsigned (Authenticode account is an open question) |
| macOS arm64/x64 | dmg, zip (for updates) | Unsigned (`identity: null`); hardened runtime on; Developer ID + notarization open |
| Linux x64/arm64 | AppImage, deb, rpm | Unsigned; Flatpak after v1 |

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

## Updates and publishing

`publish` targets GitHub Releases (`owner: oide-dev`, `repo: oide`, draft releases). electron-updater
reads them at runtime (stable/beta channels planned; Linux deb/rpm users update through their package
manager). Releases are built only in CI from tags.

## CI

- `.github/workflows/ci.yml` (push to main, every PR): matrix ubuntu / windows / macos, Node 24,
  pnpm from `packageManager`. Steps: `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm lint`,
  `pnpm test` (Vitest), `pnpm wiki:lint` (Linux), `pnpm --filter @oide/desktop build`, Playwright for
  Electron (under `xvfb-run` on Linux, where the e2e launcher adds `--no-sandbox`). Playwright output
  is uploaded on failure.
- `.github/workflows/release.yml` (tags `v*`, or manual): same matrix; installs `rpm` on Linux,
  typechecks and tests, then `electron-builder --publish always` with `GH_TOKEN` and
  `CSC_IDENTITY_AUTO_DISCOVERY=false` (unsigned), and uploads the installers as workflow artifacts.

## Local commands

```
pnpm --filter @oide/desktop build      # out/
pnpm --filter @oide/desktop preview    # run the built app
pnpm --filter @oide/desktop e2e        # build + Playwright smoke
pnpm --filter @oide/desktop dist       # build + installers for this OS (unsigned, no publish)
pnpm --filter @oide/desktop exec electron-builder --config electron-builder.yml --dir   # unpacked app only
```
