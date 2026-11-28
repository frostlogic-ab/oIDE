## [2026-11-28] build | Kanban board artifacts

New artifact kind `board`: Notion-style kanban boards that people and agents work together. A board
is one `board.json` (customisable columns, typed card properties with coloured options, a Markdown
description, comments and the agents started on each card). Every change, from a drag in the UI or
an agent, is a list of board operations applied by main under the artifact's lock (one version, all
or nothing), so neither side overwrites the other. Agents get `board_read` and `board_update` and can
do everything a person can except link agents to cards; raw writes of a board are refused and
agent-made boards are re-attributed to the agent. "Start an agent" on a card opens Spawn with the
ticket as the goal and links the new agents to the card. Boards keep their newest 200 versions.
Decision: [ADR 0022](../../adr/0022-kanban-boards.md). Telemetry: `board_changed`. Pages:
[kanban-boards](../pages/kanban-boards.md), [artifacts](../pages/artifacts.md),
[screen-artifacts](../pages/screen-artifacts.md), [mcp-server](../pages/mcp-server.md),
[telemetry](../pages/telemetry.md).
