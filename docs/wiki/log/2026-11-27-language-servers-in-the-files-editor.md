## [2026-11-27] build | Language servers in the Files editor
`contributes.languages` now works ([ADR 0019](../../adr/0019-language-servers-in-main-with-a-monaco-bridge.md),
superseding the deferral in ADR 0008). Main runs one language server per (language, checkout) for
trusted projects (`services/lsp/`: its own Content-Length JSON-RPC, full-text document sync with the
Monaco version id, crash restart with backoff, idle stop, stop before a worktree is deleted), behind
Zod-validated `lsp.*` commands and `lsp.diagnostics` / `lsp.state` events; every URI a server reports
goes through the path guard. The Files editor gets hover, completions with resolve, signature help,
go to definition / type definition / implementation, references peek, highlights, document symbols and
Format Document through a hand-written Monaco bridge (no monaco-languageclient), diagnostics as markers,
VS Code-style problem colours and counts in the tree, a Problems list in File activity and a server
status with Restart / Copy install command in the tab bar. A new built-in, manifest-only **Languages**
extension contributes TypeScript/JavaScript, Python, Rust, Go, C/C++, CSS, HTML, JSON, YAML and Bash
servers found on PATH; the manifest gains optional `name`, `install` and `initializationOptions`.
Telemetry: `language_server_started`. Pages: [screen-files](../pages/screen-files.md),
[extensions](../pages/extensions.md), [security](../pages/security.md), [telemetry](../pages/telemetry.md),
[milestones](../pages/milestones.md), [review-conformance](../pages/review-conformance.md).
