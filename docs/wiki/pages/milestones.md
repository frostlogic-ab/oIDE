# Milestones

From the build brief. Each milestone ends with a gate that is a real user flow. Status is updated as
work lands (see [../log.md](../log.md)).

| # | Milestone | Scope | Gate | Status |
| --- | --- | --- | --- | --- |
| M0 | Foundations | pnpm monorepo, hardened Electron shell, typed IPC, SQLite store + migrations, fake-claude, CI on 3 OSes, unsigned installers | A blank oIDE window installs and opens on all three OSes from a CI build | built (2026-11-24 review): build, typecheck, lint, 402 vitest, 9 e2e pass; Windows `--dir` package launches. Installers on 3 OSes from CI not verified ([review-conformance](review-conformance.md)) |
| M1 | One agent, end to end | AgentDriver over stream-json, parser, oIDE MCP server with permission prompt; Focus transcript and composer; worktree per agent; Stop; Resume after restart; CLI detection and sign-in | With a real CLI: spawn, approve a prompt in oIDE, stop, restart oIDE, resume | **gate passed** on the services layer with real CLI 2.1.325 (`test/conformance/real-cli.test.ts`, haiku); not yet clicked through in the Electron UI with the real CLI |
| M2 | Mission Control | Wall tiles, subagent chips, shared scope, queue + max running, J/K/N, Ctrl K, notifications; full Spawn with routed subagents; Focus subagent tree, cards, timeline; context ring and /compact | Six agents across three projects run for a working day without a restart | built; verified with fake-claude in the real app (6 agents, 2 projects, queue, routed subagents). Day-long gate not run. Gaps: queued summaries, stale status bar |
| M3 | Source control, Review and Files | Source control cards, overlaps, Review with inline feedback, local merge, PRs via gh; Files with scope, worktree menus, Monaco, agent-editing banner; worktree cleanup | A change goes from Spawn to a merged branch without leaving oIDE | built, **gate fails**: Merge locally ignores uncommitted worktree changes and reports success (blocker B1) |
| M4 | Settings, models and trust | All Settings sections, Your models + Test connection, version pinning, permission rules in `.oide/`; workspace trust, Bypass guard rails, usage view | A project's `.oide/` folder reproduces the same agent setup on another machine | built (all sections render real values); gate not exercised |
| M5 | Extensions and marketplace | Extension host, `@oide/extension-api`, manifest schema, MCP tools with risk labels, sandboxed panels; index and install; Add custom | A third-party extension installed from the index gives an agent a tool it uses | partly built: host, install, MCP tools, Add custom; panels/themes/techniques/languages/deployTargets/artifactTypes not wired; gate not demonstrated |
| M6 | Artifacts | Local artifact store, viewers, history; `artifacts.*` MCP tools, Give to an agent, Agents using it, manual import | An agent reads a design artifact and writes a doc artifact the user then edits | built (store, viewers, history, MCP tools, import); whiteboard read-only; gate not demonstrated end to end |
| M7 | Public 1.0 | Signing + notarization, auto-update channels, docs site, extension author guide; Anthropic's answer, licence and name check, nightly real-CLI smoke | Signed 1.0 installers on GitHub Releases | planned (needs accounts and Anthropic's answer) |

Build order for this repo: wave 1 builds the packages behind M0, M1, M4, M5 and M6 in parallel
(shell, agent runtime, git + storage, extensions); wave 2 wires services into the main process and
builds every screen; wave 3 is adversarial review (security, brief conformance, design conformance)
and end-to-end tests against fake-claude.
