# Overview

oIDE is a local desktop app (Electron + TypeScript + React) that runs many Claude Code agents in
parallel, across many projects, in one window: "Mission Control" for coding agents.

- Each agent is the user's own, unmodified `claude` CLI, spawned in its own git worktree and branch,
  driven through `--input-format stream-json --output-format stream-json`.
- The **Wall** shows one tile per agent: status, context ring, activity, diff counts, inline permission
  prompts and replies. **Focus** shows one agent's full transcript, subagent tree and inspector.
- **Spawn** turns a goal plus settings (mode, model strategy, techniques, extensions, parallel attempts)
  into an `AgentSpec`. **Source control** and **Review** take an agent's worktree to a PR or a local merge.
- **Files**, **Artifacts**, **Marketplace** and **Settings** round it out.

Core loop: Spawn → agents work in worktrees → oIDE surfaces what needs you (permissions, questions,
reviews) → Review → merge or PR → worktree cleanup.

See [architecture.md](architecture.md), [constraints.md](constraints.md), [milestones.md](milestones.md).
Source: [../raw/build-brief.md](../raw/build-brief.md).
