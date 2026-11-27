## [2026-11-27] build | Files tree: context menu, new / rename / copy / move / delete

The Files tree could only browse. Right-clicking a file, folder or project header now opens a
context menu (new `ContextMenu` in `@oide/ui`) with New file / New folder (name typed inline in the
tree, validated as you type), Cut / Copy / Paste (also between main and agent worktrees), Copy path,
Reveal, Rename (F2) and Delete (to the system trash after a confirm). Main got `files.create`,
`files.rename`, `files.copy` and `files.delete` behind the path guard (checkouts only, `.git`
refused, symlinks acted on as links). Renamed or moved tabs keep their unsaved edits.

The editor's right-click Paste did nothing: Monaco reads the clipboard through `navigator.clipboard`,
and every permission but clipboard writes was denied. `clipboard-read` is now allowed for the app's
own top-level page only (iframes, so artifact previews and extension panels, are still refused).

New telemetry event `file_managed { action, crossCheckout }`.

Pages: [screen-files](../pages/screen-files.md), [security](../pages/security.md),
[desktop-shell](../pages/desktop-shell.md), [design-system](../pages/design-system.md),
[telemetry](../pages/telemetry.md).
