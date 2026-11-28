## [2026-11-28] build | Source control row menu opens outside the project card

The ··· menu on a worktree row in Source control rendered inside the project card, whose
`overflow: hidden` clipped it and gave the card an inner scrollbar. It now uses `Menu`'s `portal`
mode (fixed in `document.body`), like the session header's mode menu. Updated
[screen-source-control](../pages/screen-source-control.md).
