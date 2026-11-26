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
| `model/focus.ts` | Agent list order and lines, `modeChoices` (the header mode menu: every mode in cycle order, Bypass disabled with its reason unless Settings allow it and the agent is in a worktree), `nextMode` (Shift+Tab cycle over the enabled ones), `composeMessage` (composer → `UserMessage`), permission copy, subagent status text, token share, timeline geometry, routing line |
| `model/history.ts` | `useFocusHistory`: the transcript's own log for the agent on screen = `agents.events` pages (500, older pages on scroll-up via `beforeSeq`) merged with the store's live tail. Separate from the store because the store's tail is capped at 2000 and would drop scrolled-back history |
| `model/ui.ts` | Expanded/collapsed state (subagent cards, tool output, thinking, long diffs) outside the rows, so it survives virtualization |
| `components/Transcript.tsx` | `@tanstack/react-virtual` list with measured rows; sticks to the bottom until the user scrolls up ("Jump to latest"); top reach loads the previous page and keeps position |
| `components/rows.tsx` | Row components memoized on `key` + `v` (seq of the newest event that changed the row) + the shared context |
| `components/Streaming.tsx` | "Writing…" from `partial` deltas: listens to `agents.batch` itself (partials are not stored), flushes once per frame, re-renders only itself |
| `components/Markdown.tsx` | `marked` → DOMPurify (no style/iframe/img/forms) → cached HTML; links open via `shell.openExternal` (https only) |
| `components/AgentList.tsx` | Mini wall: needs permission first, then other needs-you, review, running; current agent shows its lead + subagent tree |
| `components/SessionHeader.tsx` | Lead header (project, worktree, mode menu (any mode at any time, e.g. Plan → Manual → Auto or Bypass; portalled `Menu` so the clipping meta line does not cut it; a streaming transcript does not close it; Bypass disabled for project-folder agents via `AgentSummary.workIn`), model, running time, context ring → compact, Raw terminal, Pause/Resume, Stop) and subagent header (breadcrumb, model/effort/route/status/tokens, own context ring, Stop subagent) |
| `components/PermissionPrompt.tsx` | Pinned prompt; Y / Always in &lt;project&gt; / D answer the exact `requestId` once (`answerPermission`) |
| `components/Composer.tsx` | Enter or Ctrl/Cmd+Enter sends, Shift+Enter newline, Shift+Tab switches mode (as in the CLI); `/` menu (shared `components/SlashMenu.tsx`); pasted screenshots, dropped files and Attach file (paperclip) as removable chips (shared `components/Attachments.tsx`); Attach artifact picker (`artifacts.list`); disabled while queued |
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
- Slash commands: the CLI's `slash_commands` from init (protocol `init.slashCommands`, filled by agent-core's
  parser: strings only, leading `/` dropped, de-duplicated); until reported, the 2.1.325 list `compact, context, init`. Only known commands are sent as `command`
  messages; `/compact` always goes through the confirm. See [Slash menu](#slash-menu).
- Tool errors show a red dot (the canvas draws only done / running / needs-you).

## Slash menu

`components/SlashMenu.tsx` (`useSlashMenu` + `SlashMenu`) over `lib/slash.ts`. A CLI with claude.ai connectors
reports ~100 commands, most of them MCP prompts (`mcp__claude_ai_HubSpot__check-database-status`); the old
menu wrapped them into each other. Now:

- One 28px row per command, never wrapping: the label in JetBrains Mono 12px, truncated, the full `/command`
  (and description) in the row's `title`; the description (built-ins only; the CLI gives none for the rest)
  right-aligned in Inter 12px ink-3, truncated.
- Groups: **Claude Code** (built-ins, CLI order), **Skills and custom commands**, `<plugin> (plugin)` for
  `plugin:command`, then one group per MCP server: `mcp__<server>__<prompt>` → "<Server> (MCP)" (a
  `claude_ai_` prefix dropped, underscores shown as spaces) with the prompt name as the label. Groups A–Z.
- Filter as you type after `/`: prefix of the command or label first, then a word of the label or the
  server/plugin name (`/hub` lists HubSpot's prompts), then substrings; fuzzy letters-in-order only when
  nothing matches better. Groups stay together, the group with the best match first. The header shows
  "96 commands" or "12 of 96" (polite live region).
- Card popup (border line-3, radius 10, shadow-dialog), list capped at 264px (popup about 320px) and scrolls;
  footer hint row. Up/Down (wrap), PageUp/PageDown (8 rows), Home/End, Enter/Tab insert `/<command> ` (not
  sent), Esc closes until the text changes; hover moves the highlight, click picks. The active row (and its
  group header when it is the group's first row) is scrolled into view. `/compact` picked from the menu
  opens the compact confirm instead.
- ARIA: the textarea is a `combobox` (`aria-expanded`, `aria-controls`, `aria-activedescendant`); the list
  is a `listbox` of `group`s labelled by their headers; rows are `option`s.
- The Wall's reply box has no `/` commands, so it does not use the menu.

## Attachments

Focus composer, Wall question reply and Spawn's goal share `components/Attachments.tsx` (`useAttachments`,
`AttachmentTray`, `AttachFileButton`, `MessageAttachments`) and `lib/attachments.ts`.

- **Paste** (Ctrl/Cmd+V of a screenshot): PNG/JPEG/GIF/WebP images are read in the renderer as base64
  (named "Pasted image N.png"); they never touch disk except as the message payload. **Drop** files on the
  input: images the same way, other files through preload's `attachDropped` (below). **Attach file**
  (paperclip): `dialog.pickFiles`, the native multi-file picker.
- Chips: thumbnail (images) or file icon, name (truncated; full name and path in the tooltip), size, remove
  button. Limits, checked here and again in main: images at most 5 MB each and 20 MB together, files at most
  25 MB, at most 10 per message; a refusal shows under the input (`role="alert"`).
- Sending: `UserMessage` `text` (and `artifact`) carry `attachments`; a send with only attachments says
  "See the attached image.". A message with attachments is never a slash command. Spawn sends them as
  `AgentSpec.attachments`.
- Main (`services/attachments.ts`): `validateAttachments` on every `agents.send` / `agents.spawn` (image bytes
  sniffed and matched to the declared type; file paths must be picked or dropped this session, or inside the
  agent's worktree; sizes from `stat`, never from the renderer). Files are copied to
  `<agent folder>/.oide/attachments/<UTC timestamp>-<safe name>` and `/.oide/attachments/` is added to the
  repo's `info/exclude` (`git rev-parse --git-path info/exclude`: the common one for linked worktrees; never
  `.gitignore`). Project-folder agents use the same folder in the project. The message text names each copy
  by its relative path; images go as stream-json image blocks (see [cli-integration](cli-integration.md)).
- Drops: preload's `window.oide.attachDropped(files)` takes only real `File` objects, reads their paths with
  `webUtils.getPathForFile` (empty for a File the page built) and sends them on the preload-only
  `IPC_DROP_CHANNEL`; main checks the sender frame, registers the paths as picked and answers with
  `PickedAttachments`. Page code cannot send a path there itself.
- Transcript: the `user-text` event stores the attachments (images inline), so a user bubble shows image
  thumbnails (click: a portaled dialog with the full image) and file chips.

## Protocol additions

- `init` event: optional `slashCommands: string[]`, filled from `system/init.slash_commands` (`parser.ts`).
- `MessageAttachment` (`image` {mediaType, dataBase64, name?} | `file` {path, name, size}) and `ATTACHMENT_LIMITS`;
  optional `attachments` on `UserMessage` `text` / `artifact`, on `AgentSpec` and on the `user-text` event;
  `dialog.pickFiles` returns `PickedAttachments`; `IPC_DROP_CHANNEL` and `OideBridge.attachDropped`.
- `AgentSummary.interruptedPermission { toolName, summary?, at }`: the prompt that was open when oIDE quit
  (the broker denies it with `permission-resolved.reason: 'quit'`). Focus shows "oIDE closed while waiting for
  your answer; send a message to continue." above the composer until the user sends a message (the reducer
  clears it on the lead's next `user-text`). `Resumed.test.tsx` covers the note and the `/` menu.

## Mock data (`lib/mock/focus.ts`)

`a-bridge` reports `MOCK_SLASH_COMMANDS` (96 commands, mostly MCP prompts) for the `/` menu; `agents.send`
echoes text messages (with attachments) into the transcript; `dialog.pickFiles` returns a pretend PDF.
`a-bridge` reproduces the canvas (lead, three subagents with tagged events, todos, pending prompt with
`toolUseId`, plan usage 38% weekly); `a-shell` has ~5,000 generated events for virtualization and
paging, and streams a demo reply every 20 s; `a-invoice` and `a-webhook` cover question and review.
A pretend shell answers `terminal.*`.

## Header and composer details
- **Pause and Resume.** Pause shows only while the agent is running, starting, waiting on a permission
  or queued (queued is disabled). When a paused, stopped, error or rate-limited session cannot resume
  (`resumeBlocked`, e.g. its worktree is gone), the header shows a focusable `aria-disabled` Resume whose
  tooltip gives the reason, instead of an enabled Pause that does nothing.
- **Permission prompt keys.** The Allow and Deny hints come from `useShortcutLabel('permission.allow' |
  'permission.deny')`, so they follow a rebinding in Settings > Keys, the same as the Wall tile.
- **Attach artifact popover.** It takes focus when it opens (the first item, or the popover itself while
  loading, empty or failed), so Esc closes it instead of running `view.back`. Esc returns focus to the
  trigger, picking an artifact returns it to the message box, and the trigger button toggles it closed.

## Tests

`model/transcript.test.ts` (row mapping, Read merge, subagent cards and filtering, steps, diff,
5k events < 200 ms), `model/focus.test.ts` (composer shapes, mode cycle, list order, token share,
timeline, history merge), `Focus.test.tsx` (jsdom: permission answers use the exact id, Y/D once,
composer sends text / command / artifact, /compact asks, queued disables, Shift+Tab and the header mode menu → `agents.setMode`,
subagent view and Stop subagent, compact confirm, J and Esc). Virtualized rows do not render in jsdom;
the Playwright check covers them.

Slash menu and attachments: `lib/slash.test.ts` (grouping, labels, scoring, filter order),
`components/SlashMenu.test.tsx` (~100 commands, rows, ARIA, filter and count, arrows/Page/Home/End with scroll
into view, Enter/Tab insert, Esc, hover and click), `Focus.test.tsx` (pasted screenshot sent as an image
attachment, 5 MB refusal, Attach file), `main/services/attachments.test.ts` (picked or worktree paths only, image
sniffing and limits, copies and `info/exclude`), agent-core `messages.test.ts` (content blocks) and
`supervisor.test.ts` (images through fake-claude, Spawn files materialized, stored spec without attachments),
`e2e/attachments.spec.ts` (paste in the real app: fake-claude's stdin has the image block; thumbnail and dialog
in the transcript).

## Known gaps

- Spawn attachments of a queued agent live in memory until it starts; if oIDE quits first, the goal goes
  without them.
- Multi-image recognition was not confirmed on Haiku with the real CLI (see [cli-integration](cli-integration.md)).

- Scroll-position keeping on prepend is approximate while new rows are still being measured.
- "Always in &lt;project&gt;" does not show the rule it will save except in a tooltip.
- Agent tools lists enabled extensions only; MCP servers from Add custom are not shown.
