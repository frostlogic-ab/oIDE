# Focus

One agent in depth. Open it from a tile (Enter, or **Open**), from a subagent chip, or from the
command bar.

```
[ Agents ] [ header · transcript · permission prompt · composer ] [ Inspector ]
```

## Agent list

A mini Wall on the left: agents that need permission first, then other agents that need you, then
those ready for review, then running ones. The current agent shows its lead and subagent tree.

## Header

Project, worktree, permission mode (click to change), model, running time, context ring (click to
compact), **Raw terminal**, **Pause / Resume** and **Stop**. On a subagent: a breadcrumb back to the
lead, its model, effort, route, status, tokens, its own context ring, and **Stop subagent**.

## Transcript

- Your messages on the right; the agent's replies rendered as Markdown (sanitized; links open in your
  browser).
- Tool calls grouped into cards. Consecutive reads merge into "Read N files". Edits and writes show an
  inline diff. Click a line to see the tool's output.
- Thinking blocks are collapsed.
- A subagent call becomes a card with its name, model and effort, status, latest step and **Open**.
- Turn results ("Turn finished · 4 turns · 2m 13s"), errors, rate limits, mode changes and compaction
  appear as notices.

Long sessions are virtualized and older history loads as you scroll up; "Jump to latest" returns to
the live end.

## Permission prompt

Pinned above the composer while the agent waits: **Y** allow once, **Always in &lt;project&gt;**, **D**
deny. The answer goes to that exact request and only once.

## Composer

Enter (or Ctrl/Cmd+Enter) sends, Shift+Enter adds a line, Shift+Tab switches the permission mode.
Type `/` for the CLI's slash commands (from the CLI itself; `/compact` always asks first). **Attach
artifact** adds a local artifact to the message. Messages typed while viewing a subagent go to the
lead, prefixed with the subagent's name. The composer is disabled while the agent is queued.

## Inspector

| Tab | Shows |
| --- | --- |
| Plan | The agent's todo list, plan text, changed files and artifacts in use |
| Subagents | Counts, the routing line ("Opus leads and routes each task…"), a timeline, a card per subagent with Open / Stop, and the share of tokens subagents used |
| Changes | The diff, with a link to Review |
| Artifacts | Artifacts this agent read or wrote |
| Terminal | A terminal in the agent's worktree |

Extensions that are on for the agent's project can add their own panels as extra tabs (for example
Browser preview). The footer lists the extension tools the agent has.

**Stop subagent** takes effect at the subagent's next tool call that needs a permission: the CLI has
no message to stop one subagent, so oIDE denies its next prompt with a stop message.

Details: [screen-focus](https://github.com/frostlogic-ab/oIDE/blob/main/docs/wiki/pages/screen-focus.md).
