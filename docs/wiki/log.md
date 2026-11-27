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

## [2026-11-24] build | Desktop shell and UI kit
Built `apps/desktop` (electron-vite): hardened single window (context isolation, sandbox, no Node,
strict CSP via build-time meta + dev header, navigation/window.open blocked, https allow-list to the
system browser, single-instance lock, remembered bounds), the generic Zod-validating `IpcRouter`
(`not_implemented` for commands without handlers), validated `emit` with a per-frame `agents.batch`
batcher, the `createServices` / `registerAllHandlers` seams, handlers for `app.info`, `shell.*`,
`dialog.pickFolder` and `terminal.*` (`TerminalService` on @lydell/node-pty), the path guard
(`assertInside`, `AllowedRoots`) and a preload exposing exactly `window.oide`. Renderer: React 19 +
Tailwind v4 + Zustand frame matching the canvas (header, rail, status bar without plan % meters),
typed router, stores (agents, projects, scope, settings, cli, ui), dev-only mock bridge with the
canvas fixtures, keymap service, command bar, toasts and placeholder screens. `@oide/ui`: tokens as a
Tailwind `@theme` with a runtime accent, and the component kit. Tooling: root ESLint flat config,
electron-builder with fuses, CI and release workflows, Playwright Electron smoke tests.
Decisions: bundled libraries moved to devDependencies so only natives and electron-updater ship;
`tslib` added explicitly (pnpm hoisting skipped it); keybinding overrides persist in localStorage
until settings has a field. Pages: [desktop-shell](pages/desktop-shell.md),
[packaging](pages/packaging.md), [design-system](pages/design-system.md) (component inventory).

## [2026-11-24] build | Agent supervisor, fake CLI and MCP server
Verified the real Claude Code CLI 2.1.325 in five small `--model haiku` sessions (sanitized recordings in
`tools/fake-claude/fixtures/real-*.jsonl`): stream-json shapes, multi-turn on one process, `/compact` as a
user message, `interrupt` and `set_permission_mode` control requests, the `--permission-prompt-tool` MCP
contract, `--permission-mode auto`, `--effort`, and subagent events tagged with `parent_tool_use_id`
(the tool is now `Agent`, runs can be async). Built `packages/agent-core` (parser, buildLaunch, detectCli,
ClaudeCliDriver, AgentReducer, SubagentTracker, Supervisor), `packages/mcp-server` (OideMcpServer:
permission_prompt, submit_for_review, artifacts tools) and `tools/fake-claude`. Additive protocol fields:
summary `planText`/`backgroundTasks`/`planUsage`, `PermissionRequest.toolUseId`, result
`contextWindow`/`localCommand`/`apiErrorStatus`, error `code`, events `mode-changed`, `compact`,
`subagent-task`, `background-tasks`, `plan-usage`. Pages: [cli-integration](pages/cli-integration.md),
[agent-supervisor](pages/agent-supervisor.md), [subagents](pages/subagents.md),
[mcp-server](pages/mcp-server.md), [open-questions](pages/open-questions.md), [testing](pages/testing.md).
Finding: `rate_limit_event` reports plan utilization per window (open question 4).

## [2026-11-24] build | Wall and Spawn screens
Built the Wall (`screens/Wall/`: projects sidebar as scope switcher, filter chips, memoized per-agent
tiles for every status incl. queued / rate-limited / error, inline permission prompt with the exact
request id, reply box, Review diff / Open PR, subagent chips, compact confirm, Artifacts and
Marketplace teasers, empty states, J / K / N / Enter / Y / D / Esc) and Spawn (`screens/Spawn/`:
goal + context chips from route params, project, Work in, mode cards with Bypass guard rails, focus
presets, routed strategy slots with effort and model versions, techniques, attempts 1–6, extension
tools, Ctrl/Cmd+Enter, `AgentSpec` validation, highlight on the Wall). Mock: `lib/mock/wall.ts`
(`agents.spawn`, `projects.open`, `?wall=states|empty|no-projects`). Consumes `git.prAvailable` and
`artifacts.uses`; no protocol changes. Decisions: N focuses the tile on the Wall; one "Model
versions" row instead of a select per slot. Pages: [screen-wall](pages/screen-wall.md),
[screen-spawn](pages/screen-spawn.md).

## [2026-11-24] build | Artifacts, Marketplace and Settings screens

Built the three screens from the canvas against the IPC contract, with mock data in
`lib/mock/library.ts` (marked as mock; marketplace entries are invented sample data). Pages:
[screen-artifacts](pages/screen-artifacts.md), [screen-marketplace](pages/screen-marketplace.md),
[screen-settings](pages/screen-settings.md). Protocol additions (additive): `settings.builtIns`,
`settings.loadErrors`, `artifacts.uses`, `artifacts.readVersion`, `dialog.pickFile`, optional
`projectId`/`location` on `artifacts.import`, optional `MarketplaceEntry.updatedAt`; router
`spawn.context` for Give to an agent. Decisions: whiteboards render as read-only SVG (no embedded
Excalidraw in v1); doc editing uses a textarea; design previews use `oide-artifact://` in an
`allow-scripts` sandbox (srcdoc with an empty sandbox as fallback); Settings "Check for update" is
"Check again" (no CLI update command); worktree location is a select (schema enum). Open needs:
an IPC to toggle single tools of marketplace extensions (`disabledTools`), and the supervisor
must map `custom:<id>` preset slots to `AgentSpec.customModel`.

## [2026-11-24] build | Source control, Review and Files screens
Built Source control (`screens/SourceControl/`: per-project cards with sync state and Pull / Fetch /
Push, Commit… dialog, agent worktrees with status, diff stats, PR state, Review and a ··· menu (open
folder, reconcile, remove), recent commits with agent attribution; Ready to review, overlap heads-up
with `git.reconcile`, unpushed notice; shared `useGit` store refreshed on `git.changed`), Review
(`screens/Review/`: custom unified diff renderer with click-to-comment and inline threads, virtualized
past 400 rows; Monaco split view with reverse-applied originals; Viewed; summary, checks, Send
feedback, Open PR gated by gh, Merge locally with conflict hand-off to Spawn; J/K files, ]/[ hunks) and
Files (`screens/Files/`: lazy windowed trees per project with compacted folders, checkout menu and
agent markers; one lazy Monaco editor from the local package with an inlined editor worker and the
`oide-dark` theme; save via `files.write`; agent banner; selection "Ask an agent about this" / "Send
to agent"; history and Mentioned in). Mock: `lib/mock/scm.ts`. Protocol additions: `git.prAvailable`,
`files.mentionedIn`; router: `files.line`. Pages: [screen-source-control](pages/screen-source-control.md),
[screen-review](pages/screen-review.md), [screen-files](pages/screen-files.md).

## [2026-11-24] build | Focus screen

Built Focus (`screens/Focus/`) to Focus.dc.html: agents list with J/K/N/Esc, lead and subagent headers,
virtualized transcript (`agents.events` pages + live tail, own history store, stick-to-bottom with
"Jump to latest", streaming "Writing…" from partials, sanitized markdown), subagent cards and views by
`parentToolUseId`, pinned permission prompt (exact request id, Y/D), composer (/ commands, Attach
artifact, Shift+Tab mode), compact confirm, inspector Plan/Subagents/Changes/Artifacts/Terminal (xterm,
lazy). Status bar plan meter (`components/frame/PlanUsage.tsx`) from `planUsage` utilization only.
Protocol: `init.slashCommands` (agent-core parser should fill it). Mock: `lib/mock/focus.ts` (canvas
transcript, 5k-event transcript, terminal). 43 tests. Page: [screen-focus](pages/screen-focus.md).

## [2026-11-24] build | Main-process wiring
Connected every wave-1 package inside the Electron main process. `services/core.ts`
(`createCoreServices`, plain Node, Electron injected through `services/platform.ts`) builds the store
(`<userData>/oide.db`), SettingsService, SqliteSecretStore over `safeStorage` (writes refused + startup
notice when unavailable), WorktreeManager, ArtifactStore (rescan at startup), OideMcpServer, the
Supervisor with all four ports (`services/agents.ts`), GitService (watchers, debounced diffs, periodic
fetch, gh PR state), ExtensionsService (registry, installer, custom tools, loopback proxy, one utility
process per extension from the bundled `out/main/host-process.js`) and CliService. Every command in
the IPC contract has a handler (`handlers/*.ts`, Electron-free except `shell.ts`), including the
renderer engineers' additions (settings.builtIns/loadErrors, artifacts.readVersion/uses,
dialog.pickFile, git.prAvailable, files.mentionedIn, extensions.setToolEnabled). Trust: native dialog
in main on first open (default "Not now"). Artifact previews: privileged `oide-artifact://<id>/<file>`
scheme with a no-network CSP; window `frame-src oide-artifact:`. Lifecycle: migrations, worktree prune
+ orphan notice, 30-day event compaction, restore + `--resume` of agents working at quit; quit denies
pending prompts and stops agents. Package changes: agent-core (`extraEnv` / agentId for extension
hooks, `Supervisor.setDiff`, tool-name normalization in `buildLaunch`, Node for `.mjs` CLIs inside
Electron, `.cmd` shims with multi-line args run their Node target), protocol (`AgentSpec.baseRef`,
`extensions.setToolEnabled`), lint fixes in extension-host, git, store, protocol. Verified with one real
`claude -p --model haiku` run that the CLI names `db.schema` `mcp__<server>__db_schema` (recorded in
[cli-integration](pages/cli-integration.md)). New page [security](pages/security.md); updated
[desktop-shell](pages/desktop-shell.md), [testing](pages/testing.md), [storage](pages/storage.md),
[extensions](pages/extensions.md). Tests: `test/integration/main-services.test.ts` (6) and
`apps/desktop/e2e/agents.spec.ts` (3).

## [2026-11-24] review | Design conformance
Adversarial check of the renderer (dev:web, mock bridge) against the nine canvas screens, rendered to
static pages with a small DCLogic runtime and compared side by side at 1440 and 1100×700, with
computed-style measurements, a contrast walk, accessible-name and ARIA-role checks and keyboard flows.
0 blockers, 5 major, 21 minor. Majors: global `line-height: 1.5` (canvas uses `normal`, every row
grows), Wall tile bodies 16px short (`box-border` on a content-box 92px, activity lines cut in half),
"Queued" label at 2.9:1, Focus broken at the 1100×700 minimum, Focus agent list names cut to ~14
characters. Frame metrics, ARIA labelling and J/K/N/Y/D/Esc/Ctrl+K/Shift+Tab all pass. Page:
[review-design](pages/review-design.md).

## [2026-11-24] review | Security

Adversarial security review before open-source release: [review-security](pages/review-security.md).
2 critical (Windows cwd binary planting of `git`/`gh`/`node` from an opened repo; untrusted projects
still get the CLI's own `.claude/settings.json` hooks and `.mcp.json` servers because `-p` skips the
CLI trust dialog), 5 high (repo git config exec via oIDE's git calls; renderer-to-exec paths:
`custom.probeCommand`, `terminal.create` command, `extensions.addFromGit`, cliPath/custom servers),
9 medium, 11 low. `pnpm audit --prod`: no known vulnerabilities. PoC tests in `test/security/`
(`it.fails` until fixed). No product code changed.

## [2026-11-24] review | Brief conformance and gates

Brief conformance review: [review-conformance](pages/review-conformance.md). Gates: build, typecheck,
lint (0 errors), vitest (402 pass), e2e (9 pass), `electron-builder --dir` (packaged exe launches and runs
an agent) all pass. **M1 passed with the real CLI 2.1.325** on the services layer (haiku: Bash prompt
reached oIDE, approved, result 42, stop, restart, `--resume`, follow-up answered from memory). M3 fails:
"Merge worktree into main locally" ignores uncommitted worktree changes, toasts "Merged", and cleanup
"Right away" deletes the worktree (blocker B1). Also: extension UI contribution points not wired, toasts
cover Review actions, stale status bar, e2e launch misses built-in extensions. 1 blocker / 5 major /
10 minor. Tests: `test/conformance/real-cli.test.ts` (opt-in `OIDE_REAL_CLI=1`),
`test/conformance/review-merge.test.ts` (`it.fails`). No product code changed.

## [2026-11-24] build | Security fixes (extensions)

Fixed the extension and custom-tool findings of [review-security](pages/review-security.md):
SEC-04, SEC-06, SEC-07 (extension and custom parts), SEC-09 (custom server tokens), SEC-10,
SEC-13, SEC-15, SEC-23 and SEC-24; SEC-14 is copy and docs only (accepted risk for enforcement).
New `apps/desktop/src/main/security/confirm.ts` (`confirmNative`, Cancel default, plain Node
answers no, `OIDE_E2E_CONFIRM` for unpackaged e2e). Native confirmations before a command probe, a
stdio save or import, newly pre-allowed custom tools, a git clone, and the first enable of a folder
or git extension. Registry refuses a same-name extension from another source; team files never
enable folder or git extensions. Custom server credentials are bound to their origin; changed
commands drop their env secrets. Each agent's proxy secret opens only its own servers. Folder and
git extension tools always ask. Extension `artifacts.read` is project-scoped and plain settings use
`extensions:<name>:<key>`. Import scan output masks secret-looking args and URL parts. Checked on
Electron 45.4.1 that utilityProcess ignores `--permission`, so capabilities stay unenforced; the
Marketplace copy, [security](pages/security.md), [extensions](pages/extensions.md) and the
extension-api README now say so. Tests: `test/security/extension-confirm.test.ts` (new),
SEC-04 and SEC-13 PoCs flipped to `it`, plus oauth, import-scan and registry unit tests.

## [2026-11-24] build | Design review fixes

Fixed 25 of the 26 findings in [review-design](pages/review-design.md) (5 major, 20 minor); SE3 needed
no change (the Remove button is already `#9AA3AE`). Global: `line-height: normal` (canvas metrics),
`ink-4`/`ink-5` no longer used for small text (placeholders, meta, line numbers → `ink-3`), borderless
links underlined, status-bar counts from the live stores and a time-only reset label. Wall: whole
activity lines (108px box), readable Queued, two-line sidebar names, one-row header at 1100,
"Edit automatically" badge, no Spawn without a project. Focus: container queries keep the header,
subagent cards, prompt and inspector tabs whole at 1100×700; two-line agent names; unknown subagent
ids fall back to the lead. Also: aligned model grids (Spawn, Settings), fixed-grid worktree rows,
sticky review comments, doc-preview fade, Marketplace per-tool toggles through screen state, Monaco
ligatures and function tint, Settings `inpSm`, first technique expanded. Pages updated:
design-system, desktop-shell, screen-wall, screen-focus, screen-spawn, screen-source-control,
screen-review, screen-artifacts, screen-marketplace, screen-files, screen-settings.

## [2026-11-24] build | Security fixes (core)

Fixed the core findings of [review-security](pages/review-security.md): SEC-01, SEC-02, SEC-03,
SEC-05, SEC-07 (cliPath, extra flags), SEC-08, SEC-09 (custom model keys), SEC-11, SEC-12, SEC-16,
SEC-17 to SEC-22, SEC-26 (agents) and SEC-27; SEC-25 is an accepted risk. Main sets
`NoDefaultCurrentDirectoryInExePath` first thing and git, gh and node run from absolute paths.
Untrusted projects start agents with `--setting-sources user --strict-mcp-config`, get their repo
git config neutralised (no hooks, filters, fsmonitor, external programs) and have no watcher or
background fetch. `terminal.create` lost `command`; `projects.open({ path })` needs a dialog pick or a
known project; cliPath and extra flags need a native confirmation; model keys are bound to their
origin. mcp.json holds no secret (`${VAR}` headers, checked against the 2.1.325 binary), custom stdio
secrets go through a one-time launcher, prompts are capped at 5 per agent. Edits to `.oide/`,
`.claude/` and `.mcp.json` always ask, and Review warns about them. Also fixed review-conformance B1
(merge commits pending work, reports ok only when main moved, never deletes unmerged work) and M4
(dev repo root for built-in extensions, with an e2e check). PoCs flipped: SEC-01, 02 (2), 03, 05,
08, 09, 17, conformance B1 (2); new `test/security/core-fixes.test.ts`. Pages updated: security,
review-security, review-conformance.

## [2026-11-24] build | M7 release engineering
Auto-update: `apps/desktop/src/main/services/updater.ts` (`UpdaterService` over electron-updater on
GitHub Releases; `autoDownload`/`autoInstallOnAppQuit` off, download and install are separate clicks,
install needs `{ consent: true }` and an inline confirm; stable/beta channels with downgrades off and
`generateUpdatesFilesForAllChannels`; off in dev, portable zip, deb/rpm and `OIDE_DISABLE_UPDATES`;
unsigned macOS builds link to the release page; `lastCheckedAt` in `<userData>/updates.json`), wired as
`services.updates` in `services/index.ts` with `handlers/updates.ts`. Additive protocol: `Settings.updates`
(`channel`, `checkAutomatically`), `UpdateStatus`, IPC `updates.status/check/download/install`, event
`updates.changed`; store default. Renderer: Settings › Updates. CI/CD: `release.yml` rewritten (tag/version
check, per-OS builds to a draft release, Azure Trusted Signing / certificates / Developer ID +
notarization only when secrets exist, SHA256SUMS, optional GPG, prerelease flag for beta tags),
`nightly-real-cli.yml` (opt-in, self-hosted `oide-real-cli`), `cli-compat.yml` (weekly; new
`tools/fake-claude/record.mjs` with an allow-listed env and sanitizer, `test/conformance/cli-compat.test.ts`
diff, `cli-compat` issue on drift), `codeql.yml`, `dependabot.yml`, `docs.yml`. Docs site: VitePress in
`docs/site/` (guide, every screen, agents and permissions, worktrees and review, extension author guide,
security model, FAQ with the Anthropic terms note, contributing). OSS: `CODE_OF_CONDUCT.md` (Contributor
Covenant 2.1), issue forms, PR template, `CHANGELOG.md`, `pnpm licenses:notices` / `licenses:check`
(`THIRD_PARTY_NOTICES.md`, 140 shipped packages, all MIT-compatible, shipped in `resources/`), original
icon (`pnpm icons`: SVG to PNG/ICO/ICNS in `apps/desktop/build/`). Name check recorded in
[open-questions](pages/open-questions.md) (npm scope `@oide` is taken; `oide-dev` free). Fixed: the
extension-host test fixture `ext-sample/dist/` was gitignored, so fresh checkouts failed
`host-client.test.ts`; it is now tracked. Pages: [packaging](pages/packaging.md),
[milestones](pages/milestones.md), [screen-settings](pages/screen-settings.md), [protocol](pages/protocol.md).

## [2026-11-24] build | Security fixes (custom model env, CLI path)

Fixed three findings from an automated scan of the core security fixes (review-security SEC-28..30).
SEC-28 (high): a custom model's `extraEnv` can no longer set loader, interpreter, PATH, proxy, TLS,
Electron, `ANTHROPIC_*`, `CLAUDE_CODE_*` or `OIDE_*` variables (`DENIED_MODEL_ENV` in agent-core,
case-insensitive and prefix-aware); main refuses them at save time and asks through a native
confirmation whenever a model's base URL, provider or env changes. SEC-29 (medium): only a path
picked in the new `dialog.pickCli` (Settings › Claude Code › CLI path › Browse…) skips the CLI path
confirmation, once; other dialog picks no longer count. SEC-30 (medium): custom model keys are bound
to a hash of origin, provider and the whole `extraEnv`. New `test/security/custom-model-env.test.ts`
and agent-core denylist tests. Pages updated: security, review-security.

## [2026-11-24] build | Conformance UX fixes

Fixed from [review-conformance](pages/review-conformance.md): **M2** toasts (5 s info/success, 10 s warnings,
sticky errors with Dismiss, dedupe ×N, max 3, hover holds, bottom-left above the status bar, polite live region;
`notify.kind`/`requestId` so a needs-permission toast is retired when its prompt resolves); **M3** status bar
(live counts; `usage.summary` on agent/project events, debounced, plus local midnight; no 15 s poll); **m1**
queued summary published at spawn; **m2** Source control loading state; **m3** setup status only when a setup
runs (`runSetup` `onStart`); **m4** `@parcel/watcher` `windows` backend; **m5** agent folder deleted on remove;
**m6** no PR without a git remote; **m7** ADRs 0005 (whiteboard render), 0006 (PRs via gh from main), 0007
(plan meters from `rate_limit_event`); **m8** `.github/dependabot.yml`; **m9** lint warnings. m10 stays with
security. Also: Focus `/` menu from `init.slash_commands` (parser fills `slashCommands`); Settings › Keyboard
shortcuts editor (record, conflict warning, reset) saved in `Settings.keybindings` (old localStorage rebinds
migrated once); a tile and Focus note when a prompt was denied because oIDE quit
(`permission-resolved.reason: 'quit'` → `AgentSummary.interruptedPermission`); review comments keep
`side: 'old' | 'new'` (store migration 2). Pages: desktop-shell, protocol, storage, cli-integration,
screen-focus, screen-review, screen-settings, screen-source-control, screen-wall. New e2e: `toasts.spec.ts`.

## [2026-11-24] build | Extension UI contributions

Wired every v1 contribution point end to end (review-conformance M1). Panels: new privileged
`oide-ext://<hash of name>/<file>` scheme (`apps/desktop/src/main/services/extension-ui.ts`) serving
only files inside an extension's folder with a no-network CSP (loopback frames only for manifests
that declare `network: ["localhost"]`); the renderer shows them in `<iframe sandbox="allow-scripts">`
as Focus inspector tabs or the new `extension` screen (rail letter tiles, "Open <title>" in Ctrl K).
Panel bridge `renderer/src/extensions/panelBridge.ts` (checks `event.source`, rate and size) →
`extensions.panelMessage` → main (extension on, panel declared, ≤ 256 KB) →
`ExtensionHostClient.sendPanelMessage`, which now starts stopped host code (`onPanel:<id>`); host
`panels.open` / `panels.postMessage` are implemented as `extensions.panelOpen` / `extensions.panelMessage`
events. Commands get `{ agentId }` in Focus. Settings › Extensions (`extensions.settings` /
`setSetting`, secrets keychain-only, `extensions.settingChanged`). Settings › Appearance lists
contributed themes and applies allow-listed tokens; the themes extension is manifest-only now.
Extension techniques are merged by main (`ext:<name>:<id>`, read-only). Review shows
`deployTargets` (`extensions.runDeployTarget`, agent and project checked; not runnable as commands).
Typed artifacts (`ArtifactMeta.type`) open in the extension's viewer iframe (ADR 0009).
`languages` deferred (ADR 0008). Browser preview: panel without `<form>` (no `allow-forms`), asks
host code for its default URL. Unpackaged builds find the repo root by walking up to
`pnpm-workspace.yaml` (review M4), so e2e loads the built-ins. Fixture `@oide-test/ui` has one of
every point; tests in `test/integration/extension-ui.test.ts`, `host-client-ui.test.ts`,
`extension-ui.test.ts`, `renderer/src/extensions/*.test.ts(x)` and e2e `extensions.spec.ts`.
Pages: [extensions](pages/extensions.md#ui-contributions), [security](pages/security.md#extension-panel-isolation),
[desktop-shell](pages/desktop-shell.md), [review-conformance](pages/review-conformance.md).

## [2026-11-24] build | Artifact editors

Artifact editors on the Artifacts screen ([screen-artifacts](pages/screen-artifacts.md),
[artifacts](pages/artifacts.md)). Whiteboards open in an embedded Excalidraw 0.18 (MIT, open
question 16), dark theme mapped onto the oIDE tokens, lazy chunk, fonts bundled by a Vite plugin
(`apps/desktop/excalidraw-assets.ts`) with `EXCALIDRAW_ASSET_PATH` set locally and Excalidraw's esm.sh
font fallback stripped; **no CSP change** (export, AI and embeds are off instead). Docs edit in Monaco
(the Files setup, lazy) beside a live Markdown preview; designs edit HTML in Monaco beside the
sandboxed preview, which reloads on save. Compare any two versions (or a version and unsaved edits)
in a Monaco diff. Rename (`artifacts.rename`, title only) and Delete with confirms. Agent writes reach
an open artifact through `artifacts.changed` (now with `change`, `version`, `author`): loaded with
"Updated by <agent>" when there are no edits, otherwise a conflict banner (Compare, Keep mine, Use
theirs); saves carry `baseVersion` and main refuses stale ones with `conflict`. Bundle: first-load
chunk unchanged, Excalidraw 1.8 MB lazy, fonts 13.1 MB (Xiaolai CJK 12.6 MB). Tests: store
(`artifacts-editing.test.ts`), handlers (`test/integration/artifact-handlers.test.ts`), renderer
(`Editors.test.tsx`, `excalidraw-env.test.ts`, model), e2e (`e2e/artifacts.spec.ts`: doc edited to v2,
whiteboard saved under the production CSP). Found: the keymap does not treat Monaco's EditContext as
editable, so plain-key shortcuts can fire while typing in other Monaco hosts.

## [2026-11-24] build | Custom model env: allow-list instead of denylist (SEC-28)

The SEC-28 denylist missed names (`OPENSSL_*`, `GCONV_PATH`, `LESSOPEN`, `MANPAGER`, `TERMINFO`,
`IFS`, `PS4`, `LUA_*`, `GOOGLE_APPLICATION_CREDENTIALS`), so a custom model's `extraEnv` is now
checked against `MODEL_ENV_ALLOW_LIST` in agent-core (exact names: AWS/Vertex region, project and
profile, `VERTEX_REGION_<MODEL>`, default model ids, `CLAUDE_CODE_SUBAGENT_MODEL`, output and
thinking token limits, `DISABLE_PROMPT_CACHING`). The same check runs at save time in main (clear
`invalid_input` message listing the allowed names) and at launch in `customModelEnv`. An agent's
subagent-model strategy now wins over the model's `CLAUDE_CODE_SUBAGENT_MODEL`. Pages updated:
security, review-security.

## [2026-11-24] build | Reliability and diagnostics

New `apps/desktop/src/main/reliability/` (see [reliability](pages/reliability.md)): renderer
watchdog (reload after `render-process-gone` with a crash-loop guard and error page, unresponsive
dialog), rotating redacted file logs in `<userData>/logs/` (main, renderer, extension host, one per
agent; 5 MB x 3, 14-day retention, never throws), opt-in local crash reports (off by default,
`crashReporter` with `uploadToServer: false`, summaries stripped of paths, prompts and code; no
upload in v1), database open with recovery prompts (locked → Retry; damaged → backed up first, then
the user chooses; `openDatabase` now closes its handle on failure), event appends that survive a
full disk (bounded queue, one notice), MCP bind retries without blocking startup, ordered shutdown
with per-step timeouts (the old 3 s cap could orphan CLI processes), Windows locked-folder cleanup
queue (`pending-cleanup.json`, retried on next start), `taskkill /T` by absolute path for agent and
setup process trees, and Settings › Diagnostics (CLI range, git ≥ 2.38, gh, node, keychain, DB,
MCP port; copyable redacted report; Open logs folder). Git service dispose now closes watchers and
awaits in-flight diff refreshes, so worktrees are not left locked after shutdown on Windows.
Renderer: per-screen error boundaries with a sanitized copyable report, bounded event buffers
(2000 tail, 10 000 with history, released on Focus close), extension host state store (panels
reloading, toasts). Found: Node 24.11 `fs.rmSync` silently skips non-ASCII paths on Windows
(`fs-safe.ts` `removeSync` falls back). Extension host test fixture `dist/` was git-ignored and is
now committed. New IPC: `app.diagnostics`, `app.openLogsFolder`, `app.reportError`; setting
`ui.crashReports`. E2E `reliability.spec.ts` kills the renderer and checks the agent keeps running.

## [2026-11-24] build | Milestone gate tests

Automated proof for the M2 to M6 gates against tools/fake-claude, in `test/gates/` (plain-Node services
layer through the real IPC router) and `apps/desktop/e2e/gates.spec.ts` (the UI-visible part). See
[testing](pages/testing.md#milestone-gate-tests-testgates) and [milestones](pages/milestones.md).
M2 compressed soak (6 agents, 3 projects, Max running 3, every interaction kind, 60 s by default via
`OIDE_SOAK_MS`): no leaked CLI processes, listeners or handles, no lost or duplicated events, stores
consistent, heap bounded. M3: passes up to a merged branch; the full gate (uncommitted work reaches main)
is `it.fails` on blocker B1. M4: two userData dirs get identical launch plans from `.oide/`; untrusted
differences checked; gap: Spawn reads mode and preset from global Settings (`it.todo`). M5: a third-party
tarball from a local index (real integrity) gives an agent a stdio MCP tool it calls. M6: an agent reads a
design and writes a doc; Agents using it; the user's save is v2. E2E: the M5 Marketplace check skips while
the unpackaged build does not resolve built-in extensions. fake-claude gained `commit-work`,
`address-feedback`, `commit-all`, `mcp-tool`, `artifacts`, the per-message `[fake-scenario:x]` marker,
stdio MCP servers and `pid` in `--fake-record`. The gitignored `ext-sample/dist` fixture is now tracked
(`.gitignore` exception), which made `host-client.test.ts` fail on clean checkouts.

## [2026-11-25] build | Custom model env values checked; confirmations cannot be spoofed (SEC-28, SEC-31)

Two more scan findings, fixed together with the allow-list. SEC-28: allowed env names must also
have well-formed values (`isAllowedModelEnvEntry` in agent-core: regions, GCP project ids, AWS
profiles, token counts, model names, switches), checked at save time and at launch, so a region
such as `evil.example.com/` cannot redirect Bedrock or Vertex. SEC-31 (medium): native
confirmations escaped nothing, so a crafted name, URL, path, flag or command line could add fake
lines; new `safeDialogText()` in `security/confirm.ts` escapes controls, line separators, bidi and
zero-width characters, every `confirmNative` caller uses it (settings, extensions, custom tools)
and `confirmNative` applies it again per line. Custom model base URLs must be http(s) without
`user:password@`; the dialog shows the origin in full. New `confirm.test.ts`; more cases in
`custom-model-env.test.ts` and `args.test.ts`. Pages updated: security, review-security.

## [2026-11-25] build | Integration: release, ux, extui, artplus merged
Branch `integrate` merges `wave4/release`, `main` (ea5cbd9), `wave4/ux`, `wave4/extui` and `wave4/artplus`.
No store migration or ADR collisions (migration 2 from ux; ADRs 0005-0007 ux, 0008-0009 extui). Settings
gains both `updates` and `keybindings`; Settings has Extensions and Updates sections; Review keeps the
sensitive-files warning beside deploy actions; the artifact Viewer keeps artplus's editors and extui's
extension artifact types. Tests from the branches now use main's SEC-07/SEC-08 stand-ins. Fixed: the
keymap ignored Monaco's EditContext input, so J/K/N/Y/D fired while typing in the Files editor; unchorded
keys inside `.monaco-editor`, contenteditable ancestors and Excalidraw are now ignored
([desktop-shell](pages/desktop-shell.md)).

## [2026-11-25] build | Integration: robust merged; MCP launch guard and secret redaction
Merged `wave4/robust`. Two scanner findings fixed: the MCP-down guard now sits on the launch path
(`guardedBroker` in `services/agents.ts`, used by spawn, resume and relaunch), and `restore()` leaves
working agents stopped and resumable when the MCP server is down; and secrets are registered with the
log redactor (agent MCP secret and secret env at registration, keychain reads via `redactSecretReads`).
Tests: `services/agents-broker.test.ts`, `reliability/redact.test.ts`, an MCP-down restart test in
`test/integration/main-services.test.ts`. Page: [reliability](pages/reliability.md).

## [2026-11-25] build | Integration: gates merged and green
Merged `wave4/gates`. The gate harness accepts main's native confirmations and counts `projects.open`
as a folder pick; e2e specs from the branches use `OIDE_E2E_OPEN_PATHS` / `OIDE_E2E_CONFIRM`. Follow-ups:
M3's full gate is a plain `it` (B1 fixed on main); M4's todo is a passing test: new IPC
`settings.forProject { projectId } → { defaultMode, presetId, techniques }`, used by the Spawn screen
(project mode under trust and preset; a mode or model setup the user picked is kept); the M5 Marketplace
e2e check is no longer skipped; queued agents spawned over IPC already get a summary (ux), so the M2 e2e
reload workaround is gone. Pages: [testing](pages/testing.md), [milestones](pages/milestones.md),
[screen-spawn](pages/screen-spawn.md), [protocol](pages/protocol.md).

## [2026-11-25] review | Publication readiness
Adversarial pre-publication pass over the tree and all 43 commits. No secret in tree or history (every
token shape is a test fixture), so no history rewrite for secrets. Scrubbed a Windows user name and
session temp ids from `review-design.md`, `review-conformance.md` and a fake-claude fixture; regenerated
the stale `THIRD_PARTY_NOTICES.md` (Excalidraw tree; `licenses:check` was failing CI); docs no longer
tell authors to install from the foreign `@oide` npm scope; CHANGELOG, README, CLAUDE.md, ADR 0005
(superseded), docs site and wiki brought in line with the merged code; `.gitignore` extended. Code
issues reported (Excalidraw font notices, recorder slug sanitising, bundled index tarball URLs, dead
usage-statistics switch, unclaimed `oide-dev` org behind `DEFAULT_INDEX_URL`). Owner checklist in
[review-publication](pages/review-publication.md).

## [2026-11-25] review | Security round 2

Second adversarial pass over everything merged since round 1 (extension UI and the `oide-ext://`
bridge, artifact editors, reliability, updater, workflows and `record.mjs`, `settings.forProject`,
custom-model env, `safeDialogText`, keymap) and every IPC command added since. The reviewer also
fixed what it found. Findings in [review-security](pages/review-security.md#round-2-2026-11-25):
3 medium, 8 low, none critical or high. Fixed: SEC-32 (preview and panel URLs with `%5C` made main
realpath a UNC path, an NTLM hash leak), SEC-33 (WebRTC still reached TURN over TCP despite
SEC-18; the window session now has a dead fixed proxy, loopback direct), SEC-34 (actions pinned by
SHA, no cache in release jobs), SEC-35 (log entry forging, report rate limit), SEC-36 (project
techniques reusing a default-on id), SEC-37 (more invisible characters escaped in dialogs), SEC-38
(trust dialog escapes name and path), SEC-39 (path guard refuses UNC candidates). Accepted or
documented: SEC-40 (unsigned Windows updates have no publisher check), SEC-41 (an artifact viewer
can relay to its own panels), SEC-42 (opt-in compat recordings list the runner's MCP names). All
round-1 PoCs still pass; spot checks of SEC-01/02/03/05/08/16/28 found no merge damage. PoCs:
`test/security/round2-*.test.ts`. Pages updated: [security](pages/security.md),
[reliability](pages/reliability.md), [packaging](pages/packaging.md).

## [2026-11-25] review | Final conformance pass

Walked every screen of the merged app (built `out/main`, Playwright, fake-claude, 3 temp repos, one
with a committed `.oide/`) at 1440×900 and 1100×700 and compared each with the canvas. All screens
pass; 0 console errors in the full second session. Real CLI M1 smoke still passes (2.1.325, haiku,
16 s). Fixed: F1 parallel attempts with long titles raced on the same branch name (worktree creates
are now one at a time per project), F2 `--header "Authorization: Bearer …"` args reached the import
list unmasked (SEC-24 follow-up), F3 the New artifact dialog carried "Personal" over to the next
artifact, F4 the extension Preview tab was clipped in Focus's inspector, F5 needs-permission toasts
covered tile buttons and repeated prompts already on screen, F6 Push with no remote gave git's raw
error, F7 Settings claimed "signed in" before the CLI said so, F8 "0 files ·". fake-claude gained an
`artifact-update` scenario. Remaining: minor and cosmetic items only. Details in
[review-conformance](pages/review-conformance.md#final-pass-2026-11-25); gate status in
[milestones](pages/milestones.md).

## [2026-11-25] build | Publication fixes

Fixed the code issues of [review-publication](pages/review-publication.md). Licences:
`tools/licenses/fonts.mjs` records the 12 shipped font families (Excalidraw's 9 folders, Inter,
JetBrains Mono, Codicons) with licences verified from the shipped WOFF2 name tables and upstream
files; THIRD_PARTY_NOTICES.md gains a "Bundled fonts" section and Excalidraw's upstream MIT text;
`licenses:check` fails on an unrecorded font folder or, after a build, an unrecorded font in
`out/renderer` (release.yml re-runs it after the build). Owner note: Liberation Sans 1.05 is GPL-2.0
with the font exception, recorded as an explicit exception. Recorder: `tools/fake-claude/record.mjs`
scrubs every spelling of home/cwd/temp paths, other user and temp folders, the user name, e-mails,
account/org/user ids and uuids (crafted-input tests). Privacy: the dead usage-statistics switch is
removed (`ui.telemetry` deprecated, unread). Distribution: `packages/protocol/src/distribution.ts`
holds the names; no remote marketplace index by default (Settings › Extensions › Marketplace index
URL, native confirmation in main), built-ins are `source: builtin` with `oide-builtin:` URLs and never
resolved from npm, `publish: null` in electron-builder.yml and the updater is off unless the build gets
`OIDE_PUBLISH_OWNER` / `OIDE_PUBLISH_REPO`. Pages: [packaging](pages/packaging.md),
[marketplace](pages/marketplace.md), [screen-settings](pages/screen-settings.md),
[security](pages/security.md).

## [2026-11-25] build | Build session complete
All phases built in parallel waves and merged on `main`: M0 foundations, M1 single agent end to end
(verified with the real CLI), M2 Mission Control, M3 source control / review / files, M4 settings and
trust, M5 extensions and marketplace, M6 artifacts, and the M7 work that needs no accounts (updater,
release CI, docs site, OSS hygiene). Two adversarial security rounds (SEC-01..42), a design review,
a brief-conformance review, a publication-readiness review and a final end-to-end pass are recorded
under Reviews in the index. Final gate on `main`: 700 unit/integration/gate tests, 25 Playwright e2e,
typecheck, lint, wiki lint and licence check all green. What remains needs the maintainer: see
[pages/review-publication.md](pages/review-publication.md) and [pages/open-questions.md](pages/open-questions.md).

## [2026-11-25] build | Context ring accuracy
User report: the context ring started near 75% on a simple prompt and read 92% later. Ground truth from
the real CLI 2.1.325 (`/context` after a one-line prompt, sonnet / opus / haiku with the user's 59 MCP
servers, and haiku with `--strict-mcp-config`): 36.6k to 37.5k of 1M (4%) every time; MCP tool
definitions are deferred and add ~1k. oIDE's token count (input + cache read + cache creation of the
latest lead request) matched `/context` exactly; the window was wrong. `contextWindowFor()` said 200k for
every model and the real window (1M) only arrived with the first `result`, so a long first turn was drawn
5x too full: the user's opus session (from oIDE's own event log) started at 84.8k (42% shown, 8% real)
and reached 150k (75% shown, 15% real) with no result yet. Fixes: the table knows the 5.5 models and
aliases are 1M; a shared `ContextWindowBook` learns windows from results and `/context` across agents and
from restored summaries; results pick the lead model's `modelUsage` entry instead of the largest; the
parser turns `/context`'s structured `context_usage` into a `context-usage` event; subagent rings use
their own model's window; the ring tooltip shows "N of W tokens (P%) · includes system prompt and tools"
and explains a large starting context (`contextBaseline`). Fixtures `real-context-*.jsonl` (MCP server,
tool, agent and skill names replaced), tests `packages/agent-core/src/context.test.ts`. Pages:
[cli-integration](pages/cli-integration.md), [agent-supervisor](pages/agent-supervisor.md).

## [2026-11-25] build | Logo and brand

Four logo concepts (Orbit, Facet, Constellation, Signal) drawn and compared at 16-128 px on dark and light
(`docs/brand/concepts.png`); **Signal** chosen (open o, lead agent in its opening, hub at the centre) for
its 16 px read and originality, then refined (circular bite, blue → violet ring, lit orbs, highlight,
heavier 16-32 px geometry). One generator, `tools/brand/build-brand.mjs`, writes the brand set in
`docs/brand/` (mark, light, mono, wordmark as outlines, social preview 1280×640, README with usage rules),
the app icon sources (`apps/desktop/build/icon.svg`, `icon-small.svg` for ≤32 px entries), the docs site
assets and `packages/ui/src/logoGeometry.ts`. Applied: app icons (`pnpm icons`), runtime window/taskbar
icon in dev and unpackaged runs (`main/app-icon.ts`, AUMID `dev.oide.app`, macOS dock in dev, Linux
`extraResources`), header (`<Logo variant="wordmark">` in `@oide/ui`, fixed brand colours, not the
accent), screen error panel, renderer favicon, docs site (nav logo, hero, favicon, og:image), README
header. Open question 18 added (trademark). See [design-system](pages/design-system.md#brand),
[packaging](pages/packaging.md).

## [2026-11-25] build | Slash menu and attachments

- Focus's `/` menu rebuilt (`components/SlashMenu.tsx`, `lib/slash.ts`): one fixed 28px row per command, mono
  label truncated with the full command in the tooltip, right-aligned description; built-ins, skills, plugins,
  then one group per MCP server (`mcp__claude_ai_HubSpot__x` → "HubSpot (MCP)" / `x`); filter with prefix
  matches first, "N of M" count, 320px cap with scrolling, arrows/Page/Home/End/Enter/Tab/Esc, combobox and
  listbox ARIA. Picking inserts `/<command> `; `/compact` keeps its confirm. Mock reports 96 commands.
- Attachments on the Focus composer, the Wall reply box and Spawn's goal: paste screenshots, drop files,
  Attach file (`dialog.pickFiles`). Images go as stream-json image blocks; other files are copied to
  `.oide/attachments/<timestamp>-<name>` in the agent's folder (excluded via `info/exclude`). Main validates
  (picked/dropped or worktree paths only, sniffed image types, 5/20/25 MB and 10-item limits). Drops use a
  preload-only channel fed by `webUtils.getPathForFile`. Transcript shows thumbnails (click to enlarge).
- Real CLI 2.1.325 check (3 Haiku runs): image blocks accepted; single image recognised ("red"); with two
  images Haiku said it saw only paths, so multi-image recognition is unconfirmed. See
  [cli-integration](pages/cli-integration.md) and [screen-focus](pages/screen-focus.md).

## [2026-11-25] build | Files search, replace and quick open

Files gains a tree toolbar (Search, Reveal active file, Expand loaded folders, Expand to depth 1-3,
Collapse all) and, with All projects, a per-project folder menu; `*` expands sibling folders and `-`
collapses. Ctrl/Cmd+K is now also quick open: file names across the projects in scope, ranked in main
from a per-checkout index (`git ls-files --cached` + `git status -uall`, refreshed by the checkout
watchers), in sections with commands and sessions; `>` restricts to commands, `name:42` opens at a
line, Enter opens the file in its checkout and reveals it in the tree. Ctrl/Cmd+Shift+F (or the header
Search button) opens the Search panel: match case / whole word / regex, include and exclude globs,
current checkout or all projects in scope, streamed results grouped by file (`git grep` through the
hardened runner's new `Git.stream`, `-e <pattern> --`, untracked files scanned in main), and Replace /
Replace all through a preview confirm that warns about agents editing the file; `files.replace`
refuses files whose hash changed since the search. Protocol additions: `files.findByName`,
`files.searchContent`, `files.cancelSearch`, `files.replace`, event `files.searchResults`
(`packages/protocol/src/search.ts`). 100k-file repo: index 0.7 s, queries 50-105 ms, rare-string
search 2.0 s. Pages: [screen-files](pages/screen-files.md), [desktop-shell](pages/desktop-shell.md),
[security](pages/security.md), [git-worktrees](pages/git-worktrees.md).

## [2026-11-25] build | Archived agents and reload rehydration

Bug: a live agent vanished from the Wall in a dev session ("No agents yet", "0 sessions · 0
worktrees") while main kept running it. Reproduced against `electron-vite dev` with fake-claude: a
Vite hot update that re-runs a store module (an edit to `packages/protocol`, which every store
imports) gives the components a new, empty agents store, while `startStores()` ran once and keeps
loading and feeding the old one. `lib/boot.ts` is now the HMR boundary for the stores it wires and
reloads the page. Hardening: `agents.load()` retries with backoff and the Wall shows the error with
Retry; `repairAgentSummary` (protocol) repairs or drops a summary that fails the contract instead of
failing `agents.list`; `AgentsRepo.list()` skips unreadable rows. Archived agents: merge, a PR merged
on GitHub, discard, `done` and a new Archive action move agents to Wall › Archived (migration 3,
`agents.archive` / `unarchive` / `listArchived` / `getArchived` / `deletePermanently`, event
`agents.archived`), read-only Focus, Interrupted tiles after a restart or crash, archived transcripts
compacted (not deleted) after 30 days. Pull requests: `summary.pr`, "View PR #N" with state,
idempotent `git.openPr`, `PrWatcher` (open/draft only, after fetch and on focus, backoff). ADR
[0010](../adr/0010-archive-agents-instead-of-deleting.md). Pages:
[screen-wall](pages/screen-wall.md#archived-agents), [agent-supervisor](pages/agent-supervisor.md),
[storage](pages/storage.md).

## [2026-11-25] build | Opt-in telemetry (Umami)

The product owner asked for Umami analytics, crash reports, performance and events, with a first-run
question and a Settings switch. Research: `data.frostlogic.se` runs Umami v3.5.0 (`/api/scripts/telemetry`);
its `script.js` has the `event`, `identify`, `performance` (web vitals) and `error` collectors, and the
v3.5.0 server schemas (`api/send/request-schema.ts`, `lib/errors/schema.ts`) were copied into a unit
test. Decisions ([ADR 0011](../adr/0011-telemetry.md)): opt-in, two switches (`settings.privacy`), no
remote script in any window (main sends to `/api/batch` and `/api/send` through the in-memory
session `oide-telemetry` that can reach only that origin), no session recording (`recorder.js`
would capture code and prompts). One catalogue in `packages/protocol/src/telemetry.ts` (23 events,
each with its product question; unknown events and values dropped, unknown properties stripped);
most events observed in main from IPC commands, agent events and emitted events, so screens are
untouched. Errors scrubbed beyond the log redactor (paths, URLs, emails, quoted text, ids, tokens,
user and machine names; app-bundle frames only), fuzz-tested. In-memory queues, batches of 20,
backoff, `Retry-After`, offline-aware, dropped on quit. `ui.telemetry` (0.1.x) stays unread and is not
consent. Live check: one batch (identify, pageview, event, performance) and one error with hostname
`oide-dev` and `test: true` were accepted (4/4 processed, error issue created). Pages:
[telemetry](pages/telemetry.md), [security](pages/security.md), [screen-settings](pages/screen-settings.md),
[review-publication](pages/review-publication.md), [reliability](pages/reliability.md); README Privacy,
PRIVACY.md, docs site [privacy](../site/guide/privacy.md), CLAUDE.md "Analytics and telemetry (every task)".

## [2026-11-25] build | Merge conflicts go back to the agent

User request: "If there's a conflict, it blocks me from merging it. I would like if there's conflict, to be sent
back to the agent to solve it and then users manually clicks merge again." Built: `predictMerge` in
`packages/git` (`git merge-tree --write-tree -z` between the main checkout's HEAD and the agent branch, binary
and submodule conflicts called out, behind/ahead counts, `supported: false` on git older than 2.38) and a clear
"commit or stash" refusal when uncommitted main files would be overwritten. IPC `git.predictMerge` (cached in
main per commit pair) and `git.askToResolve`, which re-predicts and sends a `merge-conflicts` message (built in
main only; `agents.send` refuses it) shown in the transcript as "Sent by oIDE": target branch and commit, files,
`git merge <target>` in its own worktree, resolve keeping both sides, checks, commit, `submit_for_review`; never
rebase, force-push, touch the main checkout or abort silently. Stopped agents are resumed (queued under Max
running), archived ones unarchived; no action when the worktree is gone or the agent works in the project folder.
`AgentSummary.mergeConflict` drives a "Resolving merge conflicts" badge until the next submit_for_review; nothing
merges on its own. The merge dialog leads with "Ask <agent> to resolve" and keeps "Merge anyway"; a merge that
stops anyway offers the same action. Freshness lines ("Behind main by 2 commits, would conflict in 1 file") on
Review, Ready-for-review tiles and Source control from a renderer store refreshed on `git.changed`. Telemetry:
`merge_conflict_predicted`, `merge_conflict_sent_to_agent`, `merge_conflict_resolved`. fake-claude gained
`resolve-conflicts`. Pages: [screen-review](pages/screen-review.md#merge-conflicts),
[git-worktrees](pages/git-worktrees.md), [screen-wall](pages/screen-wall.md), [protocol](pages/protocol.md),
[telemetry](pages/telemetry.md), [testing](pages/testing.md).

## [2026-11-25] build | Import from claude.ai takes the artifact's content

"Paste a link" used to store only a stub (a page with a note), so importing a design looked broken. oIDE
cannot fetch claude.ai artifacts: there is no public content API, and fetching a private one would need
the user's claude.ai sign-in, which oIDE never touches. The dialog now has an "Artifact content" text area
(with an Open button for the link): the user pastes the code they copied, and `artifacts.import({ url, content })`
stores it with `importedFrom`. The kind and title follow the content (`inferKindFromContent`, `titleFromContent`,
`looksLikeHtml` in `@oide/protocol`). React or other non-HTML code is refused as a design, with a message
saying why. "Pick a file" can keep the claude.ai link as the origin. An empty paste still makes a link-only
stub ("Import link only"). Links carrying a user name or password are refused, and repo imports register
their artifact root like `create`. New telemetry event: `artifact_imported` (source, kind, linked). Pages:
[artifacts](pages/artifacts.md), [screen-artifacts](pages/screen-artifacts.md), [telemetry](pages/telemetry.md).

## [2026-11-25] review | Import from claude.ai: review fixes

Two reviewer passes on the import change. Fixed: an exponential-backtracking comment pattern in `looksLikeHtml`
(now an `indexOf` loop) and quadratic title patterns; Markdown that opens with an HTML banner stays a doc; SVG
files with a doctype count as pages; doc titles prefer front-matter `title:` (JSON-unescaped) and skip fenced
code; the dialog memoises its content check, keeps the instructions visible with a `role="alert"` refusal, and
gives Open a full accessible name. Open and "Open in claude.ai" only appear for claude.ai links
(`canOpenClaudeLink`): claude.site stays off the external-link allow-list, since anyone can publish there. The dev mock
mirrors the store. Pages: [artifacts](pages/artifacts.md), [screen-artifacts](pages/screen-artifacts.md).

## [2026-11-25] build | Worktree deletion on Windows

Incident: a discarded agent's worktree (a pnpm install: 68,687 entries, paths up to 412 characters,
6,095 junctions) could not be deleted; Docker Desktop, started by a `docker` command in the
worktree, kept it as its current directory. Found while fixing it: `git worktree remove` (git 2.51)
follows junctions and deleted files of a folder outside the worktree, and `fs.rm`'s `maxRetries`
compounds per directory level, so a held folder made the delete hang for minutes.
- `WorktreeManager.remove` makes git's safety checks itself, deletes with `removeTree` (`fs.rm`,
  `maxRetries: 0`, whole-tree retries), then `git worktree prune` (ADR 0012). `isLockError` /
  `isLockedFileError`: only `EBUSY` and sharing violations are locks.
- `reliability/folder-holders.ts`: who holds a folder (Windows handle table via a fixed PowerShell
  script, folder in an env var; `lsof +d` elsewhere; 10 s timeout; same user; exe names only). The
  notice names them; after an agent stops or is archived the agent log warns about leftovers.
- `CleanupScheduler`: retries every 5 minutes with per-folder backoff and at start; "Finished
  removing <name>"; Settings › Diagnostics › Folders waiting to be removed (Retry now, Show holders).
- PR lookups skip projects without a git remote quietly (cached `git remote`, refreshed on fetch).
- Telemetry: `worktree_delete_failed { holder }`, `worktree_delete_retried_ok { attempts }`.
Pages: [git-worktrees](pages/git-worktrees.md#why-a-worktree-cant-be-deleted-on-windows),
[reliability](pages/reliability.md#windows), [telemetry](pages/telemetry.md),

## [2026-11-25] build | Resizable sidebars

Every sidebar can be resized by dragging its inner edge, within a per-panel min (where the content
still fits) and max; the main area always keeps 360px. One component, `ResizableAside`
(`apps/desktop/src/renderer/src/components/ResizableAside.tsx`), replaces the fixed-width `<aside>`
on all 14 sidebars; the registry with ids, sides, defaults (the canvas widths) and limits is
`src/lib/panels.ts`. The handle is a focusable `role="separator"` (arrows, Shift for big steps,
Home / End; double-click resets; Escape cancels a drag). Widths are saved on release (keyboard: after
400 ms) to the new `settings.ui.panelWidths` (protocol `PanelWidths`: id `^[a-z][a-z0-9.-]{0,63}$`,
integer 120-1600 px, at most 64 entries; bad entries are dropped so a stale one never resets the
rest of `ui`), so they survive restarts; Settings › Appearance has Reset
sidebar widths. Pages: [design-system](pages/design-system.md), [desktop-shell](pages/desktop-shell.md),
[screen-settings](pages/screen-settings.md).

## [2026-11-25] build | Windows dev taskbar showed Electron's logo
Cause: Electron writes a Start Menu shortcut (`Electron.lnk` → `electron.exe`, AUMID `dev.oide.app`, no icon)
for toast notifications, and Windows draws windows with that AUMID with the shortcut's icon. Unpackaged
Windows runs now set `build/icon.ico` on that shortcut (`brandAppShortcuts` in `apps/desktop/src/main/app-icon.ts`).
See [packaging](pages/packaging.md).

## [2026-11-25] build | Change an agent's permission mode at any time

Focus › header: the mode in the meta line is now a menu of every mode (`modeChoices` in
`screens/Focus/model/focus.ts`; Bypass listed but disabled with its reason unless Settings › Allow
Bypass is on and the agent is in a worktree), so an agent started in Plan that moved to Manual can go
straight to Auto or Bypass; Shift+Tab still cycles. Real CLI 2.1.332 refuses a live switch to bypass
(`bypass_not_launched`) unless launched with `--allow-dangerously-skip-permissions`; `buildLaunch` adds
that flag only where bypass is allowed. The supervisor's spec now follows the CLI's own mode changes
(plan → manual after an approved plan), so a resume relaunches in the real mode; restore and unarchive
take the summary's mode. `Menu` (`@oide/ui`) gained `checked` (menuitemradio) and `portal`. New
telemetry event `agent_mode_changed {from, to}`. fake-claude enforces `bypass_not_launched` and has an
`exit-plan` scenario. Pages: [screen-focus](pages/screen-focus.md), [cli-integration](pages/cli-integration.md),
[agent-supervisor](pages/agent-supervisor.md), [testing](pages/testing.md),
[design-system](pages/design-system.md), [telemetry](pages/telemetry.md).

## [2026-11-25] review | Mode menu review fixes

Reviewer findings fixed: the portalled `Menu` closed whenever any box scrolled (a streaming
transcript closed the mode menu); it now closes only when a box holding the trigger scrolls or the
window resizes. Tab in a menu returns focus to the trigger (it dropped to `<body>`, which let the
next Shift+Tab cycle the mode). Pick-one menus open on the checked item; `triggerTitle` gives a
native hint (`Change mode (Shift+Tab cycles)`). `Supervisor.setMode` calls run one at a time per
agent, so a slow `--resume` fallback cannot overtake a later pick. `AgentSummary.workIn` (from the
spec, set on spawn, restore and unarchive) lets the Focus menu disable Bypass for project-folder
agents instead of offering what main refuses. Pages: [screen-focus](pages/screen-focus.md),
[design-system](pages/design-system.md), [agent-supervisor](pages/agent-supervisor.md).

## [2026-11-25] build | "Always in <project>" now applies to running agents

"Always" saved the rule to `.oide/permissions.json`, but running CLIs only read `--allowedTools` at
launch, so the same agent asked again for the rest of its session. The supervisor now keeps the
session's "Always" rules per project and allows matching requests (and waiting prompts) without a
prompt, except protected-path edits and always-ask rules; the button is greyed out when no rule can
be saved. Pages: [agent-supervisor](pages/agent-supervisor.md), [screen-wall](pages/screen-wall.md).

## [2026-11-25] review | "Always" session rules: security hardening

Security review of the session "Always" rules: the protected-path check now fails closed on Windows
name folding (case, trailing dots/spaces, `:` streams, `~` short names), and edits are auto-allowed
only inside the agent's worktree with no symlink, junction (dangling included) or hard-linked file on
the way. Page: [agent-supervisor](pages/agent-supervisor.md).

## [2026-11-25] decision | claude.ai imports never create an artifact without content; React designs render offline

Two "oIDE website design" imports (links `MyEmjmATV3mpUv6SZmFj4T`, `NFaggV4JC9X6prTgKhobKm`) were made with
"Import link only", so v1 of each was oIDE's own "cannot fetch claude.ai artifacts" notice; an agent then
tried to build the docs site from it. Checked on the second link after it was made public: a plain GET is a
41 KB app shell (the design loads in the browser from `<uuid>.frame.claudeusercontent.com`), the Claude Docs
connector refuses both the 22-character id and the frame UUID, and DesignSync answers 404. There is no
supported way to read a chat artifact's code, even a public one; only Claude Docs and Claude Design links can
be read, by an agent through its own claude.ai connectors.
- Import is checked before anything is created (`classifyClaudeLink`, content present, not the old
  placeholder, fits the kind); a link alone is refused in Zod and in the store. Old link-only imports are
  `brokenImport` (derived): the screen asks for the content, MCP `artifacts_read` returns
  `status: 'import-has-no-content'` with `content: null`.
- "Fetch with an agent" hands a Docs / Design link to an agent that creates the artifact only with real
  content.
- React designs (`App.jsx`) are previewed with a bundled offline runtime (React, Sucrase, lucide-react,
  recharts, Tailwind browser) at `oide-artifact://<id>/__oide/react-runtime.js`; CSP unchanged
  ([ADR 0013](../adr/0013-react-designs-with-a-bundled-offline-runtime.md)).
- Telemetry: `artifact_imported.format`, `artifact_import_refused { reason }`,
  `artifact_fetch_with_agent_started`; the IPC router gained `observeFailure` (codes and Zod issue paths only).
Pages: [artifacts](pages/artifacts.md), [screen-artifacts](pages/screen-artifacts.md),
[mcp-server](pages/mcp-server.md), [security](pages/security.md), [telemetry](pages/telemetry.md).

## [2026-11-25] build | Fable context window
User report: with Fable the context ring assumed 200k instead of 1M. oIDE's event log showed a live
`claude-fable-5-2` session at 223,905 tokens on its first turn against the 200k fallback (no `result` yet,
so the real window was never learned). Fixes: the `contextWindowFor()` table now lists `claude-fable-5-2`
and the `fable` alias as 1M; and when a lead request is larger than a window that was only guessed (not
reported by the CLI), the reducer lifts the window to 1M until the CLI reports one. Tests in
`packages/agent-core/src/context.test.ts`. Pages: [cli-integration](pages/cli-integration.md),
[agent-supervisor](pages/agent-supervisor.md).

## [2026-11-25] build | Merge recovers from uncommitted changes in the main checkout

"Merge failed: The main checkout has uncommitted changes that the merge would overwrite
(tools/marketplace-index/bundled/index.json)": oIDE should recover on its own by stashing, merging and
unstashing. `mergeLocal` in `packages/git/src/merge.ts` now stashes only the files git names, merges
again and re-applies the stash; when re-applying clashes with the merge it undoes the partial apply
(`git reset --merge`), leaves the files as merged and keeps the stash (no conflict markers, nothing
lost). `git.mergeLocal` returns `autoStash { files, restored, note }`; Review's toast says what
happened (warning when the changes stay in the stash). Also fixed `parseBlockedByLocalChanges`: it
read only the first of git's two refusals (tracked and untracked) and took the trailer "Merge with
strategy ort failed." for a file name (staged files are indented with two spaces, not a tab).
Telemetry: `agent_merged` gains `local_changes`. Tests in `packages/git/test/merge-autostash.test.ts`
and `test/integration/merge-conflicts.test.ts`. Pages: [git-worktrees](pages/git-worktrees.md),
[screen-review](pages/screen-review.md), [telemetry](pages/telemetry.md).

## [2026-11-25] decision | Multi-file artifacts, retrieved by agents (ADR 0014)
A claude.ai Design link (a project of pages, CSS, a canvas file and screenshots) could not be imported:
oIDE never downloads claude.ai content and stored one file per artifact. Checked: CLI 2.1.332 has no
Artifact tool (only `DesignSync` for claude.ai/design projects and the Claude Docs connector for docs).
Decided and built: artifacts are folders of files with full-snapshot versions; New artifact › A link
creates the artifact at v0 and starts an ordinary agent that reads the link with the CLI's claude.ai
tools and hands files back through `artifact_retrieval_add_files` / `artifact_retrieval_finish`
(staged, committed as one version, or failed with a reason); Update re-runs it. One New artifact
dialog (A link / Files / Blank) replaces the import dialog and "Fetch with an agent". Pages:
[artifacts.md](pages/artifacts.md), [screen-artifacts.md](pages/screen-artifacts.md),
[mcp-server.md](pages/mcp-server.md), [telemetry.md](pages/telemetry.md), open question 5 answered.

## [2026-11-25] build | Artifacts: whole-version Restore, user guide rewrite
`artifacts.restore { id, version, baseVersion? }` commits the full snapshot of a version (every file and
the entry it had) as a new version noted "Restored v<n>", through the store's `commit` path; History >
Restore uses it, which closes the "restores only the entry" gap. The Viewer's Keep mine / Use theirs only
load a version into the editor and save through `save` / `writeFiles`, so they needed no change. The
docs site Artifacts guide, FAQ and Settings text now describe the link flow (an agent retrieves it with the
user's CLI), Update, the Files panel and history. Pages: [artifacts.md](pages/artifacts.md),
[screen-artifacts.md](pages/screen-artifacts.md).

## [2026-11-25] build | Agents name their own task (set_title)
- Spawn's title was the start of the user's prompt. Spawn now marks it `autoTitle`; the oIDE contract asks the
  agent to call the new MCP tool `mcp__oide__set_title` once, first thing, with a short title. The supervisor
  cleans it (`cleanAgentTitle` in protocol), keeps attempt `#n` suffixes, updates the spec and emits
  `title-changed` (reducer → `summary.title`; store mirrors the `title` column). Titles the caller gave
  (reconcile, extensions) are kept: `set_title` is refused for them and after the first call.
- The CLI emits no title of its own in stream-json, so nothing is taken from it.
- fake-claude gained a `name-task` scenario. Focus shows "Named the task …" as a notice.
- Telemetry: `agent_spawned.auto_title`, new `agent_titled { after }` (duration bucket only, never the title).
Pages: [agent-supervisor](pages/agent-supervisor.md#agent-named-titles), [mcp-server](pages/mcp-server.md),
[screen-spawn](pages/screen-spawn.md), [telemetry](pages/telemetry.md).

## [2026-11-25] build | Agents keep their branch up to date with the base
The oIDE contract (`packages/agent-core/src/args.ts`, `syncContract`) now tells every worktree agent with a
named base (`main`, `origin/main`, a branch; not a bare sha) to `git merge <base>` before starting a new task
and again right before `submit_for_review`, resolving conflicts, re-running checks and reporting an
"Up to date with <base>" check. The supervisor passes the worktree's `baseRef` into `buildLaunch`. No telemetry
change: this is prompt text, and the existing review/merge events already cover the outcome.
See [agent-supervisor](pages/agent-supervisor.md).

## [2026-11-25] build | Collapsed defaults; Spawn remembers extension tools
Source control: "Recent commits on <branch>" starts collapsed on every project card. Spawn: "Advanced model settings" starts closed (opens when Custom is picked); "Tools from extensions" starts from the last spawn's picks, saved as `settings.spawn.lastExtensions` (new protocol field, defaulted so older settings parse). No telemetry change.

## [2026-11-25] build | Merge dialog: fixed "Ask agent to resolve" label
The merge dialog's primary button read "Ask <agent title> to resolve", so long titles pushed the footer
out of the 480px dialog. The label is now fixed; the note above the buttons and the button tooltip name
the agent. Dialog footers wrap and descriptions break long unbroken text (paths) instead of overflowing.

## [2026-11-25] build | New project: open folder (with git init), clone, new repository
"Open project" was a bare folder picker that refused anything but a git repository. It is now one
**New project** dialog with three tabs: Open folder (a plain folder can be initialized with a first
commit), Clone repository (https / ssh URL, `owner/repo`, a github.com link, or one of the user's
GitHub repositories through their own `gh`; git's progress, Cancel) and New repository (`git init` on
`main` with a README or empty first commit, opened trusted). New commands `projects.initFolder`,
`projects.create`, `projects.clone`, `projects.cancelClone`, `projects.githubRepos` and the
`projects.cloneProgress` event. Clone URLs refuse remote helpers, options, local paths and `file://`;
target folders must sit in a picked location or next to an open project (SEC-08), and never be `.git`.
Telemetry `project_added` / `project_add_failed`. Pages: [new-project.md](pages/new-project.md) (new),
[desktop-shell.md](pages/desktop-shell.md), [screen-wall.md](pages/screen-wall.md),
[telemetry.md](pages/telemetry.md); user guide getting-started and Wall.

## [2026-11-26] build | Docs site redone from the oIDE Website design
Ingested the "oIDE Website" design artifact into [raw/design/website/](raw/design/website/). The docs
site home page is now that design (`docs/site/.vitepress/theme/Landing.vue`, `layout: landing`), with
the app's own logo mark instead of the design's square, and the doc pages take its palette and
Archivo headings. Fonts are self-hosted (fontsource). The design's brew and winget commands do not
exist, so the download cards show SHA256SUMS checks instead; downloads link to GitHub Releases. No
telemetry change (the site has no analytics). Pages: [docs-site.md](pages/docs-site.md) (new),
[packaging.md](pages/packaging.md).

## [2026-11-26] build | Files tree restyled like the VS Code explorer
Flush 22px rows, chevrons, Seti-like file-type icons (`screens/Files/fileIcons.tsx`), indent guides with
the focused folder's guide highlighted, uppercase project section headers. See [screen-files](pages/screen-files.md).

## [2026-11-26] build | Release pipeline with release-please; links to frostlogic-ab/oIDE
The project lives at [frostlogic-ab/oIDE](https://github.com/frostlogic-ab/oIDE). Releases are now
automated: PRs are squash-merged with Conventional Commit titles (`pr-title.yml`), release-please
(`release-please.yml`, `release-please-config.json`, `.release-please-manifest.json` at 0.1.0) keeps a
`chore: release X.Y.Z` PR open, and merging it creates a draft release + tag and calls `release.yml`
(now `workflow_call` / `workflow_dispatch`, no tag trigger), which builds Windows, macOS and Linux
installers, uploads them to the draft and publishes it after `SHA256SUMS`. The release feed defaults
to the repository running the workflow (`OIDE_PUBLISH_*` variables still override it);
`OIDE_RELEASE_KEEP_DRAFT=true` keeps drafts. Website, docs, package metadata and issue templates
link to the new repository; the docs site base is `/oIDE/` (`frostlogic-ab.github.io/oIDE`).
`CHANGELOG.md` is written by release-please from now on. No telemetry change (CI only). Pages:
[release-pipeline.md](pages/release-pipeline.md) (new), [packaging.md](pages/packaging.md),
[docs-site.md](pages/docs-site.md).

## [2026-11-26] build | Review: Archive session when there is nothing to push
A finished agent whose worktree has no changes or commits against its base (and no PR) no longer
offers Open pull request / Merge locally in Review; it offers Archive session instead. See
[screen-review](pages/screen-review.md#decisions).
## [2026-11-26] build | Pull requests follow the project's own conventions
Open pull request no longer sends the agent title and a summary as is. The oIDE contract (`prContract`
in `args.ts`) tells branch agents to look up how the project wants PRs (PR template, CONTRIBUTING.md,
CLAUDE.md/AGENTS.md, Conventional Commits via commitlint / release-please / semantic-release / a
PR-title workflow, recent commit style) whenever they write one, and to pass a `pr { title, body }`
draft in `submit_for_review`. `git.openPr { agentId }` uses that draft; without one, main
(`packages/git/src/pr-draft.ts`) fills the project's PR template with the summary and checks and
gives the title a Conventional Commits type when the project uses them. Telemetry: `pr_opened` gains
`draft` (agent / template / plain / given). Pages: [screen-review.md](pages/screen-review.md),
[mcp-server.md](pages/mcp-server.md), [agent-supervisor.md](pages/agent-supervisor.md),
[telemetry.md](pages/telemetry.md).
## [2026-11-26] decision | Docs site served from getoide.com
The repository is now public at github.com/frostlogic-ab/oIDE and GitHub Pages (source: GitHub Actions)
uses the custom domain `getoide.com`. The VitePress base moved from `/oIDE/` to `/`, the favicon and
`og:image` URLs follow, a sitemap is generated for `https://getoide.com`, and `docs/site/public/CNAME`
pins the domain in the deployed artifact. `docs.yml` deploys on every push to `main` that touches
`docs/site/**` ([docs-site](pages/docs-site.md), [release-pipeline](pages/release-pipeline.md)).

## [2026-11-26] decision | Artifact previews allow 'unsafe-eval' (ADR 0015)
claude.ai Design exports (`*.dc.html` + `_runtime/support.js`) compile their component with `new Function`,
which the artifact CSP blocked (red CSP error box over the preview). `ARTIFACT_CSP` now allows
`'unsafe-eval'`; network, frames, workers and the sandbox are unchanged, and inline scripts already ran, so
an artifact gains no new capability. Updated [artifacts.md](pages/artifacts.md); test pins the CSP.
## [2026-11-26] build | CI unit tests pass on GitHub's runners

CI run 45783318672 failed `pnpm test` on all three OSes, though the suite passed on a developer's
Windows machine. Causes: macOS's temp folder is a link (`/var` → `/private/var`) and Windows runners
use an 8.3 short temp path (`RUNNER~1`), so git's real paths never matched the tests' paths (and a `~`
looked like a protected path to SEC-12); Windows runners set `core.autocrlf=true`; Linux/macOS git
says "repository '…' does not exist" for a missing local clone source; two tests assumed Windows path
rules; and the Windows holder scan's 10 s budget was used up by PowerShell start-up on a runner.
Fixes: `test/setup/env.ts` (canonical temp, no system/global git config), the clone classifier knows
the POSIX wording, `readAgentFile` refuses `\host\share` on every OS, `HOLDER_TIMEOUT_MS` 25 s.
See [testing](pages/testing.md).
## [2026-11-26] decision | CI split: what runs on pull requests
First runs on GitHub showed CI red on every OS (5 Vitest failures on Linux, 11 on macOS, 10 on
Windows; platform path bugs that a Windows dev machine does not hit) and every CI and CodeQL run on
`main` cancelled by the next push. `ci.yml` now runs typecheck and lint once (Linux), unit tests on
all three OSes, e2e on Linux for PRs and on all three OSes for main, skips the heavy jobs for
docs-only PRs, builds the docs site when `docs/site/**` changes, never cancels runs on main, and ends
in one `CI ok` check for branch protection. CodeQL skips docs-only PRs and no longer cancels runs on
main ([packaging](pages/packaging.md#ci-and-release-workflows)).

## [2026-11-26] review | "Open pull request" failed with "title: expected string"
Reported as `Invalid input for git.openPr: title: expected string, received undefined`. The schema on
`main` was already right (`title`/`body` optional since the PR-conventions change); the running main
process predated it. `electron-vite dev` hot-reloads the renderer but does not rebuild or restart main
and preload, so after pulling, restart oIDE when `packages/protocol` or `src/main` change. A router
test now pins `git.openPr` accepting just `{ agentId }` ([screen-review](pages/screen-review.md)).

## [2026-11-26] build | Remove release version labels from the website
The landing page labels said "v0.1 preview"; they now say "preview" so they don't go stale at the
next release. The "pre-1.0" lines in the getting-started and extensions pages now say "in preview".
The FAQ keeps its "pre-1.0" wording because it describes the condition for a public 1.0.
## [2026-11-26] build | Push follow-up work to an open pull request
After a PR is open, an agent often gets more work and makes new commits or leaves new files. Review
now shows **Push to pull request #n** when the worktree has commits the PR branch lacks
(`WorktreeInfo.unpushed`) or uncommitted files (`WorktreeInfo.uncommitted`), and the Wall tile in
review gets a Push button next to View PR. `git.pushToPr` commits leftover files for the agent
(`Oide-Agent` trailer), pushes the branch, and never opens a PR; it waits while the agent is working.
New telemetry event `pr_pushed` (commit count bucket, whether files were committed first)
([screen-review](pages/screen-review.md), [git-worktrees](pages/git-worktrees.md), [telemetry](pages/telemetry.md)).
## [2026-11-26] decision | Status-only follow-ups return to Ready for review
An agent that had submitted for review showed "Has a question" on the Wall after a follow-up turn that
only reported CI status. The reducer now returns `ready-for-review` when a turn ends without
`submit_for_review`, the agent submitted in an earlier turn, and its final message asks nothing
(`asksUser`). [ADR 0016](../adr/0016-follow-up-turns-return-to-ready-for-review.md); updated
[agent-supervisor](pages/agent-supervisor.md).
## [2026-11-26] review | E2E on main: diagnostics leaked userData, renderer-crash race, macOS keys
Three e2e failures on main. (1) Real bug, all OSes: the Diagnostics App data row only redacted the
home folder, so a userData outside home (`/tmp/…` on Linux, `/var/folders/…` on macOS) or an 8.3
short path on Windows (`C:\Users\RUNNER~1\…`) went into the copyable report raw. The row now shows
`~/…` inside home (after expanding 8.3 names) and `<userData>` otherwise; unit tests cover both
([reliability](pages/reliability.md#startup-diagnostics)). (2) Test race, Linux: the "window
reloaded" check could pass before the kill landed, and the next `executeJavaScript` went to the dying
frame and never settled; the test now waits for `render-process-gone` then `did-finish-load` and caps
each call. (3) Test bug, macOS: Monaco binds save to Cmd+S and end-of-document to Cmd+Down there, so
Ctrl+S / Ctrl+End did nothing; the whiteboard test also relied on the doc test having opened the
Artifacts screen, so it failed on its own retry. It now opens the screen itself.

## [2026-11-26] build | Windows holder scan no longer autoloads PowerShell modules
`folder-holders.test.ts` (integration) and `test/integration/worktree-delete.test.ts` timed out on
every Windows CI run even with the 25 s budget. Cause: the scan script called `Add-Type`, a cmdlet, so
Windows PowerShell autoloaded `Microsoft.PowerShell.Utility`. To do that it analysed every module on
the default PSModulePath, and `Program Files\WindowsPowerShell\Modules` comes before System32 (on the
runner: AWSPowershell, Microsoft.Graph, SqlServer, ...). The cache was cold and the process was killed
at the timeout, so the cache never warmed. Locally, one large module on the path raised `Add-Type` from
about 0.2 s to 1.4 s, while the CodeDom compile stayed at about 0.14 s. The script now compiles its C#
helper through `CSharpCodeProvider`, sets `$PSModuleAutoLoadingPreference = 'None'`, and gets only
`System32\WindowsPowerShell\v1.0\Modules` on PSModulePath. See [reliability](pages/reliability.md).

## [2026-11-26] review | Linux e2e: kill the renderer instead of asking it to crash
The renderer-crash e2e still failed on ubuntu after the race fix: main never saw
`render-process-gone` within 20 s, and `executeJavaScript` to the old frame hung. On Linux,
`webContents.forcefullyCrashRenderer()` does not terminate the process. It sends the renderer an
IPC to crash itself, and a crash signal makes the kernel write a core dump first (piped to apport on
GitHub's Ubuntu runners), so the frozen renderer outlived the poll and the teardown. Windows and
macOS terminate the process directly. The test now kills the renderer with SIGKILL on
`getOSProcessId()`, which dumps nothing and behaves the same on every OS
([reliability](pages/reliability.md#tests)).

## [2026-11-26] review | Ten usability fixes across the renderer
A usability pass over Wall, Focus, Spawn, the command bar, Files, Review, Source control, Settings,
Artifacts and Marketplace found 19 verified issues. Ten were fixed, each in its own files:
Focus artifact popover focus and Esc, Spawn keeping the typed goal and waiting for attachments, real
shortcut hints on the Focus permission prompt, the command bar selection while file results load, the
Focus header Pause/Resume, a retryable Review diff error, the Review send-feedback button, Retry in the
Files tree, unsaved Files edits surviving a screen switch, and confirmations for destructive Settings
actions. Pages: [screen-focus](pages/screen-focus.md), [screen-spawn](pages/screen-spawn.md),
[desktop-shell](pages/desktop-shell.md#command-bar), [screen-review](pages/screen-review.md),
[screen-files](pages/screen-files.md), [screen-settings](pages/screen-settings.md). Still open from the
same pass: scrim clicks discard the New artifact and Add custom extension dialogs, CommitDialog can be
closed mid-commit, Marketplace search is scoped to one category, its drop zone opens a picker, env rows
can't be removed, and Review comment drafts are lost on a stray click.
## [2026-11-26] build | Licence notices identical on every OS
The release run's macOS build failed `pnpm licenses:check` ("THIRD_PARTY_NOTICES.md is stale"): chokidar's
optional `fsevents` dependency is only installed on macOS, so the generator listed one extra package there.
`tools/licenses/notices.mjs` now reads `os`/`cpu`/`libc` restrictions from `pnpm-lock.yaml` and lists such
optional dependencies by name (licence checked where installed). See [packaging](pages/packaging.md).

## [2026-11-26] build | DevModeWatcher test stable on macOS
PR #14's macOS unit tests failed `DevModeWatcher … reloads on change`: the test took the first reload
batch, but FSEvents can deliver the fixture's creation events late, in a batch before the `host.js`
write. The test now waits (up to 5 s) for a batch naming `host.js`, rewriting it every 500 ms in case a
write lands before the stream is live. The watcher itself is unchanged.
## [2026-11-26] build | Direct download links on the site
Release finalize now uploads a version-free copy of every installer (`oIDE-<os>-<x64|arm64>.<ext>`),
so the site's download buttons and the getting-started table link to
`releases/latest/download/<file>` for the visitor's OS instead of the release page. Updated
[docs-site](pages/docs-site.md) and [release-pipeline](pages/release-pipeline.md).
## [2026-11-26] build | Revert uncommitted main-checkout changes from Source control
"Your changes on main" now offers **Revert…** next to Commit…: a confirmation dialog with per-file
checkboxes calls the new `git.discard` IPC command (`@oide/git` `discard()`: tracked files back to HEAD,
untracked files deleted, only paths git reports as changed). New telemetry event `changes_reverted`
(file count bucket, whether all files were picked; never paths). Pages: screen-source-control, telemetry.
## [2026-11-26] build | Push to PR only when there is something to push
Review and the Wall review tile hide Push to pull request when the worktree has no new commits and no
uncommitted files the PR lacks (or the push state is not known yet); `hasPendingForPr` in the git store.
See [Review](pages/screen-review.md), [Wall](pages/screen-wall.md).

## [2026-11-26] review | Auto-update verified against the v0.2.0 release

Checked the first GitHub release (frostlogic-ab/oIDE v0.2.0) end to end: assets, the packaged
Windows zip (`app-update.yml`, compiled feed `publishTarget("frostlogic-ab", "oIDE")`, electron-updater
shipped) and electron-updater's own GitHub provider run against the live repo. Findings and fixes:
v0.2.0 is still a **draft** (the macOS build failed `licenses:check` because `fsevents` installs only
on macOS; finalize never ran), so every client sees no release (fixed on main in `notices.mjs`).
The Windows portable zip carried `app-update.yml` and would have installed a second copy; the updater
now needs the NSIS uninstaller next to the exe. The GitHub publisher writes no `beta*.yml` (beta users
read `latest*.yml` through electron-updater's fallback); docs and config corrected. New finalize gate
`tools/release-feed/verify-feed.mjs`; new telemetry event `update_checked`. Pages: packaging,
release-pipeline, telemetry.

## [2026-11-26] build | "by Frostlogic" subtitle in the header
The header lockup is now the mark beside "oIDE" with a "by [Frostlogic]" subtitle underneath. The Frostlogic
wordmark is traced 1:1 from the company's vector logo into `FrostlogicLogo` (`@oide/ui`) and
`docs/brand/frostlogic-wordmark.svg`. Updated [design-system](pages/design-system.md) and docs/brand/README.md.

## [2026-11-26] review | Second usability pass: drafts, dialogs, Marketplace, Review after merge
Fixed the six issues the first pass left open plus five new ones. Dialogs: Add custom extension and
New artifact close on a scrim press only while untouched (and never from a drag that started inside);
Commit… can't be closed while the commit runs. Marketplace: env rows have a remove button, the
extension box no longer claims to accept drops it can't use, and a search with no match in the
current category shows the matches from the others. Drafts: Review line comments (per file, side,
line, with a draft marker), the Focus composer (per agent, `composerDrafts.ts`) and the Artifacts
Viewer (`draftStore.ts`, reopened on return, Unsaved badge, conflicts through the usual banner) keep
unsent text across screen and target switches. Review goes to Source control after a local merge and
shows "was merged and archived" with Open in Focus for archived agents instead of "This agent is
gone". Settings › Keyboard shortcuts: plain Tab leaves the recorder and focus returns to Change.
Pages: [screen-marketplace](pages/screen-marketplace.md), [screen-artifacts](pages/screen-artifacts.md),
[screen-source-control](pages/screen-source-control.md), [screen-review](pages/screen-review.md),
[screen-focus](pages/screen-focus.md), [screen-settings](pages/screen-settings.md). Still open:
agent toasts have no Open action, Remove worktree and the side-panel Push show no progress, the Wall
sidebar does nothing for a live agent in the Archived view, Marketplace install/update show no
progress text, git status errors have no Retry.

## [2026-11-26] build | Windows CI: three timing-dependent tests made deterministic
The Windows unit-test job failed three tests that pass elsewhere. `artifact-retrieval.test.ts`: the
service's "archive anyway" fallback was armed after 50 ms in `setup()`, which a loaded runner exceeds
mid-test; tests not about the fallback now use an hour. `test/integration/archive.test.ts`: the live
diff refresh is debounced, so the ready-for-review snapshot could hold a one-file diff while the
archive copied the final two-file one; the test now waits for the full diff. `extensions/ui.test.tsx`
exposed a product bug: Settings › Extensions re-synced a field's draft from the saved value in an
effect, so a late load or a `settingChanged` reload overwrote what the user had just typed and blur
saved nothing. The draft now follows the saved value only while the field is unedited (regression
test added). See [extensions](pages/extensions.md).

## [2026-11-27] decision | Remove the Wall's "Next that needs you" button
The header button duplicated the "Needs you" filter chip and the N shortcut; removed it. N still jumps to the next tile that needs you. Updated [screen-wall](pages/screen-wall.md).
## [2026-11-27] build | Worktree folders no longer held open by oIDE itself
User report: when an agent finished, deleting its worktree failed; with oIDE open (no agents)
Explorer could not delete the folder either, and after quitting oIDE it could. oIDE's log showed
almost every failure as `EBUSY: rmdir '…\node_modules\electron\dist\resources\default_app.asar'`.
Cause: Electron's asar support in the main process's `node:fs` treats any `*.asar` file as a folder
and keeps every archive it opens in a never-closed cache, so `fs.rm` of a worktree with
`node_modules` failed on that file and then oIDE kept it open until it quit. Reproduced with the
dev Electron binary (`node:fs` rm → `EBUSY`, and an outside `rmdir` fails while the process lives;
`original-fs` rm succeeds). The holder scan never named oIDE because it excludes its own pid.
- `@oide/git` `plain-fs.ts`: `plainFs` / `plainFsPromises` = Electron's `original-fs` (plain
  `node:fs` outside Electron). Used by `removeTree`, the cleanup queue's retries, `diff.ts`
  (untracked files), Files (tree, read, write) and Files › Search.
- `packages/git/test/plain-fs.test.ts` runs the real Electron binary (skipped when it was not
  downloaded). Folders already waiting in the cleanup queue are removed at the next start.
- Telemetry: no new event; `worktree_delete_failed` / `worktree_delete_retried_ok` already measure it.
Page: [git-worktrees](pages/git-worktrees.md#why-a-worktree-cant-be-deleted-on-windows).
## [2026-11-27] build | Windows: installed oIDE showed a blank taskbar icon
Dev runs set the same AppUserModelID as the installed app (`dev.oide.app`), so Electron's
notification shortcut `Electron.lnk` carried it too, pointing at a worktree's `electron.exe` and
`build/icon.ico`. After the worktree was deleted, Windows drew the installed oIDE's taskbar button
through that orphaned shortcut: a blank page. Unpackaged runs now use `dev.oide.app.dev`, and packaged
Windows runs delete shortcuts with the installed AUMID whose target is gone (or retag live dev ones).
See [packaging](pages/packaging.md).

## [2026-11-27] build | Windows notifications come from oIDE, not Electron
Same root cause as the blank taskbar icon above: Windows names a toast's sender after the Start Menu
shortcut with its AUMID, so a dev `Electron.lnk` holding `dev.oide.app` made the installed app's
notifications come from "Electron". The AUMID split and `releaseForeignShortcuts` fix it; added a test
that the installed AUMID stays equal to electron-builder `appId`. See [packaging](pages/packaging.md).
