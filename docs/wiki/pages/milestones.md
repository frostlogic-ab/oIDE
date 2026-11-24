# Milestones

From the build brief. Each milestone ends with a gate that is a real user flow. Status is updated as
work lands (see [../log.md](../log.md)).

| # | Milestone | Scope | Gate | Status |
| --- | --- | --- | --- | --- |
| M0 | Foundations | pnpm monorepo, hardened Electron shell, typed IPC, SQLite store + migrations, fake-claude, CI on 3 OSes, unsigned installers | A blank oIDE window installs and opens on all three OSes from a CI build | in progress |
| M1 | One agent, end to end | AgentDriver over stream-json, parser, oIDE MCP server with permission prompt; Focus transcript and composer; worktree per agent; Stop; Resume after restart; CLI detection and sign-in | With a real CLI: spawn, approve a prompt in oIDE, stop, restart oIDE, resume | in progress |
| M2 | Mission Control | Wall tiles, subagent chips, shared scope, queue + max running, J/K/N, Ctrl K, notifications; full Spawn with routed subagents; Focus subagent tree, cards, timeline; context ring and /compact | Six agents across three projects run for a working day without a restart | planned |
| M3 | Source control, Review and Files | Source control cards, overlaps, Review with inline feedback, local merge, PRs via gh; Files with scope, worktree menus, Monaco, agent-editing banner; worktree cleanup | A change goes from Spawn to a merged branch without leaving oIDE | planned |
| M4 | Settings, models and trust | All Settings sections, Your models + Test connection, version pinning, permission rules in `.oide/`; workspace trust, Bypass guard rails, usage view | A project's `.oide/` folder reproduces the same agent setup on another machine | planned |
| M5 | Extensions and marketplace | Extension host, `@oide/extension-api`, manifest schema, MCP tools with risk labels, sandboxed panels; index and install; Add custom | A third-party extension installed from the index gives an agent a tool it uses | planned |
| M6 | Artifacts | Local artifact store, viewers, history; `artifacts.*` MCP tools, Give to an agent, Agents using it, manual import | An agent reads a design artifact and writes a doc artifact the user then edits | planned |
| M7 | Public 1.0 | Signing + notarization, auto-update channels, docs site, extension author guide; Anthropic's answer, licence and name check, nightly real-CLI smoke | Signed 1.0 installers on GitHub Releases | planned (needs accounts and Anthropic's answer) |

Build order for this repo: wave 1 builds the packages behind M0, M1, M4, M5 and M6 in parallel
(shell, agent runtime, git + storage, extensions); wave 2 wires services into the main process and
builds every screen; wave 3 is adversarial review (security, brief conformance, design conformance)
and end-to-end tests against fake-claude.
