# ADR 0008: Extension language servers are deferred

- Status: accepted
- Date: 2026-11-24
- Departs from: build brief, Extension system › Contribution points (v1): "`languages` | A language
  server for the Files editor | Child process started by the host"

## Context
Every other v1 contribution point now works end to end (see [extensions](../wiki/pages/extensions.md),
"UI contributions"). `contributes.languages` is parsed, its `command` is resolved inside the
package (`manifest.ts`), and a folder or git extension's language-server command line is shown in
the first-run consent dialog. Nothing starts it.

Wiring it properly needs more than a process and a pipe:

1. **Trust.** Language servers execute repository code: `tsserver` loads plugins named in
   `tsconfig.json` from `node_modules`, `rust-analyzer` runs `build.rs` and proc macros, `pylsp`
   imports project plugins. Starting one for an untrusted project would bypass
   [workspace trust](../wiki/pages/security.md#workspace-trust), so the rule (trusted projects only,
   or a separate consent per project) has to be decided and enforced in main first.
2. **Document sync with agents.** The Files editor shows files that agents edit at the same time
   (the agent-editing banner, reload on change). An LSP session needs `didOpen` / `didChange` with
   monotonic versions per URI; edits that arrive from disk (agents) and from Monaco must be merged
   into one version stream per worktree, or diagnostics point at the wrong lines.
3. **A renderer client.** `monaco-languageclient` brings `@codingame/monaco-vscode-api`, which
   replaces the Monaco build that `@monaco-editor/react` and our `monaco-editor@0.58` setup use
   (workers, CSP `worker-src blob:`, bundle size). The alternative is a small hand-written bridge:
   Monaco hover, completion and marker providers backed by an `lsp.*` IPC surface with a method
   allow-list. Either is a Files-editor change, and that screen is being changed in parallel.
4. **Process model.** One server per (extension language, worktree root), started on the first
   matching file, stopped when idle, restarted with backoff like extension host code; `file://`
   URI mapping that survives Windows drive-letter casing and long paths; every path the server
   reports checked against the project's allowed roots before the renderer sees it.
5. **Nothing to ship it against.** No built-in extension contributes a language, so only a test
   fixture would exercise it.

## Decision
v1 ships without extension language servers. `languages` stays in the manifest schema (so published
extensions keep validating), is still listed in the consent dialog, and is documented as "parsed,
not started". The Files editor keeps Monaco's built-in languages.

## What it takes to add
- Main: `LanguageServerService` (spawn with an allow-listed env and `cwd` = worktree, `vscode-jsonrpc`
  over stdio, lifecycle and backoff), started only for trusted projects where the extension is on.
- Protocol: `lsp.open` / `lsp.change` / `lsp.close` (Zod-validated, paths checked like `files.*`),
  `lsp.request` for `textDocument/hover`, `completion`, `definition` only, and an
  `lsp.diagnostics` event.
- Renderer: Monaco providers for those three requests and `setModelMarkers` from diagnostics, in
  `screens/Files/monaco/`.
- Tests: a fixture stdio server answering `initialize`, `hover` and `publishDiagnostics`; an e2e
  test hovering a symbol in Files.

## Consequences
- Extensions in the Languages category install and their other contributions work; their language
  server does not run.
- The conformance review marks `languages` as deferred by this ADR rather than missing.
