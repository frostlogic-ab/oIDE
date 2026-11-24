# Design system

Extracted from the Mission Control canvas ([../raw/design/](../raw/design/)), direction "A · Mission Control",
chosen for all screens. Implemented as Tailwind v4 theme tokens in `packages/ui/src/tokens.css` and
shared components in `packages/ui`. Screens must match the canvas; when in doubt, open the matching
`.dc.html` file and copy its spacing, sizes and colours.

## Colour

| Token | Hex | Use |
| --- | --- | --- |
| `ground` | `#0E1013` | App background, main content |
| `chrome` | `#0B0D10` | Header, left rail, status bar, inputs |
| `panel` | `#111418` | Sidebars, inspectors, cards on ground |
| `card` | `#15181D` | Inner cards, segmented controls |
| `raised` | `#1B1F26` | Hover rows |
| `selected` | `#1E2430` | Selected row / tab / rail item |
| `line` | `#232830` | Chrome borders |
| `line-2` | `#262B33` | Card borders |
| `line-3` | `#343A44` | Control borders, buttons |
| `line-4` | `#2B313B` / `#2B3240` | Dividers in cards |
| `ink` | `#E6E8EB` | Primary text |
| `ink-2` | `#C9CED6` | Secondary text |
| `ink-3` | `#9AA3AE` | Labels, meta, icons |
| `ink-4` | `#6B7584` | Disabled, placeholders (large text only) |
| `ink-5` | `#5E6774` | Line numbers |
| `accent` | `#7AA2F7` | Primary buttons, focus, selected rail icon (user-selectable) |
| accent options | `#7FC8A9`, `#C4A7E7`, `#F2C078` | Settings › Appearance |
| `link` | `#9DBBFA` (hover `#C4D6FC`) | Links, "ready for review" |
| `ok` | `#7FC8A9` (bright `#A8E0C6`, bg `#12261D`, `#12201B`, `#22463A`) | Running, additions, passed |
| `warn` | `#F2C078` (bg `#1A1813`, border `#5A4A2A`) | Needs you, heads-up |
| `bad` | `#F08A8A` (bright `#F4B8B8`, bg `#2A1618`, border `#4A2A2A`) | Errors, deletions |
| `violet` | `#C4A7E7` (bg `#4A3F66`) | Subagent / model letter chips |
| `review-bg` | `#131822` (border `#2C3A55`) | Review-ready cards, hunk headers |

Buttons on accent use text `#0B0D10`, weight 600.

## Type

- UI: Inter 400/500/600/700, base 13px. Common sizes 9.5, 10.5, 11, 11.5, 12, 12.5, 13, 14, 16, 18, 20px.
- Section labels: 11px, weight 600, `letter-spacing: 0.08em`, uppercase, `ink-3`.
- Code, paths, branches, shas: JetBrains Mono 400/500, 11-12.5px. Diff lines 12px / 20px line height.
- Fonts are bundled (`@fontsource/inter`, `@fontsource/jetbrains-mono`); no remote font loading (CSP).

## Shape and layout

- Radii: 3 (tiny chips), 6 (buttons, rows), 8 (inputs, cards), 10 (rail items, panels), 12 (project cards).
- App frame: header 44px (`chrome`, bottom border `line`), left rail 56px (40px square items, radius 10,
  selected = `selected` bg + accent icon), status bar 26px (11.5px `ink-3`).
- Buttons: 28px (small, 12px text) and 36px (primary, 13px text), radius 6-8, border `line-3`.
- Icons: inline stroke SVG, 18px, `stroke-width: 1.7`, round caps and joins. Never emoji.
- Status dots 6-8px circles in the status colour.

## Accessibility

Real `<button>`, `<a href>`, `<input>` + `<label>`; `aria-label` on icon-only buttons; `aria-current`
on the active rail item; radiogroups for segmented controls; 4.5:1 text contrast; focus rings in accent.
