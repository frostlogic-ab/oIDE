# Storage (`packages/store`)

Everything oIDE persists: one SQLite database per install, the `.oide/` folder per project, and
the secret store. Source: [../raw/build-brief.md](../raw/build-brief.md), "Data and storage";
decision [ADR 0001](../../adr/0001-node-sqlite-instead-of-better-sqlite3.md). Related:
[artifacts.md](artifacts.md), [protocol.md](protocol.md), [git-worktrees.md](git-worktrees.md),
and the Security and Settings screen pages once written.

## Database

- `openDatabase(file, { migrations?, backupDir?, keepBackups=3 })` → `Database { db, file, version,
  backupPath?, transaction(fn), close() }`. `node:sqlite` `DatabaseSync`, `PRAGMA foreign_keys=ON`,
  `busy_timeout=5000`, WAL + `synchronous=NORMAL` on disk. `':memory:'` for tests.
- Migrations: numbered, in `src/migrations.ts`, append-only, each in its own transaction, recorded
  in `schema_migrations`. Before any pending migration runs on an existing database, a consistent
  copy is taken with `VACUUM INTO <file>.v<old>.<ts>.bak` (last 3 kept). A database newer than the
  build is refused. `transaction()` nests with savepoints.
- `openStore(file)` / `createStore(database)` → `Store { database, projects, agents, subagents,
  events, usage, review, ui, extensions, customServers, settings, close() }`. Main opens
  `<userData>/oide.db` once at startup.
- Every row read back is validated with the protocol Zod schemas (or the store's own for
  store-only shapes). Events that no longer validate read back as `{ type: 'unknown', rawType }`
  so a timeline never breaks.

## Tables (migration 1, plus 2: `review_comments.side`, 3: archived agents, 4: daily usage rollup)

| Table | Contents | Repository |
| --- | --- | --- |
| `projects` | id, name, path, `path_key` (case-folded, unique), trusted, created/last opened | `ProjectsRepo`: `open(path)` (idempotent per folder), `get`, `byPath`, `list`, `setTrusted`, `rename`, `remove` (cascades) |
| `agents` | spec JSON (`AgentSpec`), status, branch, worktree path, base ref, CLI session id, attempt group, latest `AgentSummary` JSON, timestamps | `AgentsRepo`: `insert`, `get`, `list({ projectId, statuses, attemptGroup })`, `update`, `saveSummary`, `summaries`, `remove`, `sessionsSince(ts)` (light rows for Usage; index `agents_created`, migration 4); record type `AgentRecord` |
| `subagents` | per agent + Task id: status, tier, model, times, `SubagentInfo` JSON | `SubagentsRepo`: `upsert`, `list`, `get`, `activeCount`, `countSince(ts)` |
| `events` | agent_id, seq (PK with agent_id), type, ts, normalized `AgentEvent` JSON, raw CLI JSON | `EventsRepo` (below) |
| `event_summaries` | compacted ranges: seq/ts range, counts by type, tools used, tokens, last text/result | `EventsRepo.summaries` |
| `usage_samples` | agent, subagent, ts, model, input/output/cache tokens (kept 90 days) | `UsageRepo`: `add`, `totals({ since, agentId })`, `bySubagent`, `deleteOlderThan`, `compactOlderThan(ts)` (rolls up into `usage_daily`, then deletes), `daily({ sinceDay })` (samples + rollup per local day, project, model) |
| `usage_daily` | per local day number, project id and model (`''` = unknown): summed tokens of samples past retention (migration 4) | `UsageRepo.compactOlderThan`, `UsageRepo.daily`; feeds [screen-usage](screen-usage.md) |
| `review_comments`, `review_viewed` | Review threads and Viewed checkboxes; `side` (`old` for a removed line, `new` default; migration 2) | `ReviewRepo`: `comments`, `addComment({ …, side? })`, `deleteComment`, `takeUnsent` (marks sent atomically), `viewed`, `setViewed` |
| `settings` | the global `Settings` document (key `global`), including `keybindings` (action → combos; only changed actions) | `SettingsService` |
| `ui_state` | small JSON docs; `scope:<window>` holds the project scope | `UiStateRepo`: `scope(window='main')`, `setScope` |
| `artifacts`, `artifact_uses` | artifacts index (meta JSON, folder) and the per-agent uses log | `ArtifactStore` ([artifacts.md](artifacts.md)) |
| `extensions` | `InstalledExtension` JSON | `ExtensionsRepo`: `list`, `get`, `byName`, `upsert`, `remove` |
| `custom_servers` | `CustomServer` JSON saved to "My settings" | `CustomServersRepo` (same API) |
| `secrets` | key, ciphertext BLOB | `SqliteSecretStore` |

### Events

`append(event, raw?)`, `appendDraft(agentId, draft, raw?, ts?)` (assigns seq), `appendMany`,
`page(agentId, { beforeSeq | afterSeq, limit≤5000 })` → `{ events (ascending), hasMore }`, `list()`
(for `agents.events`), `raw(agentId, seq)`, `nextSeq`, `count`. `partial` deltas are never stored.
`compactOlderThan(days=30, now)` turns each agent's older events into one `event_summaries` row and
deletes them; seq stays monotonic across compaction. Archived agents (Wall › Archived) are compacted,
not deleted: only bookkeeping events (`usage`, `context-usage`, `background-tasks`, `plan-usage`,
`stderr`, `unknown`) go into a summary row; the rest stay without their raw JSON, tool output cut to
4,000 characters, so Focus can still show the transcript read-only.

Migration 3 adds `agents.archived_at`, `archive_reason` (CHECK: `merged`, `discarded`, `completed`,
`archived-by-user`) and `merge_commit`, mirrored from `summary.archived` by `saveSummary`.
`AgentsRepo.list({ archived })`, `listArchived({ projectId?, query?, limit, cursor? })` (newest
first, LIKE-escaped title search, total count) and `archivedWorktrees(projectId)`. `list()` reads rows
one by one: an unreadable row is skipped (`skipped`) and a stale summary repaired (`repaired`,
`repairAgentSummary` in protocol) instead of failing the whole list. See
[screen-wall](screen-wall.md#archived-agents).

## Settings (`settings.ts`)

`new SettingsService({ db })`: `get()`, `update(patch)` (deep merge: objects merge, arrays replace,
`null` resets a key to its default; validated with `Settings`, throws `ZodError`), `reset(section?)`,
`onChange(fn) → unsubscribe`, `loadErrors`.

- Defaults (`defaultSettings()`) = protocol defaults + built-in focus presets + built-in techniques,
  from the Settings design:
  - **Cheap**: Sonnet (medium) leads, subagents Haiku (low) (`subagent-model`).
  - **Balanced** (default): Opus (high) leads, routed by task size: simple Haiku (low), standard
    Sonnet (medium), complex Opus (high).
  - **Quality**: Opus (max) for everything (`single`).
  - Techniques (all "end of the agent's first message"): **Adversarial review** (on),
    **Full docs and tests** (off), **Quality gates must pass** (on).
- Built-ins are always present (re-added by id on load, `builtIn: true`); they can be edited and
  reset, not deleted: `savePreset`, `resetPreset`, `deletePreset`, `strategyFor(presetId?)`
  (`custom` = `models.lastUsedStrategy`), `techniques(projectPath?)`, `saveTechnique(t, projectPath?)`,
  `deleteTechnique`, `resetTechnique`.
- A stored document that stops validating is recovered section by section (`loadErrors`).
- Model versions: `models.versions` maps a family to `latest` or a pinned version; protocol
  `resolveModel(alias, versions)` gives what goes to `--model` (`KNOWN_MODEL_VERSIONS` is the
  shipped fallback table).
- `forProject(projectPath, { trusted })` → `EffectiveProjectSettings { settings, config,
  permissions, techniques, extensions, setup?, trusted, errors }`. Workspace trust: untrusted
  projects get no `setup`, no `allow` rules (ask/deny still apply), no default-mode override, and
  their techniques start off. A project can never select Bypass unless Settings > Allow Bypass is on.
  `saveProjectPermissions`, `saveProjectConfig`.

## `.oide/` files (`oide-files.ts`)

`readOideFile(repo, kind)` → `{ value, exists, errors }` for `config`, `permissions`, `techniques`,
`extensions`; never throws (missing → defaults; bad JSON, unsupported `version` or schema errors →
defaults + messages). `readAllOideFiles(repo)`, `writeOideFile(repo, kind, value)` (validated,
pretty, atomic, keeps an existing `$schema` key), `parseOideFile`. Project techniques are forced to
`scope: 'project'`, `builtIn: false`.

JSON Schemas for editors: `packages/protocol/schemas/oide-{config,permissions,techniques,extensions}.schema.json`,
generated with zod v4 `z.toJSONSchema` (input side) by `pnpm --filter @oide/store gen:schemas`. A
test fails when they are stale. The script runs the TS sources with Node's type stripping and a
small `.js`→`.ts` resolve hook (`scripts/register-ts.mjs`).

## Secrets (`secrets.ts`)

`SecretStore { get, set, delete, has, keys(prefix) }`. `new SqliteSecretStore(database, cipher)`
keeps ciphertext in `secrets`; `cipher` is `{ encrypt, decrypt, available? }`, which the desktop
app fills from Electron `safeStorage` (writes refused when encryption is unavailable).
`MemorySecretStore` for tests. Keys are namespaced and validated: `model:<id>`, `ext:<name>:<key>`,
`mcp:<server>:token`, `mcp:<server>:env:<VAR>` (`secretKeys.*` helpers, `deletePrefix`). Claude
credentials are never stored; the namespaces leave no slot for them.

## Credential guard

`test/no-credentials.test.ts` scans source under `apps/`, `packages/`, `extensions/`, `tools/`
(skipping `node_modules`, build output, `docs/`) for the CLI credentials file name, the Claude Code
keychain item, the OAuth block key, and keychain lookups for Claude, and fails the build on a hit.

## Gaps

- No repository for "sessions" separate from agents: the CLI session id lives on the agent row.
- Usage retention (`deleteOlderThan`, 90 days) and event compaction (30 days) are not scheduled here;
  main runs them once at startup ([desktop-shell](desktop-shell.md), Lifecycle).
- `node:sqlite` prints an ExperimentalWarning; main suppresses it (ADR 0001).
