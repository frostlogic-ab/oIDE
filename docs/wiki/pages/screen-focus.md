# Focus screen

One agent in depth. Design: [raw/design/Focus.dc.html](../raw/design/Focus.dc.html); brief: "Screen by
screen" and "Subagents" in the [build brief](../raw/build-brief.md). Data: [agent-supervisor](agent-supervisor.md),
[subagents](subagents.md), [cli-integration](cli-integration.md). Frame and stores: [desktop-shell](desktop-shell.md).
Tokens and kit: [design-system](design-system.md).

Route: `focus { agentId, subagentId? }`. Code: `apps/desktop/src/renderer/src/screens/Focus/`.

```
[Agents 216px] [header · transcript · permission prompt · composer] [Inspector 320px basis, max 340]
```

## Files

| File | What it does |
| --- | --- |
| `index.tsx` | Screen: route → agent, keymap scope `focus` (J / K / N, Esc → Wall, Shift+Tab mode when nothing is focused), `FocusBody` (keyed by agent id): rows, row context, compact dialog, stop-subagent state, polite `aria-live` for new assistant text |
| `model/transcript.ts` | Pure event → row mapping (`buildRows`), `eventsFor` / `groupByParent` (subagent filtering by `parentToolUseId`), tool labels/meta, `lineDiff` / `toolDiff`, `subagentSteps`, `subagentFiles`, `reportedSlashCommands` |
| `model/focus.ts` | Agent list order and lines, `nextMode` (Shift+Tab cycle), `composeMessage` (composer → `UserMessage`), permission copy, subagent status text, token share, timeline geometry, routing line |
| `model/history.ts` | `useFocusHistory`: the transcript's own log for the agent on screen = `agents.events` pages (500, older pages on scroll-up via `beforeSeq`) merged with the store's live tail. Separate from the store because the store's tail is capped at 2000 and would drop scrolled-back history |
| `model/ui.ts` | Expanded/collapsed state (subagent cards, tool output, thinking, long diffs) outside the rows, so it survives virtualization |
| `components/Transcript.tsx` | `@tanstack/react-virtual` list with measured rows; sticks to the bottom until the user scrolls up ("Jump to latest"); top reach loads the previous page and keeps position |
| `components/rows.tsx` | Row components memoized on `key` + `v` (seq of the newest event that changed the row) + the shared context |
| `components/Streaming.tsx` | "Writing…" from `partial` deltas: listens to `agents.batch` itself (partials are not stored), flushes once per frame, re-renders only itself |
| `components/Markdown.tsx` | `marked` → DOMPurify (no style/iframe/img/forms) → cached HTML; links open via `shell.openExternal` (https only) |
| `components/AgentList.tsx` | Mini wall: needs permission first, then other needs-you, review, running; current agent shows its lead + subagent tree |
| `components/SessionHeader.tsx` | Lead header (project, worktree, mode button, model, running time, context ring → compact, Raw terminal, Pause/Resume, Stop) and subagent header (breadcrumb, model/effort/route/status/tokens, own context ring, Stop subagent) |
| `components/PermissionPrompt.tsx` | Pinned prompt; Y / Always in &lt;project&gt; / D answer the exact `requestId` once (`answerPermission`) |
| `components/Composer.tsx` | Enter or Ctrl/Cmd+Enter sends, Shift+Enter newline, Shift+Tab switches mode (as in the CLI); `/` menu of the CLI's slash commands; Attach artifact picker (`artifacts.list`); disabled while queued |
| `components/CompactDialog.tsx` | "Compact this session?" → `agents.compact`; modal keymap scope |
| `components/Inspector.tsx` | Tabs Plan (todos, plan text, changed files, artifacts in use, as drawn), Subagents (counts, routing, timeline, cards with Open/Stop, token share), Changes (`git.diff` → Review), Artifacts (`artifacts.list` + `artifacts.uses` filtered to this agent, plus its `mcp__oide__artifacts_*` calls), Terminal; Agent tools footer (`extensions.installed`) |
| `components/TerminalPanel.tsx` | xterm.js + fit addon on `terminal.create({ cwd: worktreePath })`; lazy-loaded on first open, kept mounted while switching tabs, killed and disposed on unmount |
| `components/frame/PlanUsage.tsx` (frame) | Status-bar plan meter, see [desktop-shell](desktop-shell.md) |

## Transcript mapping

| Event | Row |
| --- | --- |
| `user-text` | Right bubble; `[Request interrupted…]` and `<local-command-stdout>` become notices; `<command-name>` lines hidden |
| `assistant-text` | Markdown |
| `thinking` | Collapsed "Thinking" (adjacent blocks merged); empty text (Haiku) shows "Thinking…" |
| `tool-use` / `tool-result` | Consecutive calls share one card; results attach by id; adjacent Reads merge into "Read N files"; Edit/MultiEdit/Write show an inline diff (12 lines, Write 6, then "Show all"); a line expands to its output |
| `tool-use` Agent/Task | Subagent card (name, model · effort chip, route, status/time, Open; collapsed latest step or expanded steps + tokens/files); its `tool-result` is the report, absorbed into the card |
| `result` | "Turn finished · N turns · 2m 13s"; errors and `/compact` results as notices |
| `error`, `rate-limit`, `review-submitted` | Callouts / review card (Review changes) |
| `compact`, `mode-changed`, non-zero `exit` | Notices |
| `init`, `usage`, `status`, `todos`, `subagent*`, `permission-*`, `plan-usage`, `stderr`, `unknown` | Hidden (they feed the header, inspector and prompt) |

Subagent view = events whose `parentToolUseId` is the subagent's Task id, between an intro (info banner,
"Task from the lead agent") and the closing note or its report. Messages typed there go to the lead,
prefixed `About the subagent "<name>":`.

## Decisions and deviations

- Inspector basis 320px (canvas 300); below 340px (1100–1280px windows) the tabs tighten their padding
  (container query) so all five fit at the 300px minimum.
- At the 1100×700 minimum (session column < 700px, a container query on `<main>`): the header stays
  one row (title and meta truncate, the model family and the word "worktree" drop, Raw terminal /
  Pause / "Context" show only their icon with the words kept as accessible names); subagent cards
  stay one row ("Subagent" and "routed as" drop, the name truncates); the permission prompt puts its
  text above one row of buttons.
- Agent list titles wrap to two lines (canvas: "Getting-started rewrite"); the list scrolls and the
  J / K / N hints stay pinned at the bottom.
- A subagent id the agent does not have falls back to the lead view (the route is replaced).
- The lead header adds the model family ("Opus"), which the brief asks for and the canvas omits.
- The routing line is derived from the tiers seen ("Opus leads and routes each task. Simple goes to Haiku,
  standard to Sonnet."); the canvas's "Balanced focus" preset name is not in `AgentSummary`.
- Stop subagent explains that it takes effect at its next tool call (open question 9) in a tooltip and a toast.
- Slash commands: the CLI's `slash_commands` from init (protocol `init.slashCommands`, added); until
  reported, the 2.1.325 list `compact, context, init`. Only known commands are sent as `command`
  messages; `/compact` always goes through the confirm.
- Tool errors show a red dot (the canvas draws only done / running / needs-you).

## Protocol additions

- `init` event: optional `slashCommands: string[]`. **agent-core's parser must fill it from
  `system/init.slash_commands`** (not done here).

## Mock data (`lib/mock/focus.ts`)

`a-bridge` reproduces the canvas (lead, three subagents with tagged events, todos, pending prompt with
`toolUseId`, plan usage 38% weekly); `a-shell` has ~5,000 generated events for virtualization and
paging, and streams a demo reply every 20 s; `a-invoice` and `a-webhook` cover question and review.
A pretend shell answers `terminal.*`.

## Tests

`model/transcript.test.ts` (row mapping, Read merge, subagent cards and filtering, steps, diff,
5k events < 200 ms), `model/focus.test.ts` (composer shapes, mode cycle, list order, token share,
timeline, history merge), `Focus.test.tsx` (jsdom: permission answers use the exact id, Y/D once,
composer sends text / command / artifact, /compact asks, queued disables, Shift+Tab → `agents.setMode`,
subagent view and Stop subagent, compact confirm, J and Esc). Virtualized rows do not render in jsdom;
the Playwright check covers them.

## Known gaps

- Scroll-position keeping on prepend is approximate while new rows are still being measured.
- "Always in &lt;project&gt;" does not show the rule it will save except in a tooltip.
- Agent tools lists enabled extensions only; MCP servers from Add custom are not shown.
