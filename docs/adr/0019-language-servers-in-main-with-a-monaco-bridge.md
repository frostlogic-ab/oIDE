# ADR 0019: Language servers run in main, behind a small Monaco bridge

- Status: accepted
- Date: 2026-11-27
- Supersedes: [ADR 0008](0008-defer-extension-language-servers.md) (extension language servers deferred)
- Departs from: build brief, Extension system › Contribution points: "`languages` | A language
  server for the Files editor | Child process started by the host". Servers are child processes of
  **main**, not of the extension host process.

## Context
ADR 0008 deferred `contributes.languages` and listed what it would take: a trust rule, one document
stream per worktree, a renderer client, a process model and something to ship it against. The Files
editor is now stable enough (tabs, rename-follow, reload on discard) to carry it.

## Decision
1. **Where servers run.** `LanguageServerService` (`apps/desktop/src/main/services/lsp/`) spawns one
   server per (contributed language, checkout root) on the first open document that matches it,
   with `cwd` = the checkout and an allow-listed env (toolchain variables only; never tokens or
   `ANTHROPIC_*`). It speaks JSON-RPC over stdio itself (`jsonrpc.ts`, no `vscode-jsonrpc`
   dependency). Main, not the extension host: languages are manifest data (command + args), so no
   extension code needs to run, and main already owns the path guard and roots. An extension without
   host code (the built-in Languages extension) contributes servers too.
2. **Trust.** Servers execute repository code, so they start only for **trusted** projects, and only
   for extensions that are on for the project (built-ins are on by default; folder and git
   extensions show the server command line in their first-run consent). Revoking trust, turning the
   extension off, removing the project or deleting a worktree stops its servers (`recheck`,
   `stopUnder`; worktree deletion waits for them so Windows can remove the folder).
3. **Document sync.** Full-text sync with the Monaco model's version id (`lsp.open`, `lsp.change`
   debounced 200 ms and flushed before every feature request, `lsp.close`). Monaco is the only
   writer of an open document, so versions are monotonic; files agents change on disk are not open
   documents and servers watch those themselves. `files.write` sends `didSave`.
4. **Renderer client.** No `monaco-languageclient` (it replaces our Monaco build). A hand-written
   bridge (`screens/Files/monaco/lsp.ts`) registers Monaco providers for every language and answers
   only for models bound to a Files tab: hover, completion (+ resolve), signature help, definition,
   type definition, implementation, references, document highlights, document symbols and document
   formatting. Diagnostics arrive as an event and become markers, tree colours and a Problems list.
5. **A fixed method allow-list.** The renderer never sends LSP JSON: each feature is its own Zod-
   validated `lsp.*` command, and main builds the request. Servers may not apply workspace edits,
   show documents or open URLs (`workspace/applyEdit` answers `applied: false`).
6. **Paths.** Every `file://` URI a server reports goes through the path guard (`toCheckoutPath`):
   outside the checkout (including UNC paths and symlinks out) it is dropped before the renderer
   sees it. Positions are UTF-16 (`positionEncodings: ['utf-16']`), as Monaco counts.
7. **Process model.** Crashes restart with backoff (1 s → 30 s; five in three minutes and it stays
   `failed`); idle servers stop 3 minutes after their last document closes; at most 8 run at once.
   Windows `.cmd` shims run through `cmd.exe /d /s /c` only when their arguments are plain words.
8. **What ships.** A built-in, manifest-only extension `@oide/ext-languages` contributes
   TypeScript/JavaScript, Python (Pyright), Rust, Go, C/C++ (clangd), CSS, HTML, JSON, YAML and Bash
   servers by command name. oIDE bundles none: they are found on PATH (then in the checkout's
   `node_modules/.bin`), and a missing one shows its install command.

## Not in this change
Rename (edits across files the user has not opened), code actions and quick fixes, semantic tokens,
inlay hints, workspace symbols and `workspace/didChangeWatchedFiles`. Each needs either applying
workspace edits safely next to agents that edit the same files, or more capability negotiation.

## Consequences
- `contributes.languages` works for every extension; the manifest gains optional `name`, `install`
  and `initializationOptions` per language.
- Files gets hover, completions, go to definition, references, symbols, formatting and diagnostics
  for any language whose server is installed, in main checkouts and agent worktrees alike.
- Telemetry: `language_server_started { language, outcome }` (fixed language list, no paths).
