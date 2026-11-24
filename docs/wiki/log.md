# oIDE wiki: log

Append-only. Newest at the bottom. Each entry: `## [YYYY-MM-DD] <op> | <title>`.

## [2026-11-24] ingest | Build brief and Mission Control design
Ingested the oIDE architecture and build brief (raw/build-brief.md) and the nine Mission Control
screens (raw/design/). Created the wiki skeleton, index, CLAUDE.md schema and the shared protocol
package. Recorded `claude --help` for CLI 2.1.325.

## [2026-11-24] decision | ADR 0001 to 0003
node:sqlite instead of better-sqlite3 + Drizzle (Electron 45 ships Node 24.22); internal packages
export TypeScript source; @lydell/node-pty for N-API prebuilt terminals.

## [2026-11-24] build | Git worktrees, storage, settings and artifacts store
Built `packages/git` (execFile runner with no-prompt env and Windows long paths; porcelain v2
status; WorktreeManager create/list/remove-with-retries/prune/orphans/setup/aheadBehind; merge-base
to working-tree diffs incl. untracked files and a tolerant unified-diff parser; log with the
`Oide-Agent:` trailer; `merge --no-ff` with abort on conflicts; `merge-tree` conflict prediction;
overlap detector; fetch/pull --ff-only/push; optional `gh` wrapper; commit of selected files) and
`packages/store` (node:sqlite with numbered migrations and VACUUM INTO backups; repositories for
projects, agents, subagents, events with paging and 30-day compaction, usage, review, ui scope,
extensions, custom servers; SettingsService with Cheap/Balanced/Quality presets and the three
built-in techniques, deep-merge patches and workspace-trust-aware `.oide/` overrides; `.oide/*.json`
read/write and generated JSON Schemas; SqliteSecretStore over safeStorage; ArtifactStore with
numbered snapshots and the MCP `ArtifactsBackend`). Added `test/no-credentials.test.ts`.
Decision: [ADR 0004](../adr/0004-artifact-versions-as-numbered-snapshots.md) (snapshots, not git
commits, for repo artifacts). Pages: [git-worktrees](pages/git-worktrees.md),
[storage](pages/storage.md), [artifacts](pages/artifacts.md), [protocol](pages/protocol.md).

## [2026-11-24] build | Extension system and marketplace
Built `@oide/extension-api` (typed author API, `tsc` build to `dist/` via `publishConfig`),
`@oide/extension-host` (manifest loader with path-escape checks and a small semver, registry with
per-project/global/team enablement, installer with SRI check before a validated tar extraction,
`buildMcpConfig` allow/deny lists, one utility process per extension with backoff restarts, Add
custom probes, read-only import scan keeping only MCP server keys, MCP OAuth with PKCE and a
loopback redirect, loopback proxy with per-agent secrets, developer-mode watcher),
`tools/marketplace-index` (validate/build, bundled index with only the built-ins) and the
built-in extensions git, browser-preview and themes. Additive protocol edits: `InstalledExtension`
`disabledProjects`/`disabledTools`, `MarketplaceEntry.source`, `MARKETPLACE_CATEGORIES`,
`ExtensionUpdate`, IPC `extensions.updates/update/addFromGit`, `custom.importSelected`,
`custom.setHeaderToken`, `custom.authorize` `clientId`, probe and scan extra fields,
`extensions.hostState` event. Pages: [extensions](pages/extensions.md), [marketplace](pages/marketplace.md).
Guess recorded: CLI tool names normalise non `[A-Za-z0-9_-]` characters to `_`.
