# Screen: the Wall (Mission Control)

The main screen: one tile per agent across every open project. Design:
[raw/design/Main.dc.html](../raw/design/Main.dc.html). Code: `apps/desktop/src/renderer/src/screens/Wall/`.
Data: [agent-supervisor](agent-supervisor.md) (statuses, activity, context), [subagents](subagents.md)
(chips), [desktop-shell](desktop-shell.md) (stores, keymap, mock bridge). Opened over by
[screen-spawn](screen-spawn.md).

## Layout

| Part | What it shows | Source |
| --- | --- | --- |
| Projects sidebar (248px) | "All projects" + each project with its agent count; agent rows with status dot (click selects the tile); Open project (+); Legend | `useProjects`, `useAgents`; "All projects" and project headers set the shared scope (`useScope.setScope`), so they double as the project scope switcher for Files and Source control |
| Header row | "All agents" or the project name; filter chips All / Needs you / Running / Review with counts; "Next that needs you N"; Spawn agent | counts from `filterCounts()` over agents in scope |
| Tile grid | `repeat(auto-fill, minmax(300px, 1fr))`, gap 12 | one `AgentTile` per visible id |
| Artifacts aside (280px, hidden under 1280px) | three newest artifacts in scope with kind thumbnails, "used by N agents" / "being written now"; Marketplace teaser | `artifacts.list`, `artifacts.uses` (reloads on `artifacts.changed`) |
| Compact confirm | "Compact this session?" with the 44px ring | opened by a tile's context ring |

## Tile

Header: `project · branch` (mono), status label + dot (`Running · 14m`, `Needs permission`, `Has a question`,
`Ready for review`, `Paused by plan limit`, `Error`, `Queued`, …), context ring button. Title, with a mode
badge when the agent's mode differs from Settings › default mode (Bypass always, as a red warning badge).
Tone (card colours) from `agentStatusMeta(status).tone`.

The 92px body depends on `tileBodyKind(agent)`:

| Kind | Body | Footer |
| --- | --- | --- |
| activity (running, starting, paused, stopped) | last 5 `activity` lines: `●` done, `◐` in progress (ends with "…", or a running subagent's line), `⎿` results, `↳ Subagent` lines, `+n −n` coloured | diff stat (`DiffStat`) or "No changes yet"; Resume for paused/stopped; Open |
| permission | "Subagent *X* wants to run:" + the command (Bash), path (Edit/Write), URL (WebFetch) or summary, + the tool's description | Allow once · Always in *project* (tooltip shows the rule saved) · Deny · Open. Y / D hints show when the tile is focused |
| question | `lastMessage` | inline reply box → `agents.send` text |
| review | `review.summary` + diff stat | Review diff (→ Review) · Open PR (`git.openPr` then `shell.openExternal`; hidden when `git.prAvailable` says no) |
| queued | "Waiting for a free slot", max running from Settings | Open |
| rate-limited | reset time; "oIDE does not retry on its own" | "Resets 4:00 PM" · Resume (manual only) · Open |
| error | "The claude process exited with code N" + last error line | Resume (`agents.resume`, respawns with `--resume`) · Open |

Subagent chips: `ModelLetterChip` per subagent (dot = status, letter = model family H/S/O/F), summary
from `subagentSummary()` ("2 of 3 running", "1 needs you", "1 running, 1 queued", "3 done"), tooltip from
`subagentDetail()` ("Sonnet, medium effort · routed as standard · needs permission · asking to run …").
Clicking a chip opens Focus on that subagent. "No subagents" when there are none.

Context ring: `contextUsed / contextWindow`, amber from Settings `contextWarnAt`, red and tooltip
"/compact suggested" from `contextSuggestCompactAt`. Clicking opens the confirm; only Compact calls
`agents.compact` and then toasts "Sent /compact to … Compacting…". oIDE never compacts without it.

Each tile has a visually hidden `aria-live="polite"` region with "<title>: <status>", so status
changes are announced.

## Keys (keymap scope `wall`)

| Key | Action |
| --- | --- |
| J / K | Focus the next / previous visible tile (wraps). DOM focus moves to the tile (`tabIndex=0`, accent ring) |
| N | Focus the next tile that needs you (`nextNeedsYou`, wraps); widens the filter to All if it hides them; toast when none |
| Enter | On a focused tile: open Focus |
| Y / D | Allow once / Deny the focused tile's pending permission (falls through when it has none) |
| Esc | Clear the selection |

The Wall pushes its scope one render after mount so it sits above App's global N (which opens Focus).
The compact confirm pushes a modal scope so J/K/N/Y/D do nothing while it is open.

## Data and performance

- `WallScreen` subscribes to the visible id list and the counts with `useShallow`; each `AgentTile` is
  `memo` and reads only `byId[agentId]`, so an `agents.summary` for one agent re-renders one tile.
- `useNow()` is one shared 30 s clock for every "Running · 14m".
- UI-only state (filter, focused tile, highlighted tiles, compact target) lives in `wallState.ts`
  (`useWall`). Spawn calls `highlightTiles(ids)`: the new tiles get an accent ring for 6 s and focus.
- Actions (`actions.ts`) toast errors; permission answers always quote the pending `requestId`.

## Empty states

No projects: "Open a project to get started" with Open project and Spawn agent. Projects but no
agents: "No agents yet" with Spawn agent and Open project. A filter with no match: "No agents match
this filter" + Show all.

## Decisions

- **N on the Wall focuses the tile** instead of opening Focus (the canvas link goes to Focus): the
  inline prompt lets Y / D answer without leaving the Wall; Enter opens Focus. The "Next that needs
  you" button does the same as N.
- **Mode badge only when it differs from the default mode**; the canvas draws none, the brief asks
  for one (Bypass must always be visible).
- **Subagent chip colour = status, letter = model**, as drawn; the letter is grey on the canvas.
- **Sidebar agent rows select the tile** (the canvas highlights the selected session), they do not
  navigate.
- **Footer "2 files · 1 doc artifact"** is not reproduced: there is no per-agent artifact count; the
  diff stat is shown instead.
- Tile order is the store's (creation time), not the canvas order.
- **Sidebar agent names wrap to two lines** (`line-clamp-2`) instead of the canvas's single line: the
  canvas lists short labels ("Window shell layout"), ours are the agent's goal, and one line cut them
  to "Build the window shell lay…" (design review W3).
- Mode badge words match Spawn and Settings: "Edit automatically", "Plan mode", "Manual", "Auto",
  "Bypass", with a `title` that explains the mode.
- Activity box 108px border-box (= the canvas's 92px content-box + padding, five 1.6-leading lines);
  the prompt, question, review, queued and error boxes are 92px border-box, as drawn.
- Queued tiles are not dimmed; only the body box is (`opacity-80`); the "Queued" label is `ink-3`.
- Header stays one row at 1100px: "Next that needs you" shortens to "Next N" below 1280px.
- With no project open, the header "Spawn agent" is hidden (Spawn needs a project) and the empty
  state offers only "Open project"; the Artifacts aside lists only artifacts of open projects.
- Plan meters show only from the CLI's `rate_limit_event` utilization (status bar, see [desktop-shell](desktop-shell.md), ADR 0007).
- A tile whose prompt was cut off by quitting oIDE (`AgentSummary.interruptedPermission`, while the agent is idle)
  shows "oIDE closed while waiting for your answer; send a message to continue." and the tool it asked for
  (`tileBodyKind` → `interrupted`).
- Queued spawns from any caller (IPC, extensions) appear at once: the supervisor publishes the queued summary.

## Mock fixtures

`pnpm --filter @oide/desktop dev:web` shows the six canvas agents. Add `?wall=states` for queued,
rate-limited, error, paused and Bypass tiles; `?wall=empty` and `?wall=no-projects` for the empty
states (`lib/mock/wall.ts`). `agents.spawn` in the mock creates queued agents that start under
Max running and stream activity.

## Tests

`screens/Wall/logic.test.ts` (summaries, activity parsing, permission view, filters, body kinds) and
`screens/Wall/Wall.test.tsx` (jsdom: tile statuses, rate-limit/error tiles, live store updates,
filters, Allow / Always / Deny and Y / D send the exact request id, reply, compact confirm, J / K / N /
Enter / Esc).
