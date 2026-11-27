## [2026-11-27] build | Markdown preview in the Files editor

Markdown files in Files now open on their rendered page. Edit puts the Monaco source on the left
half and the live page on the right; Preview hides the source again. You switch with the tab bar
toggle or Ctrl/Cmd+Shift+V (`files.togglePreview`). The choice is kept per tab and forgotten when
the tab closes. Jumping to a line switches the tab to Edit. Relative links open the linked file of
the same checkout, and https links open the system browser.

`renderMarkdown` moved from the Artifacts preview to `lib/markdown.ts` so doc artifacts and Files
share it. It now uses its own `Marked` instance and draws GFM task boxes. The preview has its own
`.oide-md-file` styles because the shared `.oide-md` class is styled differently by Focus and
Artifacts. Added a `files_markdown_view` renderer telemetry event (`view`, `via`) and an `eye` icon.

Pages: [screen-files](../pages/screen-files.md), [desktop-shell](../pages/desktop-shell.md) (keymap),
[telemetry](../pages/telemetry.md).
