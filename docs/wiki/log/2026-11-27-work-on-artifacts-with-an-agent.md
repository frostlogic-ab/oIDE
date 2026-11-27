## [2026-11-27] build | Work on artifacts with an agent
The Artifacts open view now puts an **Agent panel** where the editor was, and merges Edit and Preview
into one pane with a **Preview | Code | Compare** switch. The artifact agent ([ADR 0017](../../adr/0017-artifact-agents.md))
is an ordinary oIDE agent bound to one artifact (`artifacts.startAgent`, `AgentSpec.artifactId`,
`workIn: 'artifact-folder'`): it works in an empty folder under app data, has its own contract (no git,
commits or review), and reads and changes only its artifact over MCP (`artifacts_write` gains `edits`,
exact search and replace). Its writes need no prompt in Edit automatically / Auto / Bypass. The panel
shows the transcript, permission prompt and composer from Focus, the context ring with Compact, Model
and Effort (`agents.setModel`, from the next message, for any agent) and Mode. **Point and comment**:
every HTML page main serves loads `/__oide/picker.js`; with Comment on, a click in the preview (or on a
block of a rendered doc) opens "What should change here?", and the ticked comments go to the agent as
one message. Deleting an artifact archives its agent. Telemetry: `artifact_agent_started`,
`artifact_agent_message`, `agent_model_changed`. Pages: [screen-artifacts](../pages/screen-artifacts.md),
[artifacts](../pages/artifacts.md), [mcp-server](../pages/mcp-server.md), [agent-supervisor](../pages/agent-supervisor.md),
[protocol](../pages/protocol.md), [telemetry](../pages/telemetry.md).
