## [2026-11-27] build | Files: changed files open on their changes, unified or side by side

A file the Files tree colours as modified, renamed or conflicted now opens on its changes in
Monaco's diff editor, against the same version as the colours (the last commit in the main
checkout, the merge-base with the base branch in an agent worktree). The tab bar gets a "Changes
view" toggle: File (the plain editor), Unified and Split. The right side is the tab's own model, so
it stays editable and Ctrl/Cmd+S saves. The choice is per tab; the last layout picked is the default
for the next changed file and is remembered across launches.

New IPC `files.original` (`originalContent` in `@oide/git`, `git cat-file blob`, no filters), new
renderer telemetry event `files_diff_view { view }`, new `diff-unified` / `diff-split` icons.

Pages: [screen-files](../pages/screen-files.md), [telemetry](../pages/telemetry.md).
