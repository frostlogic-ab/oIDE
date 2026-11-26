# Wall

The main screen: one tile per agent across every open project.

## Layout

- **Projects sidebar.** "All projects" and each open project with its agent count, then one row per
  agent with a status dot (click to select its tile). The + opens the **New project** dialog (open a folder, clone a repository, or create a new one). Clicking a project sets
  the shared scope.
- **Header row.** Filter chips **All / Needs you / Running / Review** with counts, **Next that needs
  you**, and **Spawn agent**.
- **Tiles.** A responsive grid of agent tiles.
- **Artifacts aside** (wide windows only). The three newest artifacts in scope and which agents use
  them.

## A tile

The header shows `project · branch`, the status (for example "Running · 14m", "Needs permission",
"Has a question", "Ready for review", "Paused by plan limit", "Queued", "Error") and the **context
ring**. The title carries a mode badge when the agent's mode differs from your default mode; Bypass
always shows as a red warning badge.

The body depends on the state:

| State | Body | Actions |
| --- | --- | --- |
| Working | The last few activity lines ("Read src/x.ts", "Run npm test", subagent lines, `+n -n`) | Open; Resume when paused or stopped |
| Needs permission | Who asks (the lead or a named subagent) and exactly what: the command, path or URL | **Allow once**, **Always in &lt;project&gt;**, **Deny**, Open |
| Has a question | The agent's last message | Inline reply box |
| Ready for review | The agent's summary and diff stat | **Review diff**, **Open PR** (when `gh` is set up) |
| Queued | "Waiting for a free slot" | Open |
| Rate limited | The reset time; oIDE does not retry on its own | Resume (manual) |
| Error | The exit code and the last error line | Resume (restarts the session with `--resume`) |

**Subagent chips** show one chip per subagent: the dot is its status, the letter its model (H, S, O,
F). The summary reads like "2 of 3 running" or "1 needs you". Click a chip to open that subagent in
Focus.

**Context ring.** How full the agent's context window is. It turns amber at the warning level and
red with "/compact suggested" at the compact level (both in Settings > Agents). Clicking it asks
"Compact this session?"; oIDE never compacts without your confirmation.

## Keys

| Key | Action |
| --- | --- |
| J / K | Focus the next / previous tile |
| N | Focus the next tile that needs you (widens the filter if needed) |
| Y / D | Allow once / deny the focused tile's prompt |
| Enter | Open the focused tile in Focus |
| Esc | Clear the selection |

Details: [screen-wall](https://github.com/frostlogic-ab/oIDE/blob/main/docs/wiki/pages/screen-wall.md) in the wiki.
