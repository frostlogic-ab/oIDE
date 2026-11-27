# Review: brief conformance and milestone gates

Adversarial review of oIDE against [raw/build-brief.md](../raw/build-brief.md), done on 2026-11-24
(Windows 11, Node 24, Electron 45.4.1, real Claude Code CLI 2.1.325). It checks each table in the
brief against the code, runs every gate that can run on one machine, and drives the real Electron app
against `tools/fake-claude`. No product code was changed. Related: [milestones](milestones.md),
[review-security](review-security.md) (security findings are not repeated here),
[review-design](review-design.md), [cli-integration](cli-integration.md), [testing](testing.md).

Tests added: [`test/conformance/real-cli.test.ts`](../../../test/conformance/real-cli.test.ts) (the M1 gate
against the real CLI; opt-in with `OIDE_REAL_CLI=1`, uses `haiku`) and
[`test/conformance/review-merge.test.ts`](../../../test/conformance/review-merge.test.ts) (blocker B1,
marked `it.fails` until fixed).

## Gate results

| Gate | Result | Evidence |
| --- | --- | --- |
| M0 build | pass | `pnpm --filter @oide/desktop build` exit 0. The Monaco chunk `setup-*.js` is 8.1 MB. |
| M0 typecheck | pass | `pnpm typecheck`: 13/13 tasks. |
| M0 lint | pass | `pnpm lint`: 0 errors, 2 warnings (`TechniquesSection.tsx:60` ref in cleanup, `store/test/repos.test.ts:3` type import). |
| M0 unit and integration | pass | `vitest run`: 55 files, 402 tests passed, 19 s. |
| M0 e2e | pass | `pnpm --filter @oide/desktop e2e`: 9/9 passed, no console errors. |
| M0 packaging | pass (Windows `--dir` only) | `electron-builder --dir --x64`: `win-unpacked\oide.exe`, fuses applied, unsigned. The packaged exe launched: window title `oIDE`, `oide.db` in WAL mode in userData, built-in extensions (git, themes, browser-preview) loaded, bundled marketplace index served, fake-claude agent reached `needs-permission`. Playwright `_electron.launch` cannot attach to the packaged exe because `enableNodeCliInspectArguments` is off (expected), so it was driven over CDP. NSIS installer, macOS and Linux were not built here. |
| **M1 with the real CLI** | **pass** (services layer) | See below. |
| M2 (fake-claude, real app) | pass with gaps | 6 agents across 2 projects: Max running 3 kept 2 queued, then started them. Routed subagents showed chips, the subagent permission prompt, the timeline and the token share (43%). Gaps: m1, M3. The gate itself (six agents for a working day) was not run. |
| **M3 (fake-claude, real app)** | **fail** | Spawn, permission, Review diff, then "Merge worktree into main locally": the toast says "Merged oide/add-feature into main", but `main` still has only `init` and no `feature.txt`. See B1. |
| M4 to M6 | not demonstrated | No test or real-app flow shows an agent using an extension tool installed from the index (M5), or an agent reading a design artifact and writing a doc artifact (M6). Unit tests cover the parts. |

### M1 with the real `claude` 2.1.325 (detail)

This used `test/conformance/real-cli.test.ts`: the plain-Node services layer (`createCoreServices`, the
real IPC router) with no `cliPathOverride`, a throwaway git repo, and `--model haiku` in Manual mode
(`default`). The whole run took 18 s for 2 short turns. Timeline:

1. `cli.detect` found `%USERPROFILE%\.local\bin\claude.exe`, version 2.1.325, `inTestedRange: true`, `mode:auto` available.
2. `agents.spawn` returned status `queued`, then `starting`. A worktree was created under `<userData>/worktrees/<project>/real-cli-probe`.
3. After 6.5 s the status was `needs-permission`, with a pending prompt `{toolName: "Bash", input.command: "node -e \"console.log(6*7)\"", summary: "Run node -e …"}` that came from `mcp__oide__permission_prompt`.
4. `agents.answerPermission` sent `allow` for that exact request id. Next came `permission-resolved`, then `tool-result` with content `42` ("Shell cwd was reset to …worktree"), then `assistant-text` "The command printed 42.", then `result`. The status became `has-question`, as expected: the agent did not call `submit_for_review`, and the goal did not ask it to.
5. `agents.stop` set the status to `stopped`. The session id stayed `b36b5b67-…`.
6. Restart: services were disposed, then a new services instance was opened on the same userData. The agent was restored as `stopped` with the same session id and its 17 stored events.
7. `agents.send` "What number did that command print earlier?" respawned the agent with `--resume` (`queued`, `starting`, `running`, `init`). It replied `42` from the earlier turn, with the same session id. Final status `has-question`.

Not covered with the real CLI: Stop in the middle of a turn (interrupt), auto-resume of a *working*
agent after a crash or quit, Shift+Tab, and `/compact`. fake-claude tests cover all of these, and
[cli-integration](cli-integration.md) documents the real shapes. Sign-in was already done, so the
signed-out path was not exercised.

### Real app walkthrough (fake-claude, `out/main/index.js`, temp userData)

Every screen loaded real data, with **0 console errors or warnings** across six runs. No mock or design
sample data appears in the real app: `lib/mock` is imported only behind `import.meta.env.DEV && !window.oide`,
and no fixture names showed up.

- **Wall**: tiles for permission, review, question, setup and running agents worked. Inline Allow once and
  Always worked, as did the subagent chips with a summary ("1 needs you"), the filter chips and the context ring.
- **Focus**: the agent tree showed the lead and its subagents, and subagent cards had Open and Stop. The inspector
  had Plan, Subagents (timeline, token share), Changes, Artifacts and Terminal (pty in the worktree). The pinned prompt
  had Y and D, and the composer had replies and `/compact` with the confirm dialog (the compact lifecycle was rendered).
  Raw terminal also worked.
- **Source control**: project cards had sync, push, agent worktrees with status, PR state "Ready to open",
  Review, recent commits, and the Ready to review panel. While the data loads, the cards show "0 agent worktrees" and
  "No commits yet" (m2).
- **Review**: the changed files, unified diff, Viewed, agent summary and checks, Send feedback, Open pull request and
  Merge all rendered. Merge is wrong (B1), and the toasts cover the action buttons (M2).
- **Files**: per-project trees with worktree menus, Monaco read, history with attribution, Mentioned in.
- **Artifacts**: grid, kinds, personal and repo scope, detail, history v1, Give to an agent, Import.
- **Marketplace**: "index unavailable" and 0 installed when the app is launched as `electron out/main/index.js`
  (M4). In the packaged build it works.
- **Settings**: every section rendered with real values (CLI path and version, presets, max running, techniques,
  permissions, projects, artifacts and claude.ai).

## Traceability matrix

Legend: **done**, **partial**, **mocked-only** (renderer only, with no main data source), **missing**, **wrong**.
Paths are relative to the repo root.

### How each Spawn and tile control maps to the CLI

| Brief row | Status | Implementation |
| --- | --- | --- |
| Goal + first-message techniques | done | `packages/agent-core/src/args.ts` `buildLaunch` (first message, Settings order) |
| System-prompt techniques | done | `args.ts` `--append-system-prompt` (oIDE contract + techniques) |
| Modes Manual / Edit / Plan / Bypass | done | `args.ts` `cliPermissionMode`; Bypass guard in `args.ts`, `supervisor.ts`, `services/agents.ts` |
| Auto (default) | done | `--permission-mode auto`, fallback `default` when help lacks it (`cli.ts` `parseHelpFeatures`) |
| Shift+Tab | done | `supervisor.ts` `setMode` (control request, fallback interrupt + `--resume`); keymap in `renderer/lib/keymap.ts` |
| Model per agent, pinning | done | `--model` alias or id; versions table in settings |
| Effort per slot | done | `--effort` when `features.effort` |
| Strategy one model | done | `args.ts` |
| Separate subagent model | done (guess kept) | `CLAUDE_CODE_SUBAGENT_MODEL` in `args.ts` |
| Routed by task size | done | `routedAgents` → `--agents`; contract text tells the lead to route |
| Your models | done | `customModelEnv`; key from `SqliteSecretStore` (safeStorage cipher) |
| Permission prompt Y / Always / D | done (**verified with the real CLI**) | `packages/mcp-server/src/server.ts`, `supervisor.answerPermission`, tile and Focus prompts |
| "Always in oide" | done | `addAllowRule` → `.oide/permissions.json` → `--allowedTools` (integration test) |
| "Asks first" tools never pre-allowed | done | `args.ts` `askTools` filter |
| Reply, review feedback, attach artifact | done | `messages.ts`, `review.sendFeedback`, Composer Attach artifact |
| `/compact` after confirm | done | `CompactDialog.tsx` (Wall and Focus); verified in the real app |
| Stop | done (**real CLI**) | `supervisor.stop` |
| Pause | done | `supervisor.pause` and `resume` (unit test) |
| Resume after restart | done (**real CLI**) | `AgentsService.restore`, `--resume <sessionId>` |
| Parallel attempts | done | `attempts` + `attemptGroup` in `supervisor.spawn` (seen: 4 attempts) |

### Status, tiles and the Plan tab

| Row | Status | Notes |
| --- | --- | --- |
| Queued | done | The queue works; a queued spawn publishes its summary right away (m1, fixed). |
| Running / Needs permission / Has a question / Ready for review | done | `reducer.ts`; all four seen in the real app |
| Error / Paused by plan limit | done | `supervisor.test.ts` (crash exit code, rate limit, no retry) |
| Activity lines, Thinking / Writing | done | `TileBody.tsx` from tool-use and partial events |
| Diff counts (`git diff --numstat`, debounced) | done | `services/git.ts` `scheduleDiff` |
| Plan tab (todo list, plan-mode text) | done | `reducer.ts` handles TodoWrite and ExitPlanMode; `Inspector.tsx` |

### Subagents

| Row | Status | Notes |
| --- | --- | --- |
| Existence, name, task | done | `packages/agent-core/src/subagents.ts` |
| Model, effort, route tier | done | `subagentTiers` |
| Own transcript by parent id | done | `--forward-subagent-text`, verified in [cli-integration](cli-integration.md) |
| Status incl. needs permission and queued | done | Permission attributed through the subagent's tool_use id |
| Report to the lead | done | Focus subagent card |
| Tokens, own ring, token share | done | Seen in the real app: "43% of this agent's tokens" |
| Timeline | done | Focus › Subagents |
| Stop subagent | done (fallback) | `supervisor.stopSubagent` denies the next tool call |
| Steering goes to the lead only | done | |

### Projects and git worktrees

| Row | Status | Notes |
| --- | --- | --- |
| Create worktree `oide/<slug>` outside repo | done | `packages/git/src/worktrees.ts`; location setting |
| `.oide/setup` as a tile step | done | Trusted projects only (`services/agents.ts`) |
| Project folder: one agent, no Bypass | done | `services/agents.ts` `spawn` |
| Diff = merge-base…HEAD + uncommitted | done | `packages/git/src/diff.ts` |
| Finish: Open PR | done | `gh` is called from main (`packages/git/src/gh.ts`), not "through the Git extension": [ADR 0006](../../adr/0006-pull-requests-through-gh-from-main.md). Disabled, with a reason, for a repo with no remote (m6, fixed). |
| Finish: Merge locally | **wrong** | B1 |
| Conflicts handed to a new agent | done | Review SummaryPanel conflicts → reconcile |
| Cleanup schedule + startup prune + orphans | done | `services/core.ts`, `services/git.ts` `sweepMerged`. Cleanup "Right away" deletes work (B1). |
| Files worktree switcher, agent-editing banner | done | `EditTracker` + Files `TreePanel` |
| Windows long paths | done | `core.longpaths` in `packages/git/src/git.ts` |

### Project scope and Source control

| Row | Status |
| --- | --- |
| Shared scope store (Wall, Files, Source control) | done (`stores/scope.ts`, `scope.get` / `scope.set` persisted) |
| Sync state, Push / Pull, background fetch (setting) | done |
| Your changes on main + Commit dialog | done (`CommitDialog.tsx`, `git.commit`) |
| Agent worktrees (ahead / behind, status, files) | done |
| PR state via `gh pr view` | done |
| Review button + Ready to review panel | done |
| Recent commits with `Oide-Agent:` attribution | done |
| Overlap heads-up + `merge-tree` | done (`packages/git/src/overlaps.ts`, `merge.ts`) |
| Ask an agent to reconcile | done (`git.reconcile`) |
| Unpushed notice | done |

### Screen by screen

| Screen | Status | Notes |
| --- | --- | --- |
| Wall | done | Real data. m1 and M3 fixed. |
| Focus | done | Real data; virtualized, paged history |
| Spawn | done | Builds `AgentSpec`; presets and techniques from settings |
| Source control | done | Loading state while git answers (m2, fixed) |
| Review | partial | Merge is wrong (B1). Toasts no longer cover the actions (M2, fixed). Comments on removed lines keep their side. |
| Files | done | Language servers from extensions: built since (ADR 0019, superseding the deferral in ADR 0008) |
| Artifacts | partial | Whiteboard is a read-only SVG render, not an embedded editor ([ADR 0005](../../adr/0005-whiteboard-read-only-render-in-v1.md)). claude.ai stays manual import (as briefed). |
| Marketplace | done (packaged) | Not available in e2e-style launches (M4) |
| Settings | done | Extension `settings` fields in Settings › Extensions (M1 fixed) |
| Status bar | done | Counts are live from the agents and projects stores; `usage.summary` (tokens today) refreshes on agent and project events, no polling (M3, fixed). Plan meters come from `rate_limit_event` utilization: [ADR 0007](../../adr/0007-plan-usage-meters-from-rate-limit-events.md). |
| Command bar | done | Core and extension `commands` |

### Data and storage

| Row | Status | Notes |
| --- | --- | --- |
| `oide.db` SQLite WAL, tables, raw events, 30-day compaction | done | `packages/store/src/db.ts` (WAL), `migrations.ts`, `events.compactOlderThan(30)` |
| Backup before migration | done | `openStore(..., { backupDir })` |
| `.oide/config.json`, `techniques.json`, `permissions.json`, `extensions.json` + version + JSON Schema | done | `packages/store/src/oide-files.ts`, `scripts/gen-schemas.ts` |
| `.mcp.json` with `${VAR}` placeholders | done | `extension-host/src/custom-tools.ts` |
| `.oide/artifacts/` vs app data | done | `packages/store/src/artifacts.ts` |
| Keychain via safeStorage | done | `SqliteSecretStore` + `platform.cipher` |
| `<app-data>/agents/<id>/` deleted with agent | done | `unregisterAgent` removes the whole folder (m5, fixed) |

### Contribution points (v1)

| Point | Status | Notes |
| --- | --- | --- |
| `mcpServers` with risk labels | done | `extension-host/src/mcp-config.ts`, `args.ts` |
| `commands` | done | `coreCommands.ts`, `extensions.runCommand` |
| `panels` (sandboxed iframe + postMessage) | done (fixed 2026-11-24) | `oide-ext://` protocol (`services/extension-ui.ts`), `ExtensionFrame` in Focus's inspector and the `extension` screen, validated bridge (`extensions/panelBridge.ts` → `extensions.panelMessage` → host). E2E: `e2e/extensions.spec.ts` |
| `settings` (fields in Settings, secret → keychain) | done (fixed 2026-11-24) | Settings › Extensions (`extensions/ExtensionSettingsSection.tsx`, `extensions.settings` / `setSetting`); secrets never cross IPC |
| `themes` | done (fixed 2026-11-24) | Settings › Appearance lists contributed themes; `applyTheme` sets allow-listed tokens |
| `techniques` | done (fixed 2026-11-24) | Merged by main into `settings.techniques` and the supervisor (Spawn), read-only in Settings › Techniques |
| `artifactTypes` | done, with ADR 0009 (2026-11-24) | Typed artifacts (`ArtifactMeta.type`) open in the extension's viewer iframe; storage stays one of the three kinds |
| `languages` | deferred, ADR 0008 (2026-11-24) | Parsed and shown in the first-run consent; no process |
| `deployTargets` | done (fixed 2026-11-24) | Review summary actions (`extensions/DeployActions.tsx` → `extensions.runDeployTarget`) |

### Security bullets

Covered in depth by [review-security](review-security.md). Spot checks here: the window options are hardened
(`main/index.ts`), CSP is set, the fuses `runAsNode`, `enableNodeOptionsEnvironmentVariable` and
`enableNodeCliInspectArguments` are off, IPC is Zod-validated with output validation, and permission answers
need the exact id (integration test plus real CLI). `OIDE_E2E_TRUST` is ignored when packaged. Dependabot is configured in `.github/dependabot.yml` (Supply chain, m8, fixed). Auto-update (`electron-updater` is a dependency but never
used) is M7 scope.

## Prioritized gaps

### Blocker

- **B1. "Merge worktree into main locally" drops uncommitted work and reports success.**
  `apps/desktop/src/main/services/git.ts` (`mergeLocal`) and `packages/git/src/merge.ts`. Review shows
  committed plus uncommitted changes (correct per brief), but the merge runs `git merge --no-ff <branch>` on
  commits only. When the agent left its change uncommitted (fake-claude's `review` scenario; a real agent
  that skipped the contract's commit), git says "Already up to date". oIDE then returns `ok`, the UI toasts
  "Merged oide/add-feature into main", and with cleanup **Right away** it force-removes the worktree, so the
  change is lost. Reproduced in the real app and in `test/conformance/review-merge.test.ts` (2 `it.fails`).
  Expected (brief, Projects and git worktrees › Diff and Finish): merge exactly what Review showed. Either
  commit the worktree's pending changes first, with an `Oide-Agent: <name>` trailer, or refuse with "N
  uncommitted files: commit them or ask the agent to" and offer that action. Report `ok` only when HEAD on main
  changed. Never remove a worktree that has uncommitted or unmerged changes. Flip the two `it.fails` to `it`.
  **Status (2026-11-24): fixed.** `GitService.mergeLocal` commits pending worktree changes first (subject from
  the review summary or the title, `Oide-Agent:` trailer); `mergeLocal` in `packages/git/src/merge.ts` reports
  ok only when HEAD moved ("Nothing to merge" otherwise); cleanup runs only when the branch is an ancestor of
  main's HEAD and the worktree is clean. Both tests in `review-merge.test.ts` are `it`.

### Major

- **M1. Extension UI contribution points are not wired.** *Fixed 2026-11-24: see Contribution points
  above and [extensions](extensions.md#ui-contributions); `languages` deferred by ADR 0008.* Original finding:
  `panels`, `themes`, `techniques`,
  `artifactTypes`, `languages` and `deployTargets` are parsed but never reach the product. Extension `settings`
  have storage but no fields. Files: a panel host (sandboxed `<iframe sandbox="allow-scripts">` + `postMessage`
  bridge to `panels.postMessage`) in `renderer/src/screens/Focus/components/Inspector.tsx` and a full-screen route;
  theme tokens applied from `extensions.installed` in the renderer frame; extension techniques merged in
  `packages/store/src/settings.ts` → Spawn and Settings › Techniques; extension settings fields in
  `screens/Settings`; `deployTargets` as Review actions in `screens/Review/SummaryPanel.tsx`; `languages` and
  `artifactTypes` per the brief, or an ADR deferring them. Expected: brief, Contribution points (v1).
- **M2. Toasts never expire, go stale, and cover primary actions.** **Fixed 2026-11-24**: info and success
  toasts leave after 5 s, warnings after 10 s, errors stay with Dismiss; repeats dedupe (×N); at most 3;
  hover or focus holds one; a needs-permission toast is removed when its prompt resolves (`notify.kind` +
  `requestId`, `retireStaleToasts`); they sit bottom-left above the status bar, in a polite live region.
  Original finding: `renderer/src/components/frame/Toasts.tsx`,
  `stores/ui.ts`. The "Add feature needs permission" toast stayed after the prompt was answered, and the toasts
  sat over Review's "Open pull request" and "Merge worktree into main locally", intercepting clicks. In practice
  Playwright could not click Merge until it dismissed them. Expected: info toasts auto-dismiss; a needs-permission
  toast is removed when that request resolves; toasts never cover the Review action column (offset them, or put
  them in a corner that does not hold actions).
- **M3. The status bar is stale.** **Fixed 2026-11-24**: counts come from the live stores; `usage.summary` is
  refreshed (debounced 2 s) on `agents.summary`, `agents.removed` and `projects.changed`, plus once after local
  midnight; the 15 s poll is gone (`lib/boot.ts` `connectUsage`). Original finding: `renderer/src/lib/boot.ts` polls `usage.summary` every 15 s, so
  "0 sessions · 0 worktrees · 0 subagents active · 0 projects open · Tokens today 0" showed while agents ran
  (screenshots of Wall, Focus and Review). Expected (Screen by screen › Status bar): counts derived live from the
  agents, projects and subagent stores, plus `usage.summary` on `agents.summary` and `projects.changed` events.
- **M4. When the app is launched as `electron out/main/index.js` (e2e, CI), built-in extensions and the bundled
  index are not found.** `apps/desktop/src/main/services/electron-platform.ts:50` computes
  `repoRoot = resolve(app.getAppPath(), '..', '..')`, and `getAppPath()` is `out/main` in that launch mode. The
  real app shows "Could not load the marketplace: index unavailable" and 0 installed. The packaged build is fine.
  This makes every e2e test of M5 hollow. Expected: resolve the repo root from `import.meta.dirname`
  (`out/main` → `../../../..`) or from an env set by electron-vite, and add an e2e check that the 3 built-ins are installed.
  **Status (2026-11-24): fixed.** `devRepoRoot` walks up from `app.getAppPath()` to the folder with
  `pnpm-workspace.yaml` (unpackaged builds only). `e2e/agents.spec.ts` checks that at least 3 built-ins are
  installed and the bundled index lists entries.
- **M5. The M5 and M6 gates have no end-to-end proof.** Expected per Milestones: a fake-claude scenario where the
  agent calls an extension tool installed from the (bundled) index through `--mcp-config`, and one where it calls
  `mcp__oide__artifacts_read` on a design and `artifacts_create` for a doc that the user then edits. Add them in
  `test/integration/` and the e2e suite (`tools/fake-claude/bin/fake-claude.mjs` needs scenarios that call MCP tools).

### Minor

- m1. **Fixed.** Queued agents do not get an `agents.summary` until they start. `supervisor.spawn` emits `status: queued`,
  which leaves the summary unchanged, so it never publishes. Spawns that do not come from the Spawn screen
  (IPC, extensions) are missing from the Wall: it showed "All · 4" while 6 agents existed. Fix:
  `publishSummary` in `packages/agent-core/src/supervisor.ts` `spawn`.
- m2. **Fixed** ("Loading agent worktrees…", "Loading commits…"). Source control shows "0 agent worktrees" and "No commits yet" while it loads (about 1 s with 6 worktrees).
  It should show a loading state (`screens/SourceControl/ProjectCard.tsx`, `gitStore.loading`).
- m3. **Fixed** (the provider calls `runSetup`'s `onStart` only when a setup command runs). Every launch emits `starting` with the detail "Setup: running .oide/setup", even when the project has no
  `.oide/setup` (seen on tiles for repos without one). Only emit it when a setup command exists
  (`packages/agent-core/src/supervisor.ts` `launch` / `services/agents.ts` `runSetup`).
- m4. **Fixed** (`backend: 'windows'` on win32). The packaged app prints `'watchman' is not recognized` on stderr. `@parcel/watcher` probes watchman
  through cmd; pick the `windows` backend explicitly (`services/git.ts` `parcelWatch`).
- m5. **Fixed.** `<app-data>/agents/<id>/` is not deleted with the agent; only `mcp.json` is (`packages/mcp-server/src/server.ts` `unregisterAgent`).
- m6. **Fixed** ("This project has no git remote…"). `git.prAvailable` is true for a repo without a remote, so "Open pull request" is enabled and can only fail.
- m7. **Fixed** with ADRs [0005](../../adr/0005-whiteboard-read-only-render-in-v1.md), [0006](../../adr/0006-pull-requests-through-gh-from-main.md), [0007](../../adr/0007-plan-usage-meters-from-rate-limit-events.md). The Whiteboard is a read-only SVG render, not the embedded Excalidraw editor the brief lists. The Viewer
  comment admits it; an ADR is needed. PRs bypass the Git extension and the plan meters are shown; both need ADRs.
- m8. **Fixed** (`.github/dependabot.yml`). There is no Dependabot or Renovate config (brief: Security › Supply chain).
- m9. **Fixed.** Lint warnings in `TechniquesSection.tsx:60` and `packages/store/test/repos.test.ts:3`.
- m10. The packaged app honours `OIDE_CLAUDE_PATH`, `OIDE_USER_DATA` and `--remote-debugging-port`. The last one
  lets any local process drive `window.oide` over CDP. Over to [review-security](review-security.md).

Counts: **1 blocker, 5 major, 10 minor.** Fixed on 2026-11-24 (Conformance UX fixes): M2, M3, m1 to m9.
m10 stays with [review-security](review-security.md).

Also done in that change (UX items outside the numbered list): Settings › Keyboard shortcuts rebinding (record,
conflict warning, reset; saved in Settings `keybindings`), Focus's `/` menu from the CLI's `init.slash_commands`,
a note on the tile and in Focus when a prompt was cut off by quitting (`permission-resolved.reason: 'quit'` →
`AgentSummary.interruptedPermission`), and review comments that keep their diff side (`ReviewComment.side`).

## Final pass (2026-11-25)

The last adversarial check after every wave-4 branch was merged (main at `b285e95`, plus the fixes
below). Method: `pnpm --filter @oide/desktop build`, then the real Electron app (`out/main/index.js`)
driven by Playwright with a temp userData, `OIDE_CLAUDE_PATH` = fake-claude, `OIDE_E2E_TRUST=trust`,
`OIDE_E2E_CONFIRM=accept` and `OIDE_E2E_OPEN_PATHS` listing three temp repos: `web-app`; `api-server`
with committed `.oide/config.json` (Plan, Cheap), `techniques.json` and `permissions.json`; and
`docs-site`. Every screen was shot at 1440×900 and the main ones at 1100×700, read back, and compared
with the canvas renders from [review-design](review-design.md). The screenshots are in the session
scratchpad (`scratchpad\final\*.png`), not in the repo.

### What was verified, per screen

| Screen | Verdict | Checked |
| --- | --- | --- |
| Wall | pass | 8 agents across 3 projects: permission, ready for review, has a question, routed subagents with a subagent prompt, and an error. Filter chips. J/K/N move focus, and N skips to the agents that need you. Inline Allow once, Y on a focused tile, the reply box, subagent chips with "1 needs you", and live counts in the status bar and header. Matches `Main.dc.html` |
| Spawn | pass | Project defaults come from `.oide/`: Plan, Cheap, and the repo's technique shown and on. Switching to another project goes back to Auto and Balanced and drops that technique. Presets, Advanced techniques, Parallel attempts (the button reads "Spawn 2 agents") and Ctrl+Enter work. Matches `Spawn.dc.html` |
| Focus | pass (fixed) | Transcript with subagent cards and the agent tree. The subagent view shows task, model, route, its own context ring and Stop subagent. The pinned subagent prompt was answered with Y. Inspector tabs: Plan, Subagents (timeline, 43% token share), Changes, Artifacts, Terminal (a pty in the worktree) and **Preview** (the Browser preview panel in a `sandbox="allow-scripts"` `oide-ext://` iframe). Also checked: the `/` menu built from the CLI's slash commands, and the `/compact` confirm and compact lifecycle. Matches `Focus.dc.html` |
| Source control | pass (fixed) | Cards per project, the scope switcher, and agent worktrees with status and +/−. The overlap heads-up said "Add feature flag and Rework feature flag both edit feature.txt" and offered Ask an agent to reconcile. Ready to review panel, the Commit on main dialog and Push. Matches `SourceControl.dc.html` |
| Review | pass | Changed files, unified diff, Viewed, the agent's summary and checks. An inline comment went through Add to feedback and Send feedback; the agent got it and the comment was marked sent. Open pull request is disabled with the no-remote reason. Merge confirm put `Merge oide/add-feature-flag` on main, **and the user's uncommitted README edit stayed in the main checkout**. Matches `Review.dc.html` |
| Files | pass | Per-project tree with the worktree menu and agent dots, Monaco, history with agent attribution, and the agent banner ("You're viewing the worktree of Write output, which is changing this file"). Typing `jknyd` in Monaco, or J/N in Excalidraw, fires no shortcut |
| Artifacts | pass (fixed) | Created a design (repo), a doc (personal) and a whiteboard. Excalidraw draw and Save made v2; Compare showed v1→v2. A doc edit in Monaco with Ctrl+S made v2, and Preview rendered it. Rename and Delete (with confirm) work. An agent's `artifacts_write` on an open design showed "Updated by Update landing agent · v2" live; History lists `2:agent`, and Agents using it shows read and write |
| Marketplace | pass (fixed) | The 3 built-ins show under Installed, Agent tools, Themes and Views & panels (from the bundled index). Add custom: the URL route reports "Could not reach it", and Found on this computer lists the real configs on this machine (read only). Local command → Test it lists `echo` (read only) and `wipe` (asks first) from the server's own hints; Add tool, after the confirmation, puts it in the Custom list with "not reviewed". The bundled index holds only built-ins, so third-party install consent is covered by `test/gates/m5-extension-tool.test.ts`, not by this walk |
| Settings | pass (fixed) | All 13 sections render real values: Claude Code, Models, Agents, Techniques, Permissions (project rules from `.oide/`), Projects, Artifacts & claude.ai, Extensions (Browser preview default URL), Keyboard shortcuts, Appearance (accent from Accent themes), Privacy, Updates (off in dev builds) and Diagnostics (CLI, git, gh, Node, keychain, database, MCP port, logs) |

Console: 0 errors and 0 warnings across the second full session. The first session's only errors were
`Failed to fetch dynamically imported module`, after another agent rebuilt `apps/desktop/out` under
the running app and the lazy chunks got new hashes. That is not a product bug; the walk was rerun from a
private copy of the build. No mock or canvas sample data is in the production bundle: `lib/mock` is
behind `import.meta.env.DEV && !window.oide`, and the only matches for sample names are code comments.

**Real CLI (M1):** `OIDE_REAL_CLI=1 vitest run test/conformance/real-cli.test.ts` with Claude Code
2.1.325 and `haiku` passed 1 of 1 in 16 s: spawn, prompt answered in oIDE, stop, restart, `--resume`.

### Fixed in this pass

| # | Severity | Finding | Fix and test |
| --- | --- | --- | --- |
| F1 | major | Parallel attempts with a long title failed. The slug is cut at 40 characters, so `#1` and `#2` produce the same slug, and two concurrent `git worktree add -b` calls raced. One attempt failed with "cannot lock ref … reference already exists" | `WorktreeManager.create` now runs one at a time per project (`packages/git/src/worktrees.ts`), so the free-name check sees the other attempt's branch and picks `-2`, `-3`. Test: `packages/git/test/worktrees.test.ts` "parallel creates". Checked again in the app: 3 attempts got 3 branches |
| F2 | major | SEC-24 gap: `--header "Authorization: Bearer …"` args (mcp-remote style, from a real config on this machine) reached Add custom › Found on this computer unmasked | `redactArgs` masks header-shaped args whose name looks secret (`packages/extension-host/src/import-scan.ts`). Test in `import-scan.test.ts`; noted under SEC-24 in [review-security](review-security.md) |
| F3 | minor | The New artifact dialog kept the previous "Personal" choice and project, because it stays mounted. Picking a project after "No project" also left it on Personal. Either way a repo artifact was silently saved to app data | The dialog resets from the current scope each time it opens, and picking a project defaults to the repo (`screens/Artifacts/Dialogs.tsx`). Tests in `Artifacts.test.tsx` |
| F4 | minor | Focus inspector: the extension "Preview" tab sat past the panel edge. The tab row needs 361 px, the panel is 300–320 px, and the scrollbar was hidden | The tab row wraps when extension panels add tabs (`Inspector.tsx`). Checked at 1440 and 1100 |
| F5 | minor | Needs-permission toasts repeated prompts already on screen. At 1100×700, three of them covered the third tile's Allow and Deny buttons | No needs-permission toast while the Wall (in scope) or that agent's Focus is showing (`promptOnScreen` in `stores/ui.ts`, wired in `lib/boot.ts`). Test in `stores/ui.test.tsx`. `e2e/toasts.spec.ts` now spawns from Artifacts and answers on the Wall |
| F6 | minor | Push on a repo with no remote ("Not on a remote yet") failed with git's "Could not read from remote repository" | `GitService.push` now says "<project> has no git remote to push to…". Integration test in `main-services.test.ts` |
| F7 | minor | Settings › Claude Code said "CLI found and signed in" while sign-in was still unknown | It says "CLI found" until the CLI reports a sign-in. Test in `Settings.test.tsx` |
| F8 | cosmetic | Source control rows with no changes read "0 files ·" | The separator shows only with +/− counts. Test in `SourceControl.test.tsx` |

Tooling: fake-claude has a new `artifact-update` scenario that reads the `{"id":"…"}` artifact and
writes a new version, to drive the agent-written update flow ([testing](testing.md#fake-claude-toolsfake-claude)).

### What remains

- **Minor.** Unpackaged launches (dev, e2e) show Electron's version (45.4.1) as oIDE's in Settings ›
  Updates and Diagnostics, because `app.getVersion()` finds no `package.json` next to `out/main`.
  Packaged builds show the right version.
- **Minor.** An agent that errors before its worktree exists shows "project folder" in the tile's
  meta line, though it never had one.
- **Minor.** Clicking the current rail item while an artifact is open does not go back to the grid
  (the viewer's own "Artifacts" button does).
- **Cosmetic.** The Focus header cuts the worktree name first ("worktree …") when the status text
  is long; the full name is in its tooltip.
- **Cosmetic.** The artifact viewer is a named `<section>` (a region landmark), where other screens use
  `<main>`.
- **Not exercised here.** Third-party install consent from a remote index (only the bundled index of
  built-ins exists; the M5 gate test covers it), OAuth for remote MCP servers, Open pull request
  against a real GitHub remote, and the M1 flow clicked through the Electron UI with the real CLI
  (the services-layer gate passes).

### Gates at the end of the pass

`pnpm typecheck` (13 of 13) and `pnpm lint` pass with no warnings, `pnpm wiki:lint` reports ok, and
`pnpm --filter @oide/desktop e2e` builds the app and passes 25 of 25. Full vitest passes 693 of 698,
with 2 skipped. The 3 failures (`test/gates/m4-oide-portable.test.ts` ×2 and
`m5-extension-tool.test.ts`) say "No marketplace index: none is bundled and no index URL is set". They
come from another agent's uncommitted `indexUrl` / `distribution.ts` change, which was in the working
tree at the time; committed code does not cause them.
