# Review: design conformance (2026-11-24)

An adversarial check of the built renderer against the chosen Mission Control canvas
([../raw/design/](../raw/design/)), the design rules in [CLAUDE.md](../../../CLAUDE.md) and
[design-system](design-system.md). Each screen page's "Deviations" section was judged too.

## Method

- **Design reference**: each `.dc.html` was turned into a static page by a small DCLogic runtime (fills
  `{{ }}` holes from `renderVals()`, expands `<sc-if>` / `<sc-for>`, binds `onClick`, bundled fonts),
  then screenshotted with Playwright Chromium at 1440 wide and the canvas `$preview` height. States
  were reached with `__comp.setState(...)` (Focus subagent view, Plan tab, compact confirm; Marketplace
  without the dialog; Settings sections).
- **App**: `pnpm --filter @oide/desktop dev:web` (mock bridge, port 5174), routes driven through
  `useRouter.navigate`, same sizes, plus 1100×700 (the window minimum), `?wall=states`, `?wall=empty`,
  `?wall=no-projects`.
- **Probes**: computed-style measurements of matching elements in both renders, a contrast walk over
  every visible text node (alpha and opacity composited), an accessible-name check of every control,
  ARIA roles, and keyboard flows (J/K/N/Y/D/Esc/Ctrl+K on the Wall; J/K/N/Esc/D/Shift+Tab in Focus).
- **Evidence** lives in the session scratchpad:
  `C:\Users\Georges\AppData\Local\Temp\claude\23ccfd271218d0ea\fa47d3f8-27dd-4074-a6aa-323ea2d2c966\scratchpad\design-review\shots\`
  (`d-*.png` = design, `a-*.png` = app at 1440, `m-*.png` = app at 1100×700, `k-*.png` = keyboard).
  The generator (`build.mjs`, `engine.js`) and the screenshot runner (`shoot.mjs`, `probe.js`) are in
  the folder above it; rerun them to regenerate after a reboot. Shot names below are relative to `shots\`.

## What passed

Frame metrics are exact (header 44, rail 56, status bar 26; `aria-current="page"` on the rail item).
Focus, Review, Marketplace (list and Add custom), Source control and Settings match the canvas
closely in structure, copy and colour. No icon-only control lacks a name; every radiogroup, tablist
and dialog is labelled; segmented controls are radiogroups with arrow keys (accent switch verified:
ArrowRight moves to Green and sets `--color-accent: #7FC8A9`). Focus rings are accent (2px outline;
tiles use an accent ring). Keyboard: J/K/N move tile focus and N skips to needs-you tiles, Y allowed
the focused permission (toast "Allowed. The agent continues."), Esc clears, Ctrl+K opens the command
bar with focus in its input; in Focus J/K/N switch agents, Esc returns to the Wall, Shift+Tab cycles
mode (Auto → Manual). No horizontal page scroll at 1440 or 1100. **No blockers found.**

## Counts

| Screen | Blocker | Major | Minor |
| --- | --- | --- | --- |
| Global / frame | 0 | 1 | 3 |
| Wall | 0 | 2 | 5 |
| Focus | 0 | 2 | 1 |
| Spawn | 0 | 0 | 1 |
| Source control | 0 | 0 | 1 |
| Review | 0 | 0 | 2 |
| Artifacts | 0 | 0 | 1 |
| Marketplace | 0 | 0 | 3 |
| Files | 0 | 0 | 1 |
| Settings | 0 | 0 | 3 |
| **Total** | **0** | **5** | **21** |

## Global / frame

**G1 · major · Line height is 1.5 everywhere; the canvas uses `normal`.** Tailwind's preflight sets
`line-height: 1.5` on `html`; the canvas never sets one, so its text runs at Inter's `normal` (≈1.21).
Measured: 13px labels are 19.5px tall in the app vs 16px in the design, 14px titles 21 vs 17. Every
padded row grows: Wall sidebar agent rows 32 vs 28px, Source control worktree rows 57 vs 51px and
commit rows 28 vs 25px, Settings rows about +8px, Artifacts card meta lines 20 vs 18px. Fixed-height
controls (buttons, chips) are unaffected and match exactly. Fix: set `html { line-height: normal }`
in `apps/desktop/src/renderer/src/styles/app.css` (after the imports) or in `packages/ui/src/tokens.css`,
then re-check multi-line copy that relied on 1.5 (give those an explicit `leading-*` as the canvas
does: activity 1.6, prose 1.5). Evidence: `a-sc.png` vs `d-sc.png`, `a-wall.png` vs `d-wall.png`.

**G2 · minor · Status-bar counts disagree with the header.** `StatusBar.tsx` prefers `usage.sessions /
worktrees / subagentsActive / projectsOpen` over the live stores, so the Wall header says "5
subagents" while the status bar says "6 subagents active"; with `?wall=states` (11 agents) it still
says "6 sessions"; with `?wall=no-projects` it says "6 sessions · 3 projects open" next to a header
showing 0. Fix: `apps/desktop/src/renderer/src/components/frame/StatusBar.tsx`: derive from
`useAgents` / `useProjects` (the same `countAgents` the header uses) and keep `usage` for tokens and
reset time only. Evidence: `a-wall-states.png`, `a-wall-noproj.png`.

**G3 · minor · Text links lost their underline.** The canvas leaves `<a>` underlined for inline links:
"Open" on the permission tile, "Open in editor" (Review), "Open agent" (Files banner), "Edit presets"
(Spawn). The app draws them as colour-only buttons (`LinkButton` has `no-underline`), so on the amber
permission tile "Open" is distinguished by nothing but position (WCAG 1.4.1). Fix:
`packages/ui/src/Button.tsx` (`LinkButton`: `underline underline-offset-2`), `NavLink` in
`screens/Spawn/index.tsx:325`, `screens/Review/index.tsx:235`, `screens/Files/index.tsx:346`.
Evidence: `d-wall.png` vs `a-wall.png` (Wire the Claude Code CLI bridge tile), `d-review.png` vs `a-review.png`.

**G4 · minor · `ink-4` (#6B7584) is used for small text and fails 4.5:1.** Measured: "No subagents"
11px on `#15181D` 3.82:1 (3.67:1 on the error card), "No PR" 12px on `#111418` 3.96:1, Focus
timeline axis ("8m", "now 19m") 10px 3.82:1, placeholders ("Search settings", "Steer this agent…",
"Reply…") 3.82–4.17:1, Review line numbers `#5E6774` on the add background `#12261D` 2.78:1 (they
are buttons: "Comment on line N"). The canvas uses the same greys, but CLAUDE.md's 4.5:1 rule wins and
design-system marks `ink-4` "large text only". Fix: `ink-3` for these: Wall chips row (`screens/Wall/components/AgentTile.tsx`),
`screens/SourceControl/ProjectCard.tsx` (PR "No PR"), `screens/Focus/components/Inspector.tsx`
(timeline axis), placeholder colour in `packages/ui/src/Fields.tsx`, number column in
`screens/Review/UnifiedDiff.tsx`. Evidence: probe output (`..\probe-*.json`).

## Wall

**W1 · major · Tile bodies are 16px shorter than drawn, so activity lines are cut in half.** The
canvas box is `height: 92px; padding: 8px 10px` in content-box sizing (108px outer). `TileBody.tsx`
uses `h-[92px] box-border`, leaving 76px for five 18.4px lines: the fifth line ("↳ Grid tests ◐ Write
SessionGrid.test.tsx", "↳ Link checker ◐ Checking 48 pages…") shows only its top half. Permission,
question, review, queued and error bodies are 16px shorter too. Fix:
`apps/desktop/src/renderer/src/screens/Wall/components/TileBody.tsx` line 13: `BOX` →
`h-[108px] box-border` (or drop `box-border`). Evidence: `a-wall.png` (Rewrite the getting-started
guide, Build the window shell layout) vs `d-wall.png`; `a-wall-states-tall.png`.

**W2 · major · "Queued" is unreadable (2.9:1).** The queued tile gets `opacity-80`
(`AgentTile.tsx:77`) on top of the muted status colour (`packages/ui/src/status.ts`, `queued` →
`C.muted` = `ink-4`): the 11px "Queued" label renders `#5A626F` on `#15181D`. Queued is a real state
the brief asks the Wall to show. Fix: give `queued` (and `paused` / `stopped`) `C.dim` (`ink-3`) in
`status.ts`, and dim only the body box, not the whole tile. Evidence: `a-wall-states-tall.png`
(Add keyboard shortcuts to Settings).

**W3 · minor · Sidebar agent names are truncated.** The canvas lists short names that fit ("Window
shell layout", "Claude CLI bridge"); the app shows full titles cut at 248px ("Wire the Claude Code
CLI …", "Build the window shell lay…"). No deviation is recorded for this on
[screen-wall](screen-wall.md). Fix: `screens/Wall/components/ProjectSidebar.tsx` agent row: `line-clamp-2`
instead of `truncate` (and G1 for the 32px pitch). Evidence: `a-wall.png` vs `d-wall.png`.

**W4 · minor · At 1100px the header row wraps.** "Spawn agent" drops onto its own line below the title
and filter chips, pushing the grid down 44px. Fix: `screens/Wall/index.tsx` header row: `flex-nowrap`,
shrink "Next that needs you" to its Kbd + icon under 1280px, or let the chips scroll. Evidence: `a-wall-1100.png`, `m-wall.png`.

**W5 · minor · Status bar overflows at 1100 with a rate limit.** "Rate limited · resets Wed, Nov 25,
12:02 AM" pushes "3 projects open" off-screen (`overflow-hidden` clips it). The tile shows the same long
date. Fix: `StatusBar.tsx` and `lib/format.ts` `formatResetTime`: time only when within 24h ("resets 12:02 AM"),
truncate the left text first. Evidence: `m-wall.png`.

**W6 · minor · Mode badge copy "Edits".** The badge for `acceptEdits` reads "Edits"; Spawn and
Settings call the mode "Edit automatically". The badge itself is a justified addition (brief), the
word is not. Fix: label "Edit automatically" / "Plan mode" (with a `title`) in `AgentTile.tsx`.
Evidence: `a-wall.png` (Retry failed Stripe webhooks).

**W7 · minor · No-projects state.** Header "Spawn agent" stays enabled with zero projects (Spawn needs
one) and the Artifacts aside still lists artifacts from projects that are not open. Fix:
`screens/Wall/index.tsx` (disable or route to Open project), `ArtifactsAside.tsx` (filter by open
projects). Evidence: `a-wall-noproj.png`.

Deviations on [screen-wall](screen-wall.md): N focusing the tile instead of opening Focus, the mode
badge, chip colour = status, sidebar rows selecting tiles, diff stat instead of "1 doc artifact", tile
order by creation time and the hidden plan meters are all justified (verified: `sortOrder` sorts by
`createdAt`; the mock's timestamps just differ from the canvas order).

## Focus

**F1 · major · Focus breaks at the 1100×700 minimum.** With the 216px list and a 300–340px inspector,
the centre column is ~510px: the inspector tab "Terminal" is clipped ("Termi"), the session header
wraps to three rows (~140px, actions on their own line), subagent cards wrap mid-phrase ("Dependency /
setup", the "Sonnet · / medium" chip on two lines, "routed as / standard"), the permission prompt's
buttons wrap to a second row, and the list's keyboard hints are cut off at the bottom. Fix:
`screens/Focus/components/Inspector.tsx` (tablist `overflow-x-auto` or shorter labels; `min-w` 280
under 1280px), `SessionHeader.tsx` (single line: truncate meta, move Pause/Stop into a "More" menu when
narrow), `rows.tsx` subagent card (`whitespace-nowrap` on chips, let the route text drop first),
`PermissionPrompt.tsx` (stack text above buttons under ~600px). Evidence: `m-focus.png` vs `a-focus.png`.

**F2 · major · Agent list names are cut to ~14 characters.** `AgentList.tsx:71` truncates titles to one
line in 216px: "Wire the Claude C…", "Fix the flaky invoi…", "Rewrite the gettin…", "Build the window …",
"Draft the extensio…". The canvas wraps to two lines ("Getting-started rewrite"), so every agent stays
identifiable. This list is the only way to switch agents by mouse. Fix: `line-clamp-2` on the title in
`apps/desktop/src/renderer/src/screens/Focus/components/AgentList.tsx`. Evidence: `a-focus.png` vs `d-focus.png`.

**F3 · minor · Unknown subagent id renders an empty subagent view.** `focus { agentId: 'a-bridge',
subagentId: 'deps' }` keeps the lead header and "Lead agent" selected but shows the subagent intro with
"No task text was reported." Fix: in `screens/Focus/index.tsx`, fall back to the lead view (and
`replace` the route) when the subagent id is not in `agent.subagents`. Evidence: `a-focus-sub.png`
(valid id for comparison: `a-focus-sub2.png` vs `d-focus-sub.png`, which match).

Deviations on [screen-focus](screen-focus.md): inspector basis 320, model family in the header,
derived routing line, Stop-subagent tooltip, slash commands and the red tool-error dot are justified.
The subagent view, Plan tab and compact dialog match the canvas closely (`a-focus-plan.png`,
`a-focus-compact.png`).

## Spawn

**S1 · minor · Model rows do not line up.** "local-coder" is offered on the Orchestrator row only, so its
pill group is wider and its effort select sits ~90px right of the others (x≈900 vs 810); the canvas
has identical pill groups in a fixed column. The effort selects are also 34px / 13.5px against the
canvas 30px / 12px ("Effort: Low"). Same in Settings › Models. Fix: a grid with a fixed pill-group
column (or a disabled custom pill on sub-rows) and the 30px/12px select in `screens/Spawn/index.tsx`
and `screens/Settings/ModelsSection.tsx`. Evidence: `a-spawn.png` vs `d-spawn.png`,
`a-settings-models.png` vs `d-settings.png`.

Deviations on [screen-spawn](screen-spawn.md): the Model versions row, Advanced open / techniques
closed, and the kept footer copy are justified. The added "asks first" labels and the note under
Tools from extensions are good additions; they wrap "+ Find more in Marketplace" onto its own line, acceptable.

## Source control

**SC1 · minor · Rows wrap at 1100.** Review and ··· drop onto a second line under every worktree row,
doubling its height, and the branch meta truncates ("oide/shell-layout · from main · up to d…"). Fix:
`screens/SourceControl/ProjectCard.tsx`: a fixed grid with min widths; drop the status column text or
the PR column under 1280px. Row heights at 1440 are G1. Evidence: `m-sc.png` vs `a-sc.png`.

Deviations on [screen-source-control](screen-source-control.md) (full titles in the overlap card,
spinner, red error line) are justified.

## Review

**R1 · minor · Two different diff totals for the same agent.** The Review file list header says "8
files changed +128 −24" while the Wall tile, Source control row and Ready to review say "+342 −58".
The header sums parsed patches; the others read `AgentSummary.diff`. Fix: one source of truth in
`screens/Review/useReview.ts` / `index.tsx` (or make the mock patches in `lib/mock/scm.ts` add up).
Evidence: `a-review.png` vs `a-sc.png`.

**R2 · minor · Long lines and the inline comment box are clipped at 1100.** Code past the column edge
is cut ("deadLetter.push(event") with no visible horizontal scroll, and the comment box's right edge
disappears under the summary panel. Fix: `screens/Review/UnifiedDiff.tsx`: `overflow-x-auto` on the
diff body and size the comment box to the visible width. Evidence: `m-review.png`.

Deviations on [screen-review](screen-review.md) (shorter summary text, comments without a side) are
justified gaps. Unified/Split use `aria-pressed` buttons, fine for a two-state toggle.

## Artifacts

**A1 · minor · Doc preview cuts text mid-line.** The 190px detail preview ends inside "Risk labels"
(half a line visible) with no fade. Fix: `screens/Artifacts/Preview.tsx`: a bottom fade or clamp to
whole lines. Evidence: `a-artifacts.png`.

Deviations on [screen-artifacts](screen-artifacts.md) (search in the header, "imported from", hidden
Open in claude.ai, stylised thumbnails) are justified; the header search does not crowd the toolbar
at 1100 (`m-artifacts.png`, where the toolbar wraps its buttons to a second row, acceptable).

## Marketplace

**M1 · minor · URL field is monospaced.** "MCP server URL" renders in JetBrains Mono; the canvas uses
Inter for the URL (mono is for tool names). Fix: drop `font-mono` at
`screens/Marketplace/AddCustomDialog.tsx:447`. Evidence: `a-market-dlg.png` vs `d-market.png`.

**M2 · minor · Dialog footer wraps.** The added "not reviewed" badge pushes "Custom tools aren't reviewed…
Only add ones you trust." onto two lines; the canvas keeps one line. Fix: shorten the copy or drop the
badge from the footer (the detail already shows it) in `AddCustomDialog.tsx`. Evidence: `a-market-dlg.png`.

**M3 · minor · Wiki is stale about per-tool toggles.** The detail shows checkboxes on built-in
extension tools (Git), and main now has `extensions.setToolEnabled`, but [screen-marketplace](screen-marketplace.md)
"Gaps" still says no IPC sets it. The canvas detail shows tool rows without checkboxes; keep them (a
justified addition) and update the page. Evidence: `a-market.png` vs `d-market-list.png`.

Other recorded deviations (risk pills in consent, added dialogs, "remote" note, drop zone, computed
monograms) are justified. The list matches the canvas (monogram tints, row height, state colours).

## Files

**FI1 · minor · Editor colours and ligatures differ.** The canvas renders JetBrains Mono ligatures
(`=>` as ⇒) and tints function and component names (`StatusBar`, `useSessions`, `filter`, `CliStatus`)
in `#9DBBFA`; Monaco shows plain `=>` and leaves those identifiers white. Fix:
`screens/Files/monaco/setup.ts`: `fontLigatures: true` and token rules for function / type identifiers
in `oide-dark`. Evidence: `a-files-open.png` vs `d-files.png`.

Deviations on [screen-files](screen-files.md) (agent title in the banner, tab close and Ln/Col in
the tab bar, folders first) are justified.

## Settings

**SE1 · minor · Mono inputs in Claude Code.** CLI path and Extra CLI flags are `font-mono` 12px, 260px
wide; the canvas uses Inter at 282px ("auto-detect", "--verbose" placeholders). Fix:
`screens/Settings/ClaudeCodeSection.tsx:189,211`. Evidence: `a-settings-cli.png` vs `d-settings-cli.png`.

**SE2 · minor · Techniques open collapsed.** The canvas opens with the first technique expanded
(name, description, text, placement, On by default); the app starts with all collapsed, hiding the
editor. Fix: `screens/Settings/TechniquesSection.tsx`: expand the first card by default. Evidence:
`a-settings-tech.png` vs `d-settings-tech.png`.

**SE3 · minor · "Remove" in permission rules is link-blue.** The canvas draws it `#9AA3AE`. Fix:
`screens/Settings/PermissionsSection.tsx:148`. Evidence: `a-settings-perms.png` vs `d-settings-perms.png`.

Model rows: see S1. Deviations on [screen-settings](screen-settings.md) ("Check again", "Signed in",
worktree select, extra rows, undesigned sections, default section) are justified. The mock always
shows the "A settings file could not be read" banner, which pushes every section down by 94px in dev;
consider gating that fixture behind a URL switch like `?wall=states`.
