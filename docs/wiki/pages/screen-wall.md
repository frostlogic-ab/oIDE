# Screen: the Wall (Mission Control)

The main screen: one tile per agent across every open project. Design:
[raw/design/Main.dc.html](../raw/design/Main.dc.html). Code: `apps/desktop/src/renderer/src/screens/Wall/`.
Data: [agent-supervisor](agent-supervisor.md) (statuses, activity, context), [subagents](subagents.md)
(chips), [desktop-shell](desktop-shell.md) (stores, keymap, mock bridge). Opened over by
[screen-spawn](screen-spawn.md).

## Layout

| Part | What it shows | Source |
| --- | --- | --- |
| Projects sidebar (248px) | "All projects" + each project with its agent count and, when its main checkout is behind its upstream after the background fetch, an amber **Pull N** button (`git.pull` with `from: 'sidebar'`, fast-forward only; a toast says what was pulled or why git refused; sync state from `useSyncStates`, one `git.sync` per project, refreshed on `git.changed`); agent rows with status dot (click selects the tile); New project (+, opens the [New project](new-project.md) dialog); Legend | `useProjects`, `useAgents`; "All projects" and project headers set the shared scope (`useScope.setScope`), so they double as the project scope switcher for Files and Source control |
| Header row | "All agents" or the project name; filter chips All / Needs you / Running / Review with counts; Spawn agent | counts from `filterCounts()` over agents in scope |
| Tile grid | `repeat(auto-fill, minmax(300px, 1fr))`, gap 12 | one `AgentTile` per visible id |
| Artifacts aside (280px, hidden under 1280px) | three newest artifacts in scope with live 72px thumbnails (the shared `ArtifactThumbnail` from the Artifacts screen; the stylised kind blocks until it loads or when there is nothing to show), "used by N agents" / "being written now"; Marketplace teaser | `artifacts.list`, `artifacts.uses` (reloads on `artifacts.changed`) |
| Compact confirm | "Compact this session?" with the 44px ring | opened by a tile's context ring |

## Tile

Header: `project · branch` (mono), status label + dot (`Running · 14m`, `Needs permission`, `Has a question`,
`Ready for review`, `Paused by plan limit`, `Error`, `Queued`, …), context ring button. Title on its own full-width row; below it, a wrapping badge row (only when there is a
badge): a mode badge when the agent's mode differs from Settings › default mode (Bypass always, as a red
warning badge), and the merge-conflict badge. Badges never share the title's row, so they can't squeeze it.
Tone (card colours) from `agentStatusMeta(status).tone`.

The 92px body depends on `tileBodyKind(agent)`:

| Kind | Body | Footer |
| --- | --- | --- |
| activity (running, starting, paused, stopped) | last 5 `activity` lines: `●` done, `◐` in progress (ends with "…", or a running subagent's line), `⎿` results, `↳ Subagent` lines, `+n −n` coloured | diff stat (`DiffStat`) or "No changes yet"; Resume for paused/stopped; Open |
| permission | "Subagent *X* wants to run:" + the command (Bash), path (Edit/Write), URL (WebFetch) or summary, + the tool's description | Allow once · Always in *project* (tooltip shows the rule saved; greyed out when the request has no `suggestedRule`) · Deny · Open. Y / D hints show when the tile is focused |
| question | `lastMessage` | inline reply box → `agents.send` text; paste a screenshot, drop files or the paperclip (Attach file) to add attachments, shown as one compact chip row above the input (see [screen-focus](screen-focus.md#attachments)) |
| review | `review.summary` + diff stat | Review diff (→ Review) · Open PR (`git.openPr` then `shell.openExternal`; hidden when `git.prAvailable` says no) · with an open/draft PR: View PR #n + Push (`git.pushToPr`: follow-up commits and leftover files go to that PR; shown only when the worktree has some; see [Review](screen-review.md)) |
| queued | "Waiting for a free slot", max running from Settings | Open |
| rate-limited | reset time; "oIDE does not retry on its own" | "Resets 4:00 PM" · Resume (manual only) · Open |
| error | "The claude process exited with code N" + last error line | Resume (`agents.resume`, respawns with `--resume`) · Open |

Narrow tiles wrap their footer by group, not button by button (`TileBody.tsx`, `FOOTER` / `TRAILING`):
the buttons stay on the first row, and the trailing group moves to its own row with its last control
on the right. On review tiles that row holds the PR state badge and CI (`PrStatus`, split from the
`PrButton`) on the left and Archive on the right. On the other tiles it holds Archive · Resume · Open,
right-aligned. When the tile is wide enough, everything fits on one row.

Subagent chips: `ModelLetterChip` per subagent (dot = status, letter = model family H/S/O/F), summary
from `subagentSummary()` ("2 of 3 running", "1 needs you", "1 running, 1 queued", "3 done"), tooltip from
`subagentDetail()` ("Sonnet, medium effort · routed as standard · needs permission · asking to run …").
Clicking a chip opens Focus on that subagent. "No subagents" when there are none.
The chip list is capped at about three and a half rows (95px) and scrolls past that, so an agent that ran
dozens of subagents does not stretch its tile and, through the grid row, every tile beside it. Clicks on
that scrollbar do not open the agent. Chip tooltips use `Tooltip`'s `portal` mode (a fixed bubble in
`document.body`, hidden on any scroll) so the scroll box cannot clip them.

Context ring: `contextUsed / contextWindow`, amber from Settings `contextWarnAt`, red and tooltip
"/compact suggested" from `contextSuggestCompactAt`. Clicking opens the confirm; only Compact calls
`agents.compact` and then toasts "Sent /compact to … Compacting…". oIDE never compacts without it.

Merge conflicts ([screen-review](screen-review.md#merge-conflicts)): a tile whose agent is resolving conflicts oIDE sent it
(`summary.mergeConflict`) carries a "Resolving merge conflicts" badge in the badge row under the title, after the mode badge. A Ready-for-review tile
shows, next to its diff stat, how its branch stands against the main checkout ("Up to date with main",
"Behind main by 2 · would conflict"), from the cached `git.predictMerge` answer (`stores/mergePrediction.ts`).

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

No projects: "Start a project" with Open folder, Clone repository and New repository (each opens
the [New project](new-project.md) dialog on that tab). Projects but no agents: "No agents yet" with
Spawn agent and New project. A filter with no match: "No agents match
this filter" + Show all.

## Decisions

- **N on the Wall focuses the tile** instead of opening Focus (the canvas link goes to Focus): the
  inline prompt lets Y / D answer without leaving the Wall; Enter opens Focus. The header has no
  "Next that needs you" button (removed 2026-11-27 as redundant with the Needs you chip and N).
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
- Header stays one row at 1100px.
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

## Archived agents

Finished agents leave the tile grid for **Wall › Archived** instead of disappearing (ADR
[0010](../../adr/0010-archive-agents-instead-of-deleting.md)). The toggle next to the title reads
"Active · Archived (N)" (N for the current project scope); the command bar has "Show archived agents".

| Goes to Archived | Reason | Worktree |
| --- | --- | --- |
| Merge locally (Review), fully merged | `merged` + merge commit | Settings › Agents › Clean up (right away / after 7 days / never) |
| Its pull request merged on GitHub (see below) | `merged` + the PR's merge commit | same, but never deletes uncommitted work |
| Source control › Remove worktree (`agents.remove`) | `discarded` | deleted |
| Status `done` | `completed` | kept |
| Archive on a finished or stopped tile, or in the Focus header | `archived-by-user` (`completed` when done) | kept |

Archive is offered for `has-question`, `ready-for-review`, `paused`, `stopped`, `rate-limited`,
`error` and `done`; main refuses it (`conflict`) while the agent is working. An archived agent's row,
summary (`summary.archived = { at, reason, mergeCommit?, worktreeRemoved }`) and transcript stay in the
database; it is not in `agents.list`, so it never counts toward Max running, the header counters, the
status bar or the project counts.

The list (`components/ArchivedList.tsx`, TanStack Virtual, pages of 50 from `agents.listArchived`
with an `{ at, id }` cursor) shows title, outcome badge (Merged / Completed / Discarded / Archived),
project · branch, ended date, merge commit, "worktree deleted", +/− lines and the CLI-reported cost,
newest first, with a title search. Rows: Open (Focus, read-only: transcript from `agents.events`,
header with Unarchive and Delete permanently, no composer), Unarchive (`agents.unarchive`: back on the
Wall, stopped; Resume respawns with `--resume`, or is replaced by "Can't resume" when the worktree is
gone, `summary.resumeBlocked`), Delete permanently (`agents.deletePermanently`: main shows a native
confirmation, then deletes the row, its events and any leftover worktree). Store:
`stores/archive.ts` (`agents.archived` adds, an `agents.summary` for a held id means unarchived,
`agents.removed` deletes).

**Interrupted.** Agents that were working when oIDE quit or crashed come back on the Wall as
`stopped` with `summary.interrupted = { reason: 'restart' | 'crash' | 'mcp-down' }`: status label
"Interrupted", a body that says why and the last step, Resume and Archive. They are resumed
automatically (except `mcp-down`, resumed on the next good start); the flag clears once the process
runs again.

**Pull requests.** `summary.pr = { number, url, state, mergeCommit? }` comes from the user's own `gh`:
set when `git.openPr` succeeds and whenever a lookup finds a PR for the branch, also one opened
outside oIDE. Tiles, the Focus header and Review show "View PR #12" with an Open / Draft / Merged /
PR closed badge (opened through the external-link allow-list); "Open PR" shows only without a PR, and
`git.openPr` is idempotent (an existing open PR is returned with `existing: true`, also after gh's
"already exists"). `main/services/pr-watch.ts` polls only open and draft PRs (plus one discovery
lookup per finished agent per session), one at a time, after the background fetch (Settings › Agents
› Fetch interval) and on window focus (at most every 2 minutes); never offline, never without gh or
for untrusted projects; a gh error stops the round and backs off (interval × 2^n, at most 2 h). A
merged PR archives the agent (reason `merged`, process stopped, cleanup as for an in-oIDE merge,
including the 7-day sweep) and toasts "PR #12 merged · <title> archived". A closed PR only shows its
badge; Archive stays on the tile.

**CI checks on a PR (2026-11-27).** The same `gh pr view` lookup asks for `statusCheckRollup` (an
older gh that rejects the field is asked without it from then on) and counts it into
`summary.pr.checks = { state: pending | success | failure, total, completed, failed }`
(`summarizeChecks` in `packages/git/src/gh.ts`; check runs finish at `COMPLETED`, commit statuses
once not `PENDING`/`EXPECTED`; skipped and neutral count as passed). Open and draft PRs only. Next to
the state badge, `PrChecks` (`components/PrLink.tsx`) shows an amber pulsing dot and "7/9" while
checks run, a green check and "9/9" when all passed, a red mark and "2 failed" when some failed (the
dot turns red as soon as one fails, even while others run); clicking opens the PR's Checks tab. While
any PR has running checks, the git service runs `poll('checks')` every minute for just those PRs (same
offline / gh / trust / backoff rules); after Open PR or Push to PR the old checks are dropped and the
PR is watched up to 10 minutes for new ones to start.

**Reload rehydration (bug fixed 2026-11-25).** A live agent vanished from the Wall ("No agents yet",
"0 sessions") while it kept running in main. Cause: in dev, a Vite hot update that re-ran a store
module (any edit to it or to `packages/protocol`, which every store imports) gave the components a
new, empty store while `startStores()` had run once and kept loading and feeding the old one.
`lib/boot.ts` is now the HMR boundary for the stores it wires and reloads the page, so
`startStores()` rehydrates from main. Also: `agents.load()` retries with backoff (250 ms to 8 s) and
the Wall shows "Couldn't load your agents" with Retry instead of an empty state; a summary that fails
the IPC contract is repaired (invalid optional fields and list items dropped) or left out and logged
once, so one bad agent never empties `agents.list`; unreadable rows are skipped at restore. Tests:
`stores/rehydrate.test.ts`, `screens/Wall/Archive.test.tsx`, `screens/Focus/Archived.test.tsx`,
`test/integration/archive.test.ts`, `services/pr-watch.test.ts`, `e2e/archive.spec.ts` (reload with a
live agent, archive → Archived → unarchive).
