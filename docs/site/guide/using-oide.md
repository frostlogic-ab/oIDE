# Using oIDE

oIDE is one window with a left rail of screens, a 44px header and a status bar. The core loop:

1. **Spawn** an agent (or several attempts) with a goal.
2. Agents work in their own git worktrees. The **Wall** shows every agent and surfaces what needs
   you: permission prompts, questions, finished work.
3. **Review** an agent's diff, send inline feedback back to it, then open a pull request or merge
   locally from **Source control**.
4. The worktree is cleaned up after the merge (right away, after 7 days, or never: your choice).

## Screens

| Screen | What it is for |
| --- | --- |
| [Wall](/guide/screens/wall) | Every agent across every open project, one tile each |
| [Focus](/guide/screens/focus) | One agent in depth: transcript, subagents, composer, inspector |
| [Spawn](/guide/screens/spawn) | Start agents: goal, context, project, worktree, mode, models, techniques, tools |
| [Source control](/guide/screens/source-control) | Projects, agent worktrees, overlaps, sync, commits |
| [Review](/guide/screens/review) | An agent's diff with inline comments, PR and local merge |
| [Files](/guide/screens/files) | Browse main or any agent's worktree, edit with Monaco, see who is changing what |
| [Artifacts](/guide/screens/artifacts) | Local designs, docs and whiteboards that you and agents read and write |
| [Marketplace](/guide/screens/marketplace) | Extensions and custom MCP tools |
| [Settings](/guide/screens/settings) | Claude Code, models, agents, techniques, permissions, projects, updates and more |

## Project scope

The Projects sidebar on the Wall, and the scope switcher in the header of Source control, Files and
Artifacts, share one scope: **All projects** or a single project. Picking a project in one screen
scopes the others too.

## Keyboard

| Key | Action |
| --- | --- |
| Ctrl/Cmd+K | Command bar (screens, agents, extension commands) |
| J / K | Next / previous agent |
| N | Next agent that needs you |
| Y / D | Allow once / deny the focused agent's permission prompt |
| Enter | Open the focused tile in Focus |
| Shift+Tab | Switch the agent's permission mode (as in the CLI) |
| Ctrl/Cmd+Enter | Send a message, or spawn from the Spawn dialog |
| Esc | Back or close |
| Alt+Left / Alt+Right | Go back / forward |

The full list is in **Settings > Keyboard shortcuts**.

## Notifications

oIDE shows a desktop notification when an agent needs permission, is ready for review, or hits an
error (each can be turned off in **Settings > Agents**). Clicking it brings the window forward.

## Plan limits

Agents beyond **Settings > Agents > Max running** (default 3) wait in a queue. When the CLI reports
a rate limit, the tile shows "Paused by plan limit" with the reset time; oIDE never retries on its
own. Resume it yourself when the limit resets.
