## [2026-11-27] build | Grey out git-ignored files in the Files tree

The Files tree now greys out files and folders the checkout's ignore rules exclude (VS Code explorer
style). `files.tree` runs `git check-ignore` once per listed folder through the new `@oide/git`
`ignoredPaths` and sets the optional `FileNode.ignored`; `visibleRows` carries it to everything under
an ignored folder. Tracked files are never greyed out, and folders outside git show as before. See
[Files](../pages/screen-files.md).
