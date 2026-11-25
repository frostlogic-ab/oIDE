# Reliability and diagnostics

How oIDE stays up when something breaks, and how a user (or a bug report) finds out what broke.
Code: `apps/desktop/src/main/reliability/` (plain Node, unit-tested), wired in `src/main/index.ts`,
`services/core.ts` and `services/agents.ts`; renderer pieces in `components/ErrorBoundary.tsx`,
`lib/errorReport.ts`, `stores/extensionHosts.ts` and Settings › Diagnostics. Related:
[desktop-shell](desktop-shell.md), [agent-supervisor](agent-supervisor.md), [extensions](extensions.md),
[storage](storage.md), [security](security.md) (redaction, crash reports), [testing](testing.md).

## Crash isolation

The main process owns agents, worktrees, the database and the extension host (build brief,
"Process model"). The renderer only draws, so its failures never reach them.

| Failure | What happens | Where |
| --- | --- | --- |
| Renderer process gone (`render-process-gone`, not `clean-exit`) | Logged (+ opt-in crash summary); the page reloads after 250 ms (doubling per crash); stores rehydrate from `agents.list` and `agents.events`. More than 3 crashes in 60 s: a static error page plus a dialog (Reload window / Quit). Never reloads once quit started (`before-quit`). | `renderer-watchdog.ts` (`CrashLoopGuard`, `watchRenderer`) |
| Window unresponsive | Logged; one dialog "Wait / Reload window"; agents keep running | same |
| Event sent to a crashed or reloading page | `emit` catches `send` errors; agent events keep flowing to the store | `ipc/emit.ts` |
| Screen render error | Per-screen error boundary: "Try again" (re-mount), "Reload window", "Copy error report"; the rail and other screens keep working; a sanitized report goes to `renderer.log` (`app.reportError`) | `components/ErrorBoundary.tsx` |
| Extension host crash | `ExtensionHostClient` restarts with backoff (0.5 s doubling, max 5 in 2 min, then `failed`); main emits `extensions.hostState`; the renderer store marks that extension's panels reloading (`usePanelReloading(panelId)`), toasts once, and again when it is back or failed; `extension-host.log` records it | `packages/extension-host/src/host-client.ts`, `stores/extensionHosts.ts` |
| CLI process exits | Tile shows "The claude process exited with code N" and Resume (`--resume <session>`); per-agent log records the status change with the exit code | `screens/Wall/components/TileBody.tsx`, `services/agents.ts` |
| Main-process exception / unhandled rejection | Logged and (opt-in) summarized; the process keeps running so agents are not killed | `index.ts` |
| MCP server cannot bind | 3 tries; then the app starts without it, a notice explains, `agents.spawn` refuses with `unavailable` (permission prompts need it); every launch (spawn, resume, relaunch) goes through `guardedBroker`, which refuses too, and `restore()` leaves working agents stopped and resumes them on the next good start; Diagnostics shows "Not listening" | `services/core.ts`, `services/agents.ts` |
| Database cannot open | See "Database failures" below; never silently replaced | `db-recovery.ts` |
| Event append fails (disk full, database locked) | Agents keep running and live events still reach the window. Failed events wait in a bounded queue (5000, oldest dropped and counted) and are written in order once writes work; other row errors are dropped and reported, never retried in a loop. One notice per failure kind (again after 10 min), and "saved again" when it recovers | `storage-errors.ts` (`StorageErrorReporter`, `BufferedWriter`) |

### Database failures

`openWithRecovery` (main, before services start) classifies the error and shows a native dialog
whose default is always the safe choice:

- `locked` (another program holds the file): Retry / Quit. No copy is made.
- `corrupt` ("file is not a database", "malformed"): the database and its `-wal` / `-shm` are first
  copied to `<userData>/backups/oide.db.failed-<time>`; then Quit (default) / Open backups folder /
  Start with a new database. The last one moves the damaged files to `backups/oide.db.corrupt-<time>`
  (nothing is deleted) and opens a fresh database.
- `newer-schema`: Quit (update oIDE). `disk-full`: Retry / Quit. `permission` / other: Retry / Open
  data folder / Quit.

`packages/store` `openDatabase` now closes the SQLite handle when setup fails, so a damaged file is
not left locked on Windows and can be moved aside.

## Logging

`LogManager` writes rotating files in `<userData>/logs/`:

```
main.log                 main process (startup, IPC errors, crashes, shutdown steps)
renderer.log             screen error boundary reports
extension-host.log       extension host start / crash / restart / failed
agents/<agentId>.log     per-agent supervisor log: status changes, exit codes, error codes (no prompts or output)
```

- Levels `debug` / `info` / `warn` / `error`; default `info`, `OIDE_DEBUG=1` → `debug` and console
  mirroring, `OIDE_LOG_LEVEL=<level>` overrides. Warnings and errors also reach the console.
- Rotation at 5 MB (`main.log` → `main.1.log` → `main.2.log`, 3 kept); files untouched for 14 days are
  deleted at startup (also under `agents/`).
- Buffered writes (250 ms, errors flushed at once) that never throw: a failed write (disk full)
  pauses file logging for a minute and falls back to the console. Diagnostics shows it.
- Every line goes through the `Redactor` (see [security](security.md#logs-and-redaction)).
  Known secret values are registered with it as they appear: each agent's MCP secret and secret env
  when it is registered with the MCP server (`guardedBroker`), and every keychain value read in main
  (`redactSecretReads` over the secret store: custom model keys, extension secrets, MCP OAuth tokens,
  custom server env secrets; token JSON registers its secret-looking fields).
- Line breaks inside a logged value (`\n`, `\r`, U+0085, U+2028, U+2029) become an indented
  continuation line, so every entry, and only an entry, starts with its timestamp; screen error
  reports are capped at 20 a minute (SEC-35).
- Settings › Diagnostics › **Open logs folder** (`app.openLogsFolder`).

## Crash reports (opt-in, local only)

These are the local summaries. Sending scrubbed error reports to Umami is a separate opt-in
(`privacy.errorReports`, see [telemetry](telemetry.md)); it reuses this page's redactor.

Settings › Privacy › Crash reports (`settings.ui.crashReports`, default **off**). v1 never uploads
anything; there is no crash server. When on:

- oIDE writes JSON summaries to `<userData>/crash-reports/` for main exceptions, renderer gone /
  unresponsive, child processes gone (GPU, utility) and extension host crashes: kind, reason, exit
  code, app / Electron / Node versions, OS, uptime, and a stack reduced to function names and file
  base names. Messages are redacted, then every path and every quoted string is removed. 20 kept.
- Electron's `crashReporter` starts with `uploadToServer: false`; minidumps go to
  `crash-reports/native/` (5 kept). Minidumps can hold fragments of process memory, so they stay on
  the machine and are deleted when the setting is turned off.
- The preference is mirrored to `<userData>/privacy.json` so the native reporter can start before the
  app is ready on the next launch; the database setting is the source of truth.

## Resource hygiene

- **Event buffers** (renderer `stores/agents.ts`): live tail of `MAX_EVENTS_PER_AGENT` (2000) per
  agent. Focus pages history in from SQLite (`agents.events`); while it is open the cap is
  `MAX_RETAINED_EVENTS` (10 000, newest kept, `loadOlderEvents` returns 0 at the cap) and live events
  no longer push history out. Leaving Focus calls `releaseHistory`, back to the tail.
- **Monaco**: loaded lazily (`screens/Files/monaco/setup.ts`), one editor instance for Files (models per
  tab, disposed when the tab closes), one diff editor in Review split view, disposed on unmount.
- **Graceful shutdown** (`shutdown.ts` `runShutdown`): `before-quit` stops crash reloads; `will-quit`
  flushes the last agent events, then runs quit hooks **in order** (each ≤ 7 s, total ≤ 12 s, failures
  and timeouts logged, the next step still runs): terminals → services (`mcp.close` denies pending
  prompts, agents stopped with sessions resumable, git watchers closed and **in-flight git work
  awaited** (≤ 5 s; a running `git diff` keeps a worktree locked on Windows), extension host, proxy,
  database) → logs flushed → `app.exit`. The old 3 s cap was shorter than the agents' 3 s grace +
  `killTree`, so CLI processes could outlive the app.
- **Process trees**: `killTree` (agent-core) and setup commands (`packages/git` `runStream`) end the
  whole tree on Windows with `%SystemRoot%\System32\taskkill.exe /T /F` (absolute path, SEC-01), so a
  `npm install` started by `.oide/setup` does not keep running and keep files open.

## Windows

- **Locked worktree folders**: `WorktreeManager.remove` retries with backoff. If a program still has a
  file open, `services/agents.ts` removes the agent anyway, tells the user "Close programs using this
  folder (editors, terminals, dev servers, file explorers); oIDE will finish removing it the next time it
  starts", and records the path in `<userData>/pending-cleanup.json` (`CleanupQueue`). Each start
  retries pending folders (then `git worktree prune`) before agents restore; still-locked ones get a
  notice, and after 20 starts (or a non-lock error) oIDE gives up and says so.
- **Long paths**: git runs with `core.longpaths=true` on Windows (packages/git).
- **Non-ASCII and spaces**: Node 24.11's `fs.rmSync` silently does nothing for paths with non-ASCII
  characters on Windows (no error). `reliability/fs-safe.ts` `removeSync` checks and falls back to
  `unlinkSync` / `rmdirSync`; `packages/store` prunes backups with `unlinkSync`; async `fs.promises.rm`
  is not affected. Tests use userData and project paths with spaces, `ü` and `文` (logger, crash
  reports, db recovery, cleanup queue, e2e).

## Startup diagnostics

Settings › Diagnostics (`app.diagnostics` → `Diagnostics { generatedAt, checks[], report }`):

| Check | OK when |
| --- | --- |
| oIDE | app, Electron, Node versions, OS (info) |
| Claude Code CLI | found and in `TESTED_CLI_RANGE` (warn outside, error when missing) |
| git | ≥ 2.38 (`merge-tree --write-tree`, used by overlap checks and merge previews) |
| GitHub CLI (gh) | present (warn: Open pull request needs it) |
| Node.js | present on PATH (warn: built-in extension servers that run on Node need it) |
| Secure storage | `safeStorage` available |
| Database | path and size (db + WAL) |
| oIDE MCP server | listening on 127.0.0.1:<port> |
| Logs / Crash reports / App data | folder, file logging working, on/off |

Tools are resolved to absolute paths from PATH (never the cwd) and only run with `--version`
(5 s timeout). All values are redacted (home → `~`, userData → `<userData>`), so **Copy report** is
safe to paste into an issue.

## Tests

- Unit: `reliability/*.test.ts` (redaction, logger rotation / retention / disk errors / unicode,
  crash summaries stripped and pruned, watchdog reload / crash loop / unresponsive, DB recovery with a
  real damaged file, storage queue, cleanup queue, shutdown ordering and timeouts, diagnostics),
  `services/git.test.ts` (dispose awaits in-flight diff refreshes and closes watchers),
  `components/ErrorBoundary.test.tsx`, `stores/reliability.test.ts` (event caps, extension host states).
- E2E `apps/desktop/e2e/reliability.spec.ts`: an agent waits on a permission prompt, the renderer is
  killed with `forcefullyCrashRenderer()`, the window reloads by itself, the prompt is back, answering
  it finishes the run (same live process), and `main.log` / `agents/<id>.log` record it without the
  home path. Also Diagnostics over IPC and in Settings, and `app.reportError` reaching `renderer.log`.
  userData and the repo have spaces and non-ASCII names.
