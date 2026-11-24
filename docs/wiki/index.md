# oIDE wiki: index

The product knowledge base for oIDE, maintained by the agents that build it (see the "wiki" section
of [CLAUDE.md](../../CLAUDE.md)). Sources live in [raw/](raw/); history lives in [log.md](log.md).

## Sources (raw, immutable)

- [raw/build-brief.md](raw/build-brief.md): the architecture and build brief (M0 to M7, stack, constraints).
- [raw/design/](raw/design/): the Mission Control design screens (Main, Focus, Spawn, SourceControl, Review, Artifacts, Marketplace, Files, Settings).
- [raw/claude-cli-help-2.1.325.txt](raw/claude-cli-help-2.1.325.txt): `claude --help` of the CLI version oIDE was first built against.

## Overview

- [pages/overview.md](pages/overview.md): what oIDE is, who it is for, the core loop.
- [pages/constraints.md](pages/constraints.md): the hard rules from Anthropic's terms and what they mean in code.
- [pages/architecture.md](pages/architecture.md): process model, packages and how they connect.
- [pages/milestones.md](pages/milestones.md): M0 to M7 with gates and current status.
- [pages/open-questions.md](pages/open-questions.md): open questions and risks, with defaults and findings.
- [pages/design-system.md](pages/design-system.md): colours, type, spacing, components from the canvas.

## Packages

- [pages/protocol.md](pages/protocol.md): the Zod contract (IPC, events, manifest, `.oide/`).
- [pages/agent-supervisor.md](pages/agent-supervisor.md): AgentDriver, stream-json, supervisor, queue.
- [pages/cli-integration.md](pages/cli-integration.md): verified CLI flags, event shapes and fallbacks.
- [pages/subagents.md](pages/subagents.md): SubagentTracker and what each subagent view is built from.
- [pages/mcp-server.md](pages/mcp-server.md): oIDE's MCP server (permission prompt, submit_for_review, artifacts).
- [pages/git-worktrees.md](pages/git-worktrees.md): worktree manager, diffs, overlaps, merge, cleanup.
- [pages/storage.md](pages/storage.md): node:sqlite schema, migrations, `.oide/` files, keychain.
- [pages/extensions.md](pages/extensions.md): manifest, extension host, API, risk labels.
- [pages/marketplace.md](pages/marketplace.md): the static index, install flow, Add custom.
- [pages/artifacts.md](pages/artifacts.md): local artifacts, kinds, versions, MCP tools.
- [pages/desktop-shell.md](pages/desktop-shell.md): Electron main, preload bridge, renderer shell, keymap.
- [pages/security.md](pages/security.md): hardening, trust, bypass guard rails, credential test.
- [pages/testing.md](pages/testing.md): Vitest, fake-claude fixtures, Playwright e2e.
- [pages/packaging.md](pages/packaging.md): electron-builder, CI matrix, updates, signing.

## Screens

- [pages/screen-wall.md](pages/screen-wall.md): Mission Control wall (Main): tiles per status, inline permission / reply / review, subagent chips, compact confirm, J/K/N/Y/D keys.
- [pages/screen-focus.md](pages/screen-focus.md): Focus: virtualized paged transcript, subagent views by parentToolUseId, pinned permission prompt, composer with / commands and artifacts, inspector (Plan, Subagents, Changes, Artifacts, Terminal).
- [pages/screen-spawn.md](pages/screen-spawn.md): Spawn agent: fields → AgentSpec, presets and model slots, Bypass rules, CLI feature gating.
- [pages/screen-source-control.md](pages/screen-source-control.md): Source control: project cards (sync, Commit…, agent worktrees, PR state, recent commits), Ready to review, overlap heads-up, unpushed notice; shared git store.
- [pages/screen-review.md](pages/screen-review.md): Review changes: custom unified diff with inline comments, Monaco split view, Viewed, summary and checks, Send feedback / Open PR / Merge locally, J/K and ]/[ keys.
- [pages/screen-files.md](pages/screen-files.md): Files: lazy per-project trees with checkout menus and agent markers, one Monaco editor (local, lazy), agent banner, history, Mentioned in.
- [pages/screen-artifacts.md](pages/screen-artifacts.md): Artifacts: grid by kind / scope / search, sandboxed previews, Open with editor, Give to an agent, history with view and restore, Import from claude.ai, New artifact.
- [pages/screen-marketplace.md](pages/screen-marketplace.md): Extension marketplace: categories, list and detail, install consent, updates, Add custom (URL, import, command/JSON, folder/git).
- [pages/screen-settings.md](pages/screen-settings.md): Settings: Claude Code, Models (presets, versions, your models), Agents, Techniques, Permissions, Projects, shortcuts, accent, privacy; save-on-change rules and `.oide/` load errors.

## Reviews

- [pages/review-design.md](pages/review-design.md): design conformance review (2026-11-24): renderer vs the canvas per screen, 0 blocker / 5 major / 21 minor, with evidence and the file to fix.
- [pages/review-security.md](pages/review-security.md): security review (2026-11-24): 2 critical, 5 high, 9 medium, 11 low findings, PoC tests in `test/security/` (`it.fails` until fixed) and the concrete fix for each.
- [pages/review-conformance.md](pages/review-conformance.md): brief conformance and gates review (2026-11-24): traceability matrix per brief table, gate results (M1 passed with the real CLI 2.1.325), 1 blocker / 5 major / 10 minor; tests in `test/conformance/`.

## Decisions

- [../adr/](../adr/): ADRs. 0001 node:sqlite, 0002 TS-source packages, 0003 @lydell/node-pty, 0004 artifact versions as numbered snapshots.
