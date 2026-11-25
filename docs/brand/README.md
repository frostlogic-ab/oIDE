# oIDE brand

<p>
  <img alt="oIDE mark" src="logo-mark.svg" width="96">
  &nbsp;&nbsp;
  <img alt="oIDE wordmark" src="logo-wordmark.svg" width="260">
</p>

The mark is called **Signal**: an open lowercase **o** (the workspace, one place), the **lead agent**
sitting in its opening (mint, the colour oIDE uses for "running"), and the **hub** at its centre that
coordinates everything. One window, many agents in orbit: Mission Control.

It is pure vector, built from one geometry by [`tools/brand/build-brand.mjs`](../../tools/brand/build-brand.mjs)
(a circle path with a circular bite, two circles, gradients). Nothing in it comes from a font, a third-party
mark, or Anthropic's or Claude's branding: the product name and logo never include "Claude"
([CLAUDE.md](../../CLAUDE.md), rule 5).

## Files

| File | Use |
| --- | --- |
| [`logo-mark.svg`](logo-mark.svg) | The symbol on dark grounds (the app, docs dark mode, slides). 48 px and up. |
| [`logo-mark-light.svg`](logo-mark-light.svg) | The symbol on white or light grounds (docs light mode, GitHub light, print). |
| [`logo-mark-mono.svg`](logo-mark-mono.svg) | One colour, `currentColor` (black when used as a file). Tray icons, stamps, embossing, favicons on busy grounds. Uses the heavier small geometry. |
| [`logo-wordmark.svg`](logo-wordmark.svg) / [`-light`](logo-wordmark-light.svg) | Symbol + "oIDE" as outlines (Inter 700 proportions; no font needed). README, site headers, slides. |
| [`logo-wordmark.png`](logo-wordmark.png) | Raster wordmark for places that refuse SVG. |
| `logo-mark-{16,32,128,512}.png` | Raster previews of the mark. |
| [`social-preview.png`](social-preview.png) | 1280×640 GitHub social preview (Settings › General › Social preview) and the docs site's `og:image`. |
| [`logo-sheet.png`](logo-sheet.png) | The final set at 16-128 px on dark and light. |
| [`concepts.png`](concepts.png), [`concepts/`](concepts/) | The four explored concepts (history; not for use). |

App icons live with the app: `apps/desktop/build/icon.svg` (tile + mark, 48 px and up) and `icon-small.svg`
(16-32 px, heavier mark, tighter tile), rasterised by `pnpm icons` into `icon.ico`, `icon.icns`, `icon.png`
and `icons/<n>x<n>.png`. In the renderer, use the React component, not a file:

```tsx
import { Logo } from '@oide/ui';
<Logo variant="wordmark" size={22} />   // header: mark + "oIDE" in the UI font (Inter 700)
<Logo size={24} />                      // mark only, decorative
<Logo size={32} title="oIDE" />         // mark only, announced as "oIDE"
<Logo tone="mono" />                    // one colour (currentColor)
```

Regenerate everything after a geometry or colour change: `node tools/brand/build-brand.mjs && pnpm icons`.

## Where it is used

App icon (Windows `.ico`, macOS `.icns`, Linux PNG set), the runtime window/taskbar icon in dev and
unpackaged runs too (`apps/desktop/src/main/app-icon.ts`, plus `app.setAppUserModelId('dev.oide.app')` on
Windows), the header logo (`Header.tsx`), the screen error panel (`ErrorBoundary.tsx`), the renderer
favicon (inlined in `apps/desktop/src/renderer/index.html`), the docs site (nav logo, hero image, favicon,
`og:image`), the README header and the GitHub social preview. Built-in extensions have no icon field in
their manifest today, so they carry no logo.

## Colours

The brand colours are fixed. **The logo does not follow the user-selected accent** (Settings ›
Appearance): the accent themes the UI, the logo signs the product, and a mark that changes colour per user
stops being recognisable in screenshots and docs. Use `tone="mono"` when the logo has to sit quietly.

| Role | Dark ground | Light ground |
| --- | --- | --- |
| Ring gradient (top-left → bottom-right) | `#7AA2F7` → `#C4A7E7` | `#3B6FE6` → `#8A5CC8` |
| Lead agent (radial, highlight → base) | `#C2EBD8` → `#7FC8A9` | `#5CC39C` → `#2C9A73` |
| Hub (radial) | `#B4CBFB` → `#7AA2F7` | `#6E95F0` → `#3B6FE6` |
| Ring highlight | white at 38% | white at 30% |
| Wordmark letters | `#E6E8EB` | `#0E1013` |
| App icon tile | `#171C27` → `#0B0D10`, edge `#7AA2F7` / `#343A44` / `#C4A7E7` | same (the tile is its own ground) |

All values come from the design system ([design-system.md](../wiki/pages/design-system.md)): accent blue,
violet and mint, deepened for white grounds. Base colours against their ground: dark set 7.6:1 (blue),
9.1:1 (violet), 9.7:1 (mint) on `#0E1013`; light set 4.6:1, 4.7:1, 3.5:1 on `#FFFFFF` (graphics need 3:1).
Only the small radial highlights inside the orbs are lighter.

## Clear space and sizes

- **Clear space:** keep a margin of at least the **hub's diameter** (15% of the mark's width; 10 px
  around a 64 px mark) free of text and other marks on every side. For the wordmark, measure from the mark.
- **Minimum size:** mark 16 px (use the small geometry: `<Logo>` switches at 32 px and below, the
  `.ico` uses `icon-small.svg` up to 32 px); wordmark 80 px wide.
- **Wordmark lockup:** mark, a gap of 0.2 × the mark's width, then "oIDE" with the cap height at about
  60% of the ring's diameter, centred on the ring. Always "oIDE": lowercase o, capital IDE.

## Do

- Use the dark files on dark grounds (`#0E1013`, `#0B0D10`, anything darker than `#343A44`) and the
  `-light` files on white or light grey.
- Use the mono mark in a single ink when colour is not available or would be noise.
- Keep the opening at the top right, the agent inside the opening, the hub centred.

## Don't

- Don't recolour the gradient, swap it for the accent, or add colours outside the table above.
- Don't rotate, mirror, stretch, outline, bevel or add drop shadows beyond the app icon's own tile.
- Don't put the dark-ground mark on white (the violet end fades) or the light mark on dark.
- Don't add "Claude", Anthropic's marks or any resemblance to them, and don't pair the logo with words
  that suggest oIDE is made or endorsed by Anthropic.
- Don't redraw the letters in another typeface or change "oIDE" to "OIDE" / "Oide".
- Don't fill the ring's opening or detach the agent from it.

## Licence and trademark

The logo files and the scripts that make them are part of this repository and are licensed under the same
**MIT** licence ([LICENSE](../../LICENSE)). The MIT licence covers copyright only; it says nothing about
trademark use. Whether "oIDE" and this mark should be registered, and what a trademark policy for forks
should say (for example: forks keep the code, drop the name and logo), is open:
[open question 18](../wiki/pages/open-questions.md).

## How it was chosen

Four concepts were drawn on a 64-unit grid and compared at 16-128 px on dark and light
([concepts.png](concepts.png)):

1. **Orbit**: a thick gradient o with a tilted orbit and two agents. Reads as a generic "planet" icon,
   the thin orbit turns to noise at 16 px, and the violet-to-mint blend went grey.
2. **Facet**: an octagonal o cut into eight lit facets. The most "glassy", legible at 16 px, but it reads
   as a nut or a stop sign and says nothing about agents.
3. **Constellation**: a hub with six agents on a ring. The clearest story, but a blur of dots below
   32 px and close to generic network/molecule icons.
4. **Signal**: an open o with the lead agent in the opening and a hub. The best 16 px read (a heavy ring and
   one bright dot), a clear story, and unlike Ethereum, Solana, Polygon, Electron or Anthropic's marks.

Signal was refined: the ring is cut by a circular bite around the agent (instead of square ends), the
gradient runs blue → violet only (mint is kept for the agent, where it means "running"), the agent and
hub became lit orbs and the ring got a highlight for the glassy, dimensional look, and a heavier
geometry was added for 16-32 px.
