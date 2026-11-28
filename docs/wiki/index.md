# oIDE wiki: index

The product knowledge base for oIDE, maintained by the agents that build it (see the "wiki" section
of [CLAUDE.md](../../CLAUDE.md)). Sources live in [raw/](raw/); history lives in [log/](log/README.md),
one file per entry (entries up to 2026-11-27 are in the frozen [log.md](log.md)).

## Sources (raw, immutable)

- [raw/build-brief.md](raw/build-brief.md): the architecture and build brief (M0 to M7, stack, constraints).
- [raw/design/](raw/design/): the Mission Control design screens (Main, Focus, Spawn, SourceControl, Review, Artifacts, Marketplace, Files, Settings).
- [raw/design/website/](raw/design/website/): the first oIDE Website design (home page top, middle, bottom and phone; `site.css`).
- [raw/design/website-2026-11-27/](raw/design/website-2026-11-27/): the current oIDE Website design, the "Developer Cowork" copy (Main, Direct, Features, More, Phone; `site.css`).
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
- [pages/claude-accounts.md](pages/claude-accounts.md): several Claude Code accounts (one `CLAUDE_CONFIG_DIR` each): Settings list, Spawn picker (only with 2+), per-account plan usage in the status bar, sign-in per account; the user picks, never automatic failover.
- [pages/subagents.md](pages/subagents.md): SubagentTracker and what each subagent view is built from.
- [pages/mcp-server.md](pages/mcp-server.md): oIDE's MCP server (permission prompt, submit_for_review, artifacts).
- [pages/git-worktrees.md](pages/git-worktrees.md): worktree manager, diffs, overlaps, merge, cleanup.
- [pages/storage.md](pages/storage.md): node:sqlite schema, migrations, `.oide/` files, keychain.
- [pages/extensions.md](pages/extensions.md): manifest, extension host, API, risk labels.
- [pages/marketplace.md](pages/marketplace.md): the static index, install flow, Add custom.
- [pages/artifacts.md](pages/artifacts.md): local artifacts, kinds, versions, MCP tools, claude.ai import rules (never without content), React design preview.
- [pages/kanban-boards.md](pages/kanban-boards.md): kanban boards (artifact kind `board`): the `board.json` model, board operations shared by the UI and agents (`board_read` / `board_update`), Start an agent from a card, access rules, 200 kept versions.
- [pages/desktop-shell.md](pages/desktop-shell.md): Electron main, preload bridge, renderer shell, keymap.
- [pages/app-menu.md](pages/app-menu.md): the native macOS menu bar (oIDE, File, Edit, View, Agent, Window, Help): items, shortcuts that follow Settings › Keys, how items reach the window; no menu bar on Windows/Linux.
- [pages/windows.md](pages/windows.md): several windows on one profile: how to open them, what is shared and what is per window, the active window.
- [pages/security.md](pages/security.md): hardening, trust, bypass guard rails, credential test.
- [pages/reliability.md](pages/reliability.md): crash isolation, rotating redacted logs, opt-in local crash reports, DB recovery, Windows cleanup, diagnostics.
- [pages/telemetry.md](pages/telemetry.md): opt-in Umami usage analytics and error reports from main: consent, event catalogue, never-sent list, scrubbing, adding an event, forks.
- [pages/testing.md](pages/testing.md): Vitest, fake-claude fixtures, Playwright e2e.
- [pages/packaging.md](pages/packaging.md): electron-builder, CI matrix, updates, signing.
- [pages/release-pipeline.md](pages/release-pipeline.md): release-please release PRs, Conventional Commit PR titles, draft release, per-OS installer builds and automatic publishing to GitHub Releases; one-time repo setup.
- [pages/docs-site.md](pages/docs-site.md): the VitePress docs site and its home page from the oIDE Website design: layout switch, scoped design CSS, light/dark without hydration mismatch, self-hosted fonts, download cards.

## Screens

- [pages/screen-wall.md](pages/screen-wall.md): Mission Control wall (Main): tiles per status, inline permission / reply / review, subagent chips, compact confirm, J/K/N/Y/D keys; Archived agents, Interrupted, pull request lifecycle, reload rehydration.
- [pages/screen-focus.md](pages/screen-focus.md): Focus: virtualized paged transcript, subagent views by parentToolUseId, pinned permission prompt, composer with / commands and artifacts, inspector (Plan, Subagents, Changes, Artifacts, Terminal).
- [pages/new-project.md](pages/new-project.md): New project dialog: open a folder (git init a plain one), clone (URL, owner/repo, your GitHub repos via gh; progress, cancel), new repository; SEC-08 locations, clone URL rules, first commit.
- [pages/screen-spawn.md](pages/screen-spawn.md): Spawn agent: fields → AgentSpec, presets and model slots, Bypass rules, CLI feature gating.
- [pages/screen-source-control.md](pages/screen-source-control.md): Source control: project cards (sync, Commit…, agent worktrees, PR state, recent commits), Ready to review, overlap heads-up, unpushed notice; shared git store.
- [pages/screen-review.md](pages/screen-review.md): Review changes: custom unified diff with inline comments, Monaco split view, Viewed, summary and checks, Send feedback / Open PR / Merge locally (predicts conflicts first; "Ask agent to resolve" sends them back to the agent), J/K and ]/[ keys.
- [pages/screen-files.md](pages/screen-files.md): Files: lazy per-project trees with checkout menus and agent markers, one Monaco editor (local, lazy) with language servers (hover, completions, definitions, references, diagnostics), agent banner, history, Mentioned in, newer npm versions inline in package.json with a click-to-upgrade agent.
- [pages/screen-artifacts.md](pages/screen-artifacts.md): Artifacts: grid by kind / scope / search, sandboxed previews, Open with editor, Give to an agent, history with view and restore, Import from claude.ai, New artifact.
- [pages/screen-marketplace.md](pages/screen-marketplace.md): Extension marketplace: categories, list and detail, install consent, updates, Add custom (URL, import, command/JSON, folder/git).
- [pages/screen-usage.md](pages/screen-usage.md): Usage (status bar › Tokens today): tokens and agent sessions per day/week over 7 days, 30 days or a year, by project and model, when sessions start, and facts about how you work; all measured locally.
- [pages/screen-settings.md](pages/screen-settings.md): Settings: Claude Code, Models (presets, versions, your models), Agents, Techniques, Permissions, Projects, shortcuts, accent, privacy; save-on-change rules and `.oide/` load errors.

## Reviews

- [pages/review-design.md](pages/review-design.md): design conformance review (2026-11-24): renderer vs the canvas per screen, 0 blocker / 5 major / 21 minor, with evidence and the file to fix.
- [pages/review-security.md](pages/review-security.md): security review (2026-11-24): 2 critical, 5 high, 9 medium, 11 low findings, PoC tests in `test/security/` (`it.fails` until fixed) and the concrete fix for each.
- [pages/review-conformance.md](pages/review-conformance.md): brief conformance and gates review (2026-11-24): traceability matrix per brief table, gate results (M1 passed with the real CLI 2.1.325), 1 blocker / 5 major / 10 minor; tests in `test/conformance/`.
- [pages/review-publication.md](pages/review-publication.md): publication readiness review (2026-11-25): secrets and personal data in tree and history (none secret), licensing and notices, trademark and npm scope, public-doc accuracy, repo hygiene, and the owner's pre-publish checklist.

## Decisions

- [../adr/](../adr/): ADRs. 0001 node:sqlite, 0002 TS-source packages, 0003 @lydell/node-pty, 0004 artifact versions as numbered snapshots, 0005 whiteboards as a read-only render in v1 (since overtaken: Excalidraw is now embedded as the editor, see [screen-artifacts](pages/screen-artifacts.md)), 0006 pull requests through `gh` from main, 0007 plan usage meters from rate-limit events, 0008 extension language servers deferred (superseded by 0019), 0009 extension artifact types use the existing storage kinds, 0010 merged and discarded agents are archived, not deleted, 0011 opt-in telemetry with Umami, sent from main, 0012 worktree folders deleted by oIDE (fs.rm + prune), not `git worktree remove` (git follows junctions), 0013 React designs run in a bundled offline runtime, 0017 artifact agents work in an empty folder and edit one artifact over MCP, 0018 updates download in the background and install on quit by default, 0019 language servers run in main behind a small Monaco bridge (trusted projects only), 0020 the common language servers (TS/JS, CSS, HTML, JSON, YAML) ship with oIDE and run with the user's Node.js, 0021 several Claude Code accounts, one `CLAUDE_CONFIG_DIR` each, picked per agent, 0022 kanban boards are an artifact kind changed through shared operations (user and agents), newest 200 versions kept.
