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

## [2026-11-24] build | Custom model env: allow-list instead of denylist (SEC-28)

The SEC-28 denylist missed names (`OPENSSL_*`, `GCONV_PATH`, `LESSOPEN`, `MANPAGER`, `TERMINFO`,
`IFS`, `PS4`, `LUA_*`, `GOOGLE_APPLICATION_CREDENTIALS`), so a custom model's `extraEnv` is now
checked against `MODEL_ENV_ALLOW_LIST` in agent-core (exact names: AWS/Vertex region, project and
profile, `VERTEX_REGION_<MODEL>`, default model ids, `CLAUDE_CODE_SUBAGENT_MODEL`, output and
thinking token limits, `DISABLE_PROMPT_CACHING`). The same check runs at save time in main (clear
`invalid_input` message listing the allowed names) and at launch in `customModelEnv`. An agent's
subagent-model strategy now wins over the model's `CLAUDE_CODE_SUBAGENT_MODEL`. Pages updated:
security, review-security.

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
