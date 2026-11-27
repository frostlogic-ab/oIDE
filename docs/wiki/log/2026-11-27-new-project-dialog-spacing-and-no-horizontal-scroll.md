## [2026-11-27] build | New project dialog: spacing and no horizontal scroll

Fixed the New project dialog layout. The Clone tab's `1fr / 200px` grid let the Location path's
min-content width push Folder name past the dialog edge and scroll the body sideways; the grid is now
`minmax(0,1fr) / minmax(0,180px)`, the path truncates with an ellipsis, and the top `Dialog` body clips
horizontal overflow. Spacing: gap between tabs and below the description, roomier panel and repository
list padding, a 34px filter field and Choose button matching the inputs, and a shorter Repository
placeholder. Updated [new-project](../pages/new-project.md).
