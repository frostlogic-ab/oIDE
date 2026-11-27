## [2026-11-27] build | Copy and paste in terminals

The terminals (Files panel and Focus › Terminal) could not copy or paste on Windows and Linux:
xterm.js turns Ctrl+C / Ctrl+V into control characters. `TerminalView.tsx` now attaches a key
handler (`clipboardKeys.ts`, unit-tested): Ctrl+C copies while text is selected and otherwise stays
the interrupt, Ctrl+Shift+C always copies, Ctrl+V / Ctrl+Shift+V / Shift+Insert paste, Ctrl+Insert
copies. macOS keeps Cmd+C / Cmd+V through the Edit menu. A right-click (or menu-key) context menu
offers Copy, Paste, Select all and Clear. Paste goes through `term.paste` for bracketed paste. No new
telemetry: which clipboard path someone uses answers no product question. See
[screen-files](../pages/screen-files.md#run-scripts-and-terminals).
