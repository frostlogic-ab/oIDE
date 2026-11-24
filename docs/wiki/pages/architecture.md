# Architecture

The main process owns every long-lived resource (agent processes, worktrees, the database, the
extension host). The renderer is a sandboxed UI that only sees typed events and sends typed commands,
so a UI crash or reload never kills an agent. Source: [../raw/build-brief.md](../raw/build-brief.md),
"Process model and repo layout".

```
Renderer (sandboxed, no Node)      React screens, Zustand stores fed by event streams
   │  typed IPC through preload (window.oide), every message Zod-checked
Main process (Node services)
   ├─ Agent supervisor ──stdin/stdout stream-json──▶ claude CLI × N (cwd = agent worktree)
   ├─ oIDE MCP server  ◀──MCP (HTTP, loopback, per-agent secret)── each CLI
   ├─ Worktree manager ──▶ git worktrees on disk, one per agent and branch
   ├─ Store (node:sqlite): sessions, events, usage, settings, review, artifacts index
   ├─ Usage and alerts: context ring, token usage, desktop notifications
   ├─ Terminals (node-pty): Raw terminal, sign-in terminal
   └─ Extension registry ──▶ Extension host (utility process); extension MCP servers started by each CLI
Anthropic is reached only through the CLI.
```

| Package | Role | Page |
| --- | --- | --- |
| `packages/protocol` | Zod contract: IPC, events, manifest, `.oide/` | [protocol.md](protocol.md) |
| `packages/agent-core` | Driver, parser, supervisor, subagents | [agent-supervisor.md](agent-supervisor.md), [subagents.md](subagents.md), [cli-integration.md](cli-integration.md) |
| `packages/mcp-server` | Permission prompt, submit_for_review, artifacts tools | [mcp-server.md](mcp-server.md) |
| `packages/git` | Worktrees, diffs, overlaps, merge, PRs | [git-worktrees.md](git-worktrees.md) |
| `packages/store` | SQLite, settings, `.oide/` files, secrets, artifacts | [storage.md](storage.md), [artifacts.md](artifacts.md) |
| `packages/extension-host`, `extension-api` | Extensions, marketplace, custom tools | [extensions.md](extensions.md), [marketplace.md](marketplace.md) |
| `packages/ui`, `apps/desktop` | UI kit, Electron shell, screens | [desktop-shell.md](desktop-shell.md), [design-system.md](design-system.md) |

Key flows:
- **Spawn**: renderer `agents.spawn(AgentSpec)` → supervisor queues under Max running → worktree manager
  creates `oide/<slug>` → optional `.oide/setup` (trusted projects only) → `claude -p … --session-id` →
  first stream-json user message (goal + techniques) → events reduced to `AgentSummary` → renderer.
- **Permission**: CLI calls `mcp__oide__permission_prompt` → MCP server holds the request → tile shows
  Y / Always / D → `agents.answerPermission` with the exact request id → MCP returns allow/deny.
- **Review**: agent calls `mcp__oide__submit_for_review(summary, checks)` → tile "Ready for review" →
  Review shows the worktree diff → inline comments bundled into one user message, or merge / PR.

See also [security.md](security.md) and [milestones.md](milestones.md).
