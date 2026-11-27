## [2026-11-27] build | Tile footers wrap by group on narrow tiles
On a narrow review tile the footer used to wrap one control per row: Review diff alone, View PR with its
badge, then Push next to Archive. Footers now wrap whole groups. Review tiles keep Review diff, View PR and
Push on the first row, with the PR state badge, CI and Archive on a second row (`PrStatus` is split
from the new `PrButton` in `PrLink.tsx`). The other tiles right-align their Archive · Resume · Open
group. No telemetry: this is layout only. Page: [screen-wall](../pages/screen-wall.md).
