## [2026-11-27] build | Files tree git colours and Discard changes

The Files tree now shows git changes the way the VS Code explorer does: changed files green with
an M / A / U letter, folders holding changes tinted, and deleted files (and folders) as red,
struck-through rows that are not on disk. In the main checkout "changed" means uncommitted against
HEAD; in an agent worktree it means everything the branch changed since its base, committed or not.
Right-click a changed file or folder for Discard changes: it puts the version back (a new file is
deleted, a deleted one restored) after a confirmation.

New IPC `files.changes` and `files.discardChanges` (`@oide/git` `checkoutChanges` /
`discardCheckoutChanges`), a `changesStore` in the renderer, ghost rows in `visibleRows`, an `undo`
icon, and the `file_changes_discarded` telemetry event. Pages: [screen-files](../pages/screen-files.md#git-colours-changesstorets),
[telemetry](../pages/telemetry.md).
