# Kanban boards

Notion-style kanban boards that people and agents work together: an artifact of kind `board`
([ADR 0022](../../adr/0022-kanban-boards.md)). Related: [artifacts.md](artifacts.md) (store, versions,
MCP), [screen-artifacts.md](screen-artifacts.md) (the screen), [mcp-server.md](mcp-server.md),
[telemetry.md](telemetry.md).

## Model (`packages/protocol/src/board.ts`)

One file, `board.json` (`KanbanBoard`, `type: "oide-board"`, `version: 1`), pretty-printed so a repo
board diffs well:

- `columns`: `{ id, name, color }` in display order (1 to 50; names unique, case-insensitive).
- `properties`: `{ id, name, type, options?, showOnCard }`. Types: `select`, `multi_select`, `text`,
  `number`, `date` (`YYYY-MM-DD`), `checkbox`, `url`. Options `{ id, name, color }` (up to 100).
- `cards` (up to 2000), in display order: `{ id, title, column, props, body, comments, agents,
  createdAt, updatedAt, createdBy }`. `props` maps property id → value (an option id, option ids, text,
  number, `true`); no value is no key. `body` is Markdown (50 000 characters). `comments`:
  `{ id, author ('user' | 'agent:<id>'), authorName?, ts, text }`. `agents`: agent ids started from
  the card (newest last).
- Colours: gray, brown, orange, yellow, green, blue, purple, pink, red (`BOARD_COLORS`); the renderer
  maps them to hues on the dark UI (`Board/boardModel.ts`).
- `checkBoard` / `parseBoard` check everything the schema can't: unique ids, cards in known columns,
  values that fit their property (select values are that property's option ids).
- A new board (`defaultBoard`) is a product backlog: Proposed, Approved, In progress, In review,
  Shipped, Won't do; Priority (P0–P3), Effort (S/M/L), Type (Build, Fix, Improve, Tech debt).

## Operations

`BoardOp` (Zod, at most 200 per batch), applied in order by `applyBoardOps(board, ops, ctx)`: all or
nothing (`BoardOpError` with a reason a person or agent can act on).

| Area | Operations |
| --- | --- |
| Cards | `add_card { title, column?, index?, props?, body? }`, `update_card { cardId, title?, body?, props? }`, `move_card { cardId, column, index? }`, `delete_card` |
| Comments | `add_comment { cardId, text }`, `delete_comment { cardId, commentId }` (agents: only their own) |
| Agents | `link_agent` / `unlink_agent { cardId, agentId }` (the user only; refused for agents) |
| Columns | `add_column { name, color?, index? }`, `update_column`, `move_column { column, index }`, `delete_column { column, moveCardsTo? }` (refused with cards and no target, or for the last column) |
| Properties | `add_property { name, type, options?, showOnCard?, index? }`, `update_property { property, name?, type?, showOnCard? }` (a new type converts values, below), `move_property`, `delete_property` (clears its values), `add_option`, `update_option`, `delete_option` (clears it on cards) |

Changing a property's type (`convertProperty`): select ↔ multi-select keep their options (multi →
select keeps the first); text, numbers and links become options of the new select (one per distinct
value); a select becomes text as its option names; numbers, dates and links keep values that still
fit; anything else is cleared. Ids are 1 to 64 letters, digits, `-` or `_`, never `__proto__`,
`constructor` or `prototype` (values live in plain objects keyed by id).

Columns and properties are named by name or id, cards by id. `props` values: a select option name or
id (a new name adds the option), a list for multi-select, `null` clears. `index` counts the other cards
of the column (0 = top; past the end = bottom). `describeBoardOps` writes the version note,
`boardForAgent` the agent's view (names, not ids), `boardOpsArea` the telemetry area.

## Store and main

- `ArtifactStore.updateBoard(id, ops, { author, authorName? })`: under the artifact's lock, parse the
  entry, apply, commit one version with the note; records an agent's write in the uses log. A refusal
  is `ArtifactError` `invalid_input` and writes nothing. `readBoard(id)` parses and checks.
- Writes of board content through `save` / `writeFiles` / `create` are checked with `parseBoard`.
- Boards keep the newest `BOARD_KEEP_VERSIONS` (200) snapshots: older `.versions/<n>` folders are
  deleted after each board commit, then their `versions.json` entries (`pruneVersions`; a folder that
  can't be deleted stays listed and is tried again next time). Restoring a version no longer kept
  says so ("boards keep their newest 200 versions").
- Importing files: a `board.json` makes a board only when its content is an oIDE board
  (`isBoardContent`); an Excalidraw scene under that name stays a whiteboard. The New artifact
  dialog leaves the kind of a `board.json` to main ("Detect").
- IPC `artifacts.boardApply { id, ops } → { meta, board, results }` (the user's changes, author `user`).
- MCP (`mcpArtifacts` in `services/core.ts`): `readBoard` / `updateBoard` keep SEC-26 visibility and the
  artifact agent's own-artifact rule; author `agent:<id>` with the agent's title on comments.
  `write` / `writeFiles` on a board are refused (use `board_update`), `link_agent` / `unlink_agent` are
  refused, a board an agent creates is re-attributed to it (cards and comments its own, no agent
  links, one file), and a claude.ai retrieval never commits a board (`commitFolder`).

## Agents

- Tools ([mcp-server.md](mcp-server.md)): `board_read { id, cardId?, column? }` (read-only, allowed
  without a prompt) and `board_update { id, ops }` (asks like `artifacts_write`; a board's own artifact
  agent writes it without a prompt in Edit automatically, Auto and Bypass).
- Every agent's contract mentions boards and the two tools; a board context chip is described with
  them (`describeArtifact`, kind from `resolveArtifact`). A board's artifact agent (Agent panel) gets
  `boardArtifactContract`: change it only with `board_update`, close a ticket by moving it to the done
  (or won't do) column, never rewrite the file.
- **Start an agent** (card panel) opens Spawn with the board's project, the board as a context chip
  and the goal `goalForCard`: the ticket (title, properties, description, the last five comments),
  then "read the card with board_read; move it to In progress when you start; comment and move it to
  In review when you submit" (the columns found by name, else generic wording). After the spawn, the
  new agents are linked to the card (`link_agent`; a failure is a warning toast).

## UI

[screen-artifacts.md](screen-artifacts.md) › Boards. Code: `apps/desktop/src/renderer/src/screens/Artifacts/Board/`.

Tests: `packages/protocol/src/board.test.ts`, `packages/store/test/artifacts-board.test.ts`,
`packages/mcp-server/src/server.test.ts` (board tools), `test/security/board-access.test.ts`,
`packages/agent-core/src/args.test.ts` and `supervisor.test.ts` (contracts, auto-allow),
`apps/desktop/src/renderer/src/screens/Artifacts/Board/*.test.ts(x)`.
