# ADR 0022: Kanban boards are an artifact kind changed through shared operations

- Status: accepted
- Date: 2026-11-28
- Departs from: build brief, whose artifacts are designs, docs and whiteboards only; and ADR 0004, which keeps every version (boards keep the newest 200)

## Context
People run product backlogs as Notion-style kanban boards: customisable columns, cards with typed
properties (priority, effort, type…), a Markdown spec per card, comments. They want the same board
in oIDE, worked by them and by their agents: drag cards, start an agent on a card, and let agents
add, edit, move and close tickets with tools that can do everything a person can.

Two people (or a person and an agent) changing one file at once is the hard part. Artifacts are
saved as whole files with `baseVersion` conflicts, which suits a document someone edits for a while,
not a board where a drag is one small change and an agent may move another card a second later.

## Decision
- **A board is an artifact of kind `board`**: one JSON file, `board.json` (`KanbanBoard` in
  `@oide/protocol`: columns, properties with options, cards with values, a Markdown body, comments
  and the agents started on them). It gets everything artifacts have: personal or in the repo,
  history and restore, the Agent panel, SEC-26 visibility.
- **Every change is a list of operations** (`BoardOp`: add / update / move / delete card, comments,
  columns, properties, options). `applyBoardOps` is one pure function in the protocol. Main applies a
  batch in `ArtifactStore.updateBoard` under the artifact's lock (read, apply, write): all or nothing,
  one version, a readable note ("Moved "Fix login" to In review"). The UI (`artifacts.boardApply`)
  and agents (MCP `board_update`) send the same operations, so neither overwrites the other and no
  conflict banner is needed. The UI applies a batch locally first and takes main's answer.
- **Operations name things the way people do**: columns and properties by name or id, select values
  by option name (a new name adds the option). Agents read the board with names (`board_read`).
- **Agents change boards only through `board_update`.** A raw `artifacts_write` of a board is refused,
  so an agent can't sign a comment as the user or link agents to cards. A board an agent creates is
  re-attributed to it (cards and comments become its own, no agent links); a claude.ai retrieval
  never makes a board. Only the user links agents to a card ("Start an agent" in the card panel opens
  Spawn with the ticket as the goal; the new agents are linked to the card).
- **Boards keep the newest 200 versions.** A drag is a version, so a busy board would otherwise grow
  without end; older snapshots are deleted after each board commit. Other kinds keep every version.
- `board_read` is allowed without a prompt; `board_update` asks like `artifacts_write` does, except
  for the board's own artifact agent in the modes that edit without asking.

## Consequences
- Every change shows up at once for everyone looking at the board (`artifacts.changed`), and History
  restores any of the last 200 versions.
- Text a person is typing in the card panel (title, description) stays theirs until they save; a
  newer save by an agent of the same field is overwritten by theirs (it stays in History).
- A board shared through the repo merges like any JSON file; two branches changing it conflict in git.
- Telemetry: `board_changed` (who, what kind of change, how many), never content.
