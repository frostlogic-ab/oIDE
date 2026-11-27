# ADR 0020: The common language servers ship with oIDE and run with the user's Node.js

- Status: accepted
- Date: 2026-11-27
- Amends: [ADR 0019](0019-language-servers-in-main-with-a-monaco-bridge.md) ("oIDE bundles none: they
  are found on PATH")

## Context
ADR 0019 found every language server on PATH and showed a copyable install command when one was
missing. In practice that left a fresh install with no hover, completion or diagnostics for the
files people open most (TypeScript and JavaScript, CSS, HTML, JSON, YAML) until they copied and ran
`npm install -g …` themselves.

Two ways to run a bundled Node server were ruled out:
- Electron's own binary as Node (`ELECTRON_RUN_AS_NODE`): the `runAsNode` fuse is off
  (`electron-builder.yml`), on purpose, and must stay off.
- A utility process: stdin cannot be piped to it, and `typescript-language-server` forks `tsserver`
  with `process.execPath`, which needs the fuse as well.

## Decision
1. **What ships.** `packages/language-servers` (`@oide/language-servers`) depends on
   `typescript-language-server` 5.x (Node >= 20) with TypeScript ~5.9, `vscode-langservers-extracted`
   (CSS, HTML, JSON) and `yaml-language-server` 1.x. All are MIT or Apache-2.0 and listed in
   `THIRD_PARTY_NOTICES.md`.
2. **How it ships.** `stage.mjs` copies their dependency tree from the installed `node_modules`
   (pinned by `pnpm-lock.yaml`, offline) into `apps/desktop/release/language-servers`, keeping the
   nesting and pruning files that never load (about 49 MB). electron-builder ships it as
   `resources/language-servers`, outside the asar. `smoke.mjs` starts every staged server in the
   release workflow. (`pnpm deploy` was tried first; it fails with `node-linker=hoisted`.)
3. **How it runs.** For a built-in Languages server whose command is neither on PATH nor in the
   checkout's `node_modules/.bin`, main runs the bundled script with the user's `node` (same
   allow-listed env, cwd and trust rule as any server). The user's own install always wins. Without
   Node.js the server is "not installed" and its install command becomes Node.js's
   (`winget` on Windows, `brew` on macOS; Linux keeps the npm command). Other extensions' servers
   never use the bundled copies.
4. **Missing servers are offered, not explained.** A toast asks once per language whether to
   install a missing server (Install / No; No is remembered). Install opens a Files terminal that
   types the install command main reads from the manifest (`lsp.install`, only the document goes
   over IPC, SEC-05), and main starts the server once it appears on PATH (polled every 3 s for 10
   minutes, never in a tight loop).

## Consequences
- Installers grow by roughly 12-15 MB compressed; the bundled servers are updated with oIDE releases
  (bump `packages/language-servers` and rerun `pnpm licenses:notices`).
- People without Node.js still need one install, now offered in one click on Windows and macOS.
- The HTML server's JavaScript mode resolves its library typings from a sibling TypeScript; that
  is upstream behaviour and unchanged.
