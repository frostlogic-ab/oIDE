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

App version, channel, OS family and version, arch, Electron version, locale, screen size rounded to
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
| Screen view | `POST /api/batch` | `{ type: 'event', payload: { website, hostname, language, screen, title, url, referrer?, id } }` |
| Event | `POST /api/batch` | the same plus `name` and `data` |
| Session data | `POST /api/batch` | `{ type: 'identify', payload: { …, id, data } }`, once per run |
| Web vitals | `POST /api/batch` | `{ type: 'performance', payload: { …, url, fcp?, lcp?, cls?, inp?, ttfb? } }` |
| Error | `POST /api/send` | `{ type: 'error', payload: { version: 1, website, eventId, timestamp, name, message, stack, handled, url, id, screen, language, release, environment, tags } }` |

- `id` is the anonymous install id (Umami's distinct id). Headers as the tracker's: `content-type`,
  `x-umami-website-id`, `x-umami-hostname`, and the `x-umami-cache` token the server returned (memory
  only). The User-Agent is the Electron session's default (Umami drops requests whose UA looks like a
  bot, such as Node's `node`).
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
| `app_started` | main | `cold_start_ms`, `cli_found`, `cli_version` (major.minor / unknown / none), `projects`, `agents` (count buckets) | How fast does oIDE start, on which CLI versions, how big are workspaces? |
| `update_installed` | main | `from_version`, `to_version` | Do people move to new versions? |
| `telemetry_opt_in` | main | `source` [prompt, settings], `errors` | Where do people opt in? Sent only on opt-in, never on opt-out. |
| `agent_spawned` | main | `model` [opus, sonnet, haiku, fable, custom, other], `effort` [low…max, default], `strategy`, `mode`, `work_in`, `attempts`, `has_attachments`, `has_context`, `techniques`, `extensions` (counts) | Which models, efforts, modes and isolation do people pick? |
| `agent_finished` | main | `outcome` [ready-for-review, done, error, stopped], `duration` (bucket), `duration_ms`, `first_output_ms` (spawn to first output), `subagents`, `tokens`, `turns` (buckets), `error_code` [auth, model_not_found, api_error, spawn, protocol, other] | How do runs end, how long, how fast is the first output? |
| `permission_answered` | main | `decision` [allow, always, deny], `tool` [Bash, Edit, Write, Read, Search, Web, Task, Plan, Notebook, mcp, other], `wait` (bucket) | Which tools ask, how do people answer, how long do agents wait? |
| `agent_merged` | main | `result` [merged, conflicts] | How often is agent work merged, and does it conflict? |
| `merge_conflict_predicted` | main | `files` (bucket), `binary`, `submodules` (booleans); once per agent and pair of commits, from `git.predictMerge` | How often does "Merge into main?" predict conflicts, how many files, binary or submodules involved? |
| `merge_conflict_sent_to_agent` | main | `source` [prediction, merge], `files` (bucket), `agent` [running, resumed, unarchived], from `git.askToResolve` | Do people hand conflicts back to the agent, and does it have to be resumed or unarchived first? |
| `merge_conflict_resolved` | main | `duration` (bucket), at the agent's next lead `review-submitted` after the conflicts were sent | How long does an agent take to resolve merge conflicts? |
| `agent_discarded` | main | `worktree_deleted` | How often is agent work thrown away? |
| `agent_archived` | main | `reason` [merged, discarded, completed, archived-by-user] | Why do agents leave the Wall? |
| `agent_unarchived` | main | none | Do people bring archived agents back? |
| `agent_deleted` | main | none | Do people delete archived agents for good? |
| `pr_opened` | main | `existing` | Do people open PRs instead of merging locally? |
| `pr_view_opened` | main | none (the URL is never sent) | Do people follow an agent's PR from oIDE? |
| `pr_merged_detected` | main | none | How often does oIDE see an agent's PR merged? |
| `worktree_delete_failed` | main | `holder` [docker, editor, terminal, node, unknown] | How often can a worktree folder not be deleted, and what kind of program holds it? Never the program's name or any path. |
| `worktree_delete_retried_ok` | main | `attempts` (count bucket) | Does the background retry finish removing those folders, and after how many tries? |
| `compact_requested` | main | none | Do people compact context by hand? |
| `slash_command_used` | main | `command` [built-in CLI commands, other] | Which built-in slash commands are used? Skills, plugin and MCP commands are `other`. |
| `attachments_sent` | main | `where` [spawn, message], `images`, `files` (counts) | Do people attach images and files? |
| `file_search_used` | main | `kind` [name, content, replace], `results` (bucket), `queries`, `regex`, `engine` [git-grep, scan, mixed] | Is Files search used and does it find anything? One event per run of keystrokes. |
| `artifact_imported` | main | `source` [link_content, file], `kind` [design, doc, whiteboard], `linked`, `format` [html, react, svg, markdown, excalidraw] | How do people bring claude.ai artifacts in, which kinds, and how many are React? `link_content` is pasted content, with a link when `linked` (without one only when replacing an old import whose link is no longer accepted). Never the link, title or content. |
| `artifact_import_refused` | main | `reason` [no_content, bad_link, wrong_kind, too_large, stub_content, other] | Why are claude.ai imports refused before anything is created? Observed through the router's `observeFailure` (codes and Zod issue paths only, never the input). |
| `artifact_fetch_with_agent_started` | renderer | (none) | Do people hand a claude.ai link to an agent to fetch (Claude Docs or Claude Design links)? |
| `extension_installed` | main | `extension` (official index id), `source` [marketplace, builtin] | Which marketplace extensions are installed? Never folder, git or custom-index ones. |
| `setting_changed` | main | `key` (allow-listed key) | Which settings do people change? Never the value; once per key per 10 s. |
| `cli_unknown_event` | main | `event_type` (`type/subtype` of the CLI), `count` | Which CLI events does oIDE not understand yet? Top 5 every 30 min. |
| `command_palette_used` | renderer | `command` [built-in command ids] | Which built-in command bar commands are used? |
| `perf_summary` | renderer | `window_min`, `ipc_samples`, `ipc_p50_ms`, `ipc_p95_ms` (1 in 10 calls), `long_tasks`, `memory` (bucket), `wall_render_ms`, `wall_agents` (bucket) | Is the UI fast? After 10 min, then every 30 min. |

Session data (`identify`, once per run): `app_version`, `channel`, `os`, `os_version`, `arch`,
`electron`, `dev`, `cli_version`.

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
