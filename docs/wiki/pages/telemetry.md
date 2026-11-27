# Telemetry (opt-in usage analytics and error reports)

oIDE can send anonymous usage analytics and crash and error reports to Umami, **only when the user
opts in**. Decision and reasons: [ADR 0011](../../adr/0011-telemetry.md). Related: [security](security.md),
[reliability](reliability.md) (local crash reports, the log redactor), [screen-settings](screen-settings.md)
(Settings › Privacy), [protocol](protocol.md), [desktop-shell](desktop-shell.md).

## Rules (enforced in code)

- **Nothing before consent.** `settings.privacy.usageAnalytics` and `settings.privacy.errorReports`
  default to off. Main queues nothing, and creates no install id, until a switch is on. Errors raised
  before settings load wait in memory (at most 20) and are dropped unless the stored settings say yes.
- **First-run question** (`components/TelemetryConsent.tsx`): shown 1.2 s after the window is ready,
  when main's `telemetry.status` says `showPrompt`. "Share usage and crash reports" turns both on,
  "No thanks" turns both off, and both answers are final (`consentAnswered`). Esc or the scrim means
  "not now": it is asked again on the next launch, **at most twice in all** (`MAX_CONSENT_PROMPTS`),
  then never. Changing a switch in Settings also counts as an answer.
- **One switch stops everything of its kind at once.** Off drops that queue. When both are off, the
  request in flight is aborted, the install id is deleted from `<userData>/telemetry.json`, and the
  next opt-in makes a new one.
- **Never on** with `DO_NOT_TRACK=1`, `OIDE_TELEMETRY=0`, under Vitest or `NODE_ENV=test`, in every
  e2e launch (`apps/desktop/e2e/app.ts` sets `OIDE_TELEMETRY=0`), or in builds with telemetry compiled
  out. Then there is no question, the switches are disabled, and no network session is created.
- **Main is the only sender.** No remote script in any window, CSP unchanged. The renderer reports
  over `telemetry.track` (Zod-validated, at most 120 per minute) and main decides.
- **Dev runs are separate.** Unpackaged runs send hostname `oide-dev` and environment
  `development`; release builds send `oide` / `production`.
- Credentials: telemetry code never touches Claude credentials (hard rule 3).

### Never sent

File paths, project, repository or branch names, agent titles or goals, prompts, model output, tool
inputs, commit messages, artifact contents, extension settings, env values, URLs the user visits,
Claude account information, ids of custom or local extensions, setting values. Session recording
(`recorder.js`) is not used.

### Allowed

App version, channel, OS family and version, arch, Electron version, locale, OS region setting (country), screen size rounded to
100 px, Claude Code CLI version (major.minor in events), counts, durations and buckets, enum-like values
(screen, model family such as `opus`, effort, permission mode, outcome, tool category such as `Bash` /
`Edit` / `mcp`), feature-used events, ids of extensions from the official marketplace index.

## How it is sent (Umami v3.5.0)

`data.frostlogic.se` runs Umami **v3.5.0** (from its `/api/scripts/telemetry`; its `script.js` has
the `error`, `performance` and `identify` collectors). Payloads match the official tracker and the
server's request schemas (`src/app/api/send/request-schema.ts`, `src/lib/errors/schema.ts`); the unit
test `apps/desktop/src/main/telemetry/umami.test.ts` holds a copy of those schemas.

| Kind | Endpoint | Body |
| --- | --- | --- |
| Screen view | `POST /api/batch` | `{ type: 'event', payload: { website, hostname, language, screen, title, url, referrer?, id, ip, userAgent } }` |
| Event | `POST /api/batch` | the same plus `name` and `data` |
| Session data | `POST /api/batch` | `{ type: 'identify', payload: { …, id, data } }`, once per run |
| Web vitals | `POST /api/batch` | `{ type: 'performance', payload: { …, url, fcp?, lcp?, cls?, inp?, ttfb? } }` |
| Error | `POST /api/send` | `{ type: 'error', payload: { version: 1, website, eventId, timestamp, name, message, stack, handled, url, id, screen, language, release, environment, tags } }` |

- `id` is the anonymous install id (Umami's distinct id). Headers as the tracker's: `content-type`,
  `x-umami-website-id`, `x-umami-hostname`, and the `x-umami-cache` token the server returned (memory
  only).
- **One session per install.** Umami v3.5.0 makes the session id from website, IP, User-Agent, a salt
  (monthly unless the server sets `SALT_ROTATION`) and the distinct id (`src/lib/collection-session.ts`).
  The request IP changes with the network (Windows rotates its temporary IPv6 address daily) and
  Electron's default User-Agent carries the app and Chromium versions, so one person used to show up
  as a new session after most launches and after every upgrade, and the **Retention** report (which
  counts session ids) showed almost no one coming back. Usage payloads now carry `ip: '127.0.0.1'` and
  a constant, version-free, browser-like `userAgent` (`stableUserAgent(platform)` in `umami.ts`; only
  the OS family is in it), so the session is the install id and stays the same across restarts,
  networks and oIDE, Electron and OS upgrades. The telemetry network session sends the same
  User-Agent header (error reports cannot set it in the payload; they still carry the real request IP,
  so they may sit in a separate session). Side effect: Umami stores no location for usage (the
  loopback IP has none); the OS region setting goes in session data as `country` instead. A browser-
  like UA is required: Umami drops requests whose UA looks like a bot, such as Node's `node`.
- Retention caveat: the session id still changes when Umami's salt rotates (by default at the start
  of each month). For retention across months, set `SALT_ROTATION` on the server to a fixed string
  (any value that is not a period name), which makes the salt constant.
- No `timestamp` on usage payloads (Umami would treat them as historical imports).
- Main's session `oide-telemetry` (in memory, no cache, no permissions) only lets requests to the
  compiled-in Umami origin through; the window's session still has no network route.
- Queues: 200 usage items, 20 errors (new items dropped when full); usage flushed every 30 s or at 20
  items, errors after 2 s; errors at most 10 per minute and 100 per run, the same error at most once in
  10 minutes; web vitals at most once per screen per 30 minutes. Backoff 5 s doubling to 5 min with
  jitter, 3 attempts; 429 drops the queues and waits `Retry-After` (1 to 300 s); 4xx drops the batch; a
  `disabled` or bot answer stops for the run; offline (`net.isOnline()`) makes no request. Nothing is
  persisted: unsent items are dropped on quit after one last flush of at most 2 s. Persisting them would
  write usage data to disk and could send it after the user changed their mind.

## Screen views

Synthetic URLs only: `/wall`, `/focus`, `/spawn`, `/source-control`, `/review`, `/files`, `/artifacts`,
`/marketplace`, `/extension`, and `/settings/<section>` (`cli`, `models`, `agents`, `tech`, `perms`,
`projects`, `artifacts`, `ext`, `keys`, `look`, `privacy`, `updates`, `diag`). No agent ids, paths or
extension names. Events carry the current screen as their `url`.

## Event catalogue

The source of truth is `TELEMETRY_EVENTS` in `packages/protocol/src/telemetry.ts`; Settings › Privacy
› See what's sent lists it in the app. Values in brackets are the only ones allowed.

| Event | From | Properties | Product question |
| --- | --- | --- | --- |
| `app_started` | main | `app_version` (e.g. `0.5.1`, or `unknown`), `cold_start_ms`, `cli_found`, `cli_version` (major.minor / unknown / none), `projects`, `agents` (count buckets) | Which oIDE versions are people running, how fast does oIDE start, on which CLI versions, how big are workspaces? |
| `update_installed` | main | `from_version`, `to_version` | Do people move to new versions? |
| `update_install_started` | main | `trigger` [header (the header Update button), settings (Restart to update in Settings), quit (Install when oIDE closes)], `channel` [stable, beta]; once per install | How do people apply updates: header button, Settings, or by quitting? |
| `update_checked` | main | `outcome` [available, not_available, no_release (nothing published on GitHub yet), feed_missing (the newest release has no `latest*.yml` for this platform, e.g. still publishing), error], `channel` [stable, beta]; once per finished update check, background or manual | Does auto-update work in the field, and why do checks fail? |
| `telemetry_opt_in` | main | `source` [prompt, settings], `errors` | Where do people opt in? Sent only on opt-in, never on opt-out. |
| `agent_spawned` | main | `model` [opus, sonnet, haiku, fable, custom, other], `effort` [low…max, default], `strategy`, `mode`, `work_in`, `attempts`, `has_attachments`, `has_context`, `techniques`, `extensions` (counts), `auto_title` (the title is a stand-in the agent is asked to replace) | Which models, efforts, modes and isolation do people pick? |
| `agent_finished` | main | `outcome` [ready-for-review, done, error, stopped], `duration` (bucket), `duration_ms`, `first_output_ms` (spawn to first output), `subagents`, `tokens`, `turns` (buckets), `error_code` [auth, model_not_found, api_error, spawn, protocol, other] | How do runs end, how long, how fast is the first output? |
| `permission_answered` | main | `decision` [allow, always, deny], `tool` [Bash, Edit, Write, Read, Search, Web, Task, Plan, Notebook, mcp, other], `wait` (bucket) | Which tools ask, how do people answer, how long do agents wait? |
| `agent_merged` | main | `result` [merged, conflicts], `local_changes` [none, stashed_restored, stashed_kept] | How often is agent work merged, and does it conflict? How often were uncommitted main-checkout files in the way (stashed, then put back or kept in the stash)? |
| `merge_conflict_predicted` | main | `files` (bucket), `binary`, `submodules` (booleans); once per agent and pair of commits, from `git.predictMerge` | How often does "Merge into main?" predict conflicts, how many files, binary or submodules involved? |
| `merge_conflict_sent_to_agent` | main | `source` [prediction, merge], `files` (bucket), `agent` [running, resumed, unarchived], from `git.askToResolve` | Do people hand conflicts back to the agent, and does it have to be resumed or unarchived first? |
| `agent_titled` | main | `after` (duration bucket since the run started), at a lead `title-changed` (the agent called `set_title`); never the title | Do agents asked to name their task do so, and how soon? |
| `merge_conflict_resolved` | main | `duration` (bucket), at the agent's next lead `review-submitted` after the conflicts were sent | How long does an agent take to resolve merge conflicts? |
| `agent_discarded` | main | `worktree_deleted` | How often is agent work thrown away? |
| `agent_archived` | main | `reason` [merged, discarded, completed, archived-by-user] | Why do agents leave the Wall? |
| `agent_unarchived` | main | none | Do people bring archived agents back? |
| `agent_deleted` | main | none | Do people delete archived agents for good? |
| `pr_opened` | main | `existing`, `draft` (`agent` / `template` / `plain` / `given`, new PRs only) | Do people open PRs instead of merging locally? Do new PRs follow the project's conventions (agent draft, project template) or go up as the plain summary? |
| `pr_pushed` | main | `commits` (count bucket), `committed` | Do people send follow-up work to an open PR (Push to PR), how many commits at a time, and how often did oIDE commit leftover files first? Never the URL. |
| `changes_reverted` | main | `files` (count bucket), `all` (no file pick), from `git.discard` | Do people throw away uncommitted main-checkout changes from Source control (Revert…), how many files, all or a pick? Never the paths. |
| `file_changes_discarded` | main | `files` (count bucket), `checkout` [main, worktree], from `files.discardChanges` | Do people throw away changes from the Files tree (right click › Discard changes), in the main checkout or an agent worktree, and how many files at once? Never the paths. |
| `project_pulled` | main | `from` [sidebar, source_control], from `git.pull` | Do people bring a project up to date from the Projects sidebar's Pull button (shown after a background fetch finds new commits) or from Source control? Never the project, branch or commits. |
| `pr_view_opened` | main | none (the URL is never sent) | Do people follow an agent's PR from oIDE? |
| `pr_merged_detected` | main | none | How often does oIDE see an agent's PR merged? |
| `pr_checks_finished` | main | `result` [success, failure] | Do agents' PRs pass CI? Sent once per CI run, when the checks oIDE watched running finish. Never the check names. |
| `pr_checks_opened` | main | none (the URL is never sent) | Do people open a PR's CI checks from the tile's CI indicator? |
| `worktree_delete_failed` | main | `holder` [docker, editor, terminal, node, unknown] | How often can a worktree folder not be deleted, and what kind of program holds it? Never the program's name or any path. |
| `worktree_delete_retried_ok` | main | `attempts` (count bucket) | Does the background retry finish removing those folders, and after how many tries? |
| `agent_mode_changed` | main | `from` [permission modes, unknown], `to` [permission modes] | Do people change an agent's permission mode after it started (Focus header menu, Shift+Tab), and between which modes? |
| `compact_requested` | main | none | Do people compact context by hand? |
| `slash_command_used` | main | `command` [built-in CLI commands, other] | Which built-in slash commands are used? Skills, plugin and MCP commands are `other`. |
| `attachments_sent` | main | `where` [spawn, message], `images`, `files` (counts) | Do people attach images and files? |
| `file_search_used` | main | `kind` [name, content, replace], `results` (bucket), `queries`, `regex`, `engine` [git-grep, scan, mixed] | Is Files search used and does it find anything? One event per run of keystrokes. |
| `files_markdown_view` | renderer | `view` [preview, edit], `via` [button, shortcut] | Do people read Markdown files in the Files preview, or switch to editing beside it, and how? Sent on a switch only (opening a file in the preview by default sends nothing). Never the path or the content. |
| `files_diff_view` | renderer | `view` [off, unified, split] | When a changed file opens on its changes in Files, do people read them unified, side by side, or switch to the plain editor? Sent on a switch only (opening a changed file on its changes sends nothing). Never the path or the content. |
| `file_managed` | main | `action` [create_file, create_folder, rename, copy, move, delete], `crossCheckout` (copy / move only) | Do people manage files from the Files tree, and which actions? One event per successful action; never a path or name. |
| `script_run` | main | `runner` [npm, pnpm, yarn, bun, deno, composer, make, just, cargo, go, dotnet, gradle, maven, python] | Do people run project scripts from Files › Run, and for which kinds of project? One event per `terminal.runScript` that started; never the script name, its command line or the folder. |
| `language_server_started` | main | `language` [typescript, python, rust, go, c_cpp, css, html, json, yaml, shell, other], `outcome` [running, not_installed, failed] | Do the Files editor language servers start for people, for which languages, and how often is the server simply not installed? One event per start attempt (`services/lsp/language-servers.ts`, [ADR 0019](../../adr/0019-language-servers-in-main-with-a-monaco-bridge.md)); `language` is the built-in Languages extension's language from a fixed list, any other extension's is `other`. Never the server command, the extension id, paths or file contents. |
| `artifact_imported` | main | `source` [link_content, file, files, folder], `kind` [design, doc, whiteboard], `linked`, `format` [html, react, svg, markdown, excalidraw], `files` (count bucket, multi-file imports) | How do people bring artifacts in (pasted content, one exported file, several picked files, a folder), which kinds, and how many are React? `link_content` is pasted content, with a link when `linked` (without one only when replacing an old import whose link is no longer accepted). `files` and `folder` come from `artifacts.importFiles` ([ADR 0014](../../adr/0014-multi-file-artifacts-retrieved-by-agents.md)); `format` is the entry file's. Never the link, title, paths or content. |
| `artifact_import_refused` | main | `reason` [no_content, bad_link, wrong_kind, too_large, stub_content, bad_path, other] | Why are imports (`artifacts.import`, `importFiles`, `importLink`) refused before anything is created? `too_large` covers the file count and sizes, `bad_path` a file name an artifact can't hold. Observed through the router's `observeFailure` (codes and Zod issue paths only, never the input). |
| `artifact_retrieval_started` | main | `trigger` [import, update, retry], `kind` [design, doc, whiteboard] | How often do people have an agent retrieve a linked claude.ai artifact (a new link, Update, Retry)? Sent by the retrieval service (`services/artifact-retrieval.ts`) once the agent is queued. Never the link, title or agent. |
| `artifact_retrieval_finished` | main | `trigger` [import, update, retry], `outcome` [ready, failed, cancelled, agent_stopped], `kind`, `files` (count bucket) | Do agent retrievals work? `failed` is the agent's own "can't read it" or files oIDE refused; `agent_stopped` an agent that ended or was removed first. Never the agent's reason text, the link or file names. |
| `artifact_agent_started` | main | `kind`, `mode` | Do people work on artifacts with an agent in the open view (Artifacts › Agent panel), on which kinds, in which mode? Never the direction text or the artifact's title. |
| `artifact_agent_message` | renderer | `kind`, `feedback` (number of preview comments sent), `has_text` | Do people point at the preview to give an artifact agent feedback, and how many comments at once? Never the comments, the selectors or the element text. |
| `agent_model_changed` | main | `model` (family), `effort` (or `default`), `artifact_agent` | Do people switch a running agent's model or effort (Artifacts › Agent panel), and to what? Never a custom model's id. |
| `project_added` | main | `method` [open, init, clone, create], `source` [url, github] (clones only) | How do people start projects: open a repo, initialise git in a folder, clone (typed URL or their GitHub list), or create a new repository? From `projects.open` / `initFolder` / `clone` / `create`; a cancelled picker or clone sends nothing. Never the path, URL, host, repository or folder name. |
| `project_add_failed` | main | `method` [open, init, clone, create], `reason` [not_a_repo, auth, not_found, network, exists, no_identity, forbidden_path, other] | Why do new projects fail, so the dialog can explain it better? Observed through the router's `observeFailure` (the `IpcError` reason only, never git's message or the input). |
| `extension_installed` | main | `extension` (official index id), `source` [marketplace, builtin] | Which marketplace extensions are installed? Never folder, git or custom-index ones. |
| `setting_changed` | main | `key` (allow-listed key, `TELEMETRY_SETTING_KEYS`; includes `ui.filesLegendHidden`, the Files legend's ×) | Which settings do people change? Do people close the Files legend? Never the value; once per key per 10 s. |
| `cli_unknown_event` | main | `event_type` (`type/subtype` of the CLI), `count` | Which CLI events does oIDE not understand yet? Top 5 every 30 min. |
| `command_palette_used` | renderer | `command` [built-in command ids] | Which built-in command bar commands are used? |
| `perf_summary` | renderer | `window_min`, `ipc_samples`, `ipc_p50_ms`, `ipc_p95_ms` (1 in 10 calls), `long_tasks`, `memory` (bucket), `wall_render_ms`, `wall_agents` (bucket) | Is the UI fast? After 10 min, then every 30 min. |

Session data (`identify`, once per run): `app_version`, `channel`, `os`, `os_version`, `arch`,
`electron`, `dev`, `country` (the OS region setting, ISO 3166 alpha-2, from
`app.getLocaleCountryCode()`; left out when empty), `cli_version`.

### Which version each user runs

The app version reaches Umami three ways, so it can be read from whichever view fits the question:

- **Per user (install):** session data `app_version`, set once per run. In Umami: the website's
  **Sessions** tab, open a session for its properties, or the session **Properties** view to break
  sessions down by `app_version`. Each install is one session (the install id is Umami's distinct id),
  so this answers "how many installs run which version".
- **Per launch:** the `app_started` event's `app_version` property. In Umami: **Events › Properties**,
  event `app_started`, property `app_version`. Counts launches, so heavy users weigh more; use it for
  adoption over time and to filter start-up time by version.
- **Errors:** every error report carries the version as `release`.

Release builds send on hostname `oide`, unpackaged runs on `oide-dev` (session data `dev: true`), so
filter on hostname `oide` to leave out development builds.

## Errors

Reported (when "Send crash and error reports" is on): main uncaught exceptions and unhandled
rejections, renderer `window.onerror` and unhandled rejections (`lib/telemetry.ts`), screen error
boundaries (through `app.reportError`), renderer process gone, child processes gone, extension host
failures (never the extension's name), and agent errors as `AgentError` with the code only (never the
CLI's message). Scrubber: `apps/desktop/src/main/telemetry/scrub.ts`, on top of the log redactor
(`reliability/redact.ts`):

- name: identifier characters only;
- message: secrets and token shapes, then every URL, email, quoted string, absolute and relative
  path, file name, UUID, long hex or base64 run, IP address, the OS user name and the machine name are
  replaced with placeholders; at most 500 characters;
- stack: only frames inside the app bundle, as `/out/main/index.js:12:5` (the form Umami parses),
  behind a first line rebuilt from the scrubbed name and message.

`scrub.test.ts` fuzzes 2000 seeded inputs (Windows and POSIX paths, home folders, UNC, `file://`
URLs, emails, URLs with queries, hex, base64, JWT, `sk-ant-` and `ghp_` tokens, quoted names, IPs)
and asserts none of the sensitive parts survive.

## Performance

Web vitals per screen visit as Umami `performance` payloads (FCP, LCP and TTFB of the first screen;
CLS and INP of every visit), cold start in `app_started`, spawn-to-first-output and run duration in
`agent_finished`, and `perf_summary` (IPC round trips, long tasks, JS heap, Wall render time with the
agent count).

## Adding an event

1. Add it to `TELEMETRY_EVENTS` with `from`, the product question and a strict `props` schema
   (enums, booleans, bounded numbers, buckets; never a free string). The catalogue test refuses
   properties that accept free text.
2. Emit it: in main from `telemetry/observers.ts` (IPC commands, agent events, emitted events) or
   `telemetry.track(...)`; in the renderer only for `from: 'renderer'` events, over `telemetry.track`.
3. Add it to the table above (a test checks every catalogue event is listed here).
4. Add a unit test that the observer emits it with only allowed values.

## Forks and builds

The endpoint is a build-time default in `packages/protocol/src/distribution.ts`
(`OFFICIAL_UMAMI_HOST`, `OFFICIAL_UMAMI_WEBSITE_ID`), injected by `electron.vite.config.ts`:

- `OIDE_UMAMI_HOST=https://stats.example.org OIDE_UMAMI_WEBSITE_ID=<uuid> pnpm build`: your own Umami;
- `OIDE_UMAMI_HOST= pnpm build` (empty): telemetry compiled out. No question, switches disabled with
  "This build of oIDE has no telemetry endpoint", no network session.

The host must be an https origin without a path or credentials (`telemetryTarget()`).

## Testing

Unit: `packages/protocol/src/telemetry.test.ts` (catalogue, buckets, endpoint, settings migration),
`packages/store/test/settings-privacy.test.ts`, `apps/desktop/src/main/telemetry/*.test.ts` (consent
gating, scrubbing, payloads, batching and backoff with a fake transport, observers),
`components/TelemetryConsent.test.tsx`. E2E: `apps/desktop/e2e/telemetry.spec.ts` with
`OIDE_TELEMETRY_SINK=<file>` (unpackaged builds only): main writes each request to the file instead of
the network. No test uses the real network.

## Hooks still to add

- Review screen actions (Send feedback, Viewed) and Artifacts (create, give to an agent) are not
  instrumented yet; add catalogue events when there is a product question for them.
- Interrupted agents (Resume after a restart or crash) could get an `agent_resumed { reason }` event.
