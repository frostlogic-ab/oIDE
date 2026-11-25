# Testing

How oIDE is tested. Each section is owned by the package that needs it; add a section rather than
rewriting others. Related: [agent-supervisor](agent-supervisor.md), [cli-integration](cli-integration.md).

## Unit and integration tests (Vitest)

- `pnpm test` (root `vitest.config.ts`): co-located `packages/*/src/**/*.test.ts`, plus `packages/*/test`,
  `tools/*/test`, `test/`. Default timeout 20 s.
- Agent tests never need a Claude login: they run against `tools/fake-claude`.
- `test/no-credentials.test.ts` fails the build if a Claude credential location appears in code.

## Main-process integration (`test/integration/`)

The whole services layer of `apps/desktop/src/main` runs in plain Node, no Electron:
`createCoreServices({ ctx, platform, terminals })` with a fake `Platform` (reversible cipher instead of
`safeStorage`, trust answer, captured notifications, no watchers) and `registerDomainHandlers` on a real
`IpcRouter`, so every call goes through the Zod-validated contract exactly as the renderer's.
`harness.ts` builds a temp git repo (`makeRepo`), a temp userData, and `call(command, input)` /
`fails(command, input)` (returns the error code). The CLI is `tools/fake-claude` via
`Platform.cliPathOverride`. Test files import the protocol by relative path (the root has no
`node_modules/@oide`).

`main-services.test.ts` covers: a handler for every command in `Commands` (shell.* need Electron); open a
repo (non-repo → `not_a_repo`) → spawn (worktree under `<userData>/worktrees`, branch `oide/<slug>`) →
permission prompt on the summary (wrong id → `not_found`, Always saves `Bash(npm test)` to
`.oide/permissions.json`) → `submit_for_review` → `git.diff` and tile diff counts → files tree/read and
path guard (`forbidden_path`) → review comment + `sendFeedback` (one review-feedback message, comments
marked sent) → second turn → commit in the worktree → `git.mergeLocal` → cleanup "Right away" removes
worktree, branch and agent; `.oide/setup` runs only after the project is trusted; Bypass refusals;
the Max running queue (2 attempts, max 1); resume with `--resume <same session id>` after a simulated
restart (`--fake-record` argv check); artifacts preview URL resolution, picked-file rule for imports,
custom model keys stay in the secret store and never appear in `settings.get`.

## Milestone gate tests (`test/gates/`)

Automated proof for each milestone gate, on the same plain-Node services layer as
`test/integration` (real IPC router, fake `Platform`, tools/fake-claude; never the real CLI).
`helpers.ts` adds `gateHarness` (cleanup per test), `driveTo(h, id, status | predicate)` (waits,
clicking "Allow once" on every prompt; `answer: 'deny'` to deny) and the harness options
`platform` (e.g. a `fetch` for a local marketplace), `onEvent`, `keepEvents: false` and
`emitErrors` (events dropped by their schema). `marketplace.ts` builds a third-party extension
tarball (`@acme/oide-textkit`, stdio MCP server `textkit`, tool `text.reverse`, risk `read`) and an
index entry with its real sha512, served through `Platform.fetch`.

| Gate | File | What it proves | Result (2026-11-25) |
| --- | --- | --- | --- |
| M2 | `m2-soak.test.ts` | 6 agents, 3 projects, Max running 3, single + routed. Each agent loops tools, allowed and denied prompts, subagents (with a subagent prompt), review + feedback, `/compact`, rate limit → Stop → Resume (`--resume`), replies, for `OIDE_SOAK_MS` (default 60 s; `OIDE_SOAK_DEBUG=<file>` logs samples). Checks: no queue launch beyond Max; CLI processes read from the OS (command line marker; PIDs are reused on Windows) never exceed one per agent and none outlives its `--resume` replacement; store events = renderer events (same seqs, no duplicates); every turn's `result`; stored summary = supervisor; no dropped emits; heap bounded; after remove + quit no CLI process, MCP endpoint, pending prompt, supervisor or process listener, socket, server, child or timer handle beyond the baseline. | pass: 60 s ≈ 1,350 cycles, 176 launches (170 `--resume`), ≤ 6 alive, ≈ 25,700 events, heap ≈ 63 → 94 MB |
| M3 | `m3-spawn-to-merge.test.ts` | Spawn → agent commits `committed.txt` (trailer) and leaves `pending.txt` → Review diff lists both → comment + feedback → second turn edits `pending.txt` → Merge locally → branch on main with the agent attribution. | pass, both tests: everything Review showed (the commit and the uncommitted `pending.txt`) is on main (B1 fixed on main: merge commits pending work). Accepts either B1 fix (commit before merge, or refuse then `commit-all`). |
| M4 | `m4-oide-portable.test.ts` | Origin repo commits `.oide/{config,permissions,techniques,extensions}.json`; two userData dirs with different global defaults clone it, install the extension from the index, trust it: identical normalized argv (`--fake-record`), `--mcp-config`, env key names and first message; plan is the project's (mode, preset, allow/deny, techniques, extension). Untrusted third machine: `--setting-sources user --strict-mcp-config`, own default mode, no allow rules, no extension, no techniques, no setup; deny rules and preset still apply. Trusting it gives the same plan. | pass, including the Spawn defaults: `settings.forProject` (what the Spawn screen uses) gives the project's mode and preset, the mode only when trusted. |
| M5 | `m5-extension-tool.test.ts` | Index → install (integrity checked; a tampered tarball is refused with `install_failed`) → enable for project A → agent's `--mcp-config` has the stdio server, `--allowedTools` the tool → fake-claude starts the server, `ToolSearch` + `mcp__textkit__text_reverse` → result (from the server's own PID) in the transcript; server ends with the CLI; project B's agent has no such tool. | pass |
| M6 | `m6-artifacts.test.ts` | Design artifact as a Spawn context chip → `artifacts_read` (pre-allowed) + `artifacts_create` (asks) over the agent's MCP endpoint → doc artifact by `agent:<id>` → "Agents using it" (`read` on the design, `create` on the doc) → user `artifacts.save` = version 2 (author `user`). Also "Give to an agent" on a running agent. | pass |

## E2E (Playwright for Electron, `apps/desktop/e2e/`)

`pnpm --filter @oide/desktop e2e` builds, then runs the built app with a temp `OIDE_USER_DATA`.
`launchApp(env)` takes extra env: `OIDE_CLAUDE_PATH` (CLI override; `FAKE_CLAUDE` is
`tools/fake-claude/bin/fake-claude.cmd` on Windows, `.mjs` elsewhere) and `OIDE_E2E_TRUST=trust|untrusted`
(answers the first-open trust dialog; honoured only by unpackaged builds).

- `smoke.spec.ts`: window and web preferences, isolation and CSP, error codes over real IPC, rail
  navigation by `aria-current`, Ctrl+K.
- `agents.spec.ts`: `projects.open({ path })` at the IPC level (the native picker can't be driven),
  spawn with fake-claude `--fake-scenario review`, the Wall tile shows the
  `group "Permission: Run npm test"`, clicking "Allow once" leads to `ready-for-review` and the
  "Ready for review" label, `git.diff` lists the file; the `oide-artifact://` protocol serves an
  artifact with the no-network CSP and answers 404 for `..` escapes.
- `gates.spec.ts` (UI-visible part of the gates): M4 Settings › Permissions lists the project's committed
  `.oide/permissions.json` rules; M6 the agent-written doc appears in Artifacts with "Agents using it"
  (writes / reads) and History shows v2 after the user's save; M3 Focus › Changes › "Review all changes"
  lists `committed.txt` and `pending.txt` and offers Merge; M2 six agents across three projects, 3 running
  and 3 queued tiles, without a reload (the supervisor publishes queued summaries for every caller); M5 the
  Marketplace's Installed list shows every built-in (unpackaged builds find them from the repo root).
  Repos live in fixed folders listed in `OIDE_E2E_OPEN_PATHS` (SEC-08 stand-in), and `OIDE_E2E_CONFIRM=accept`
  answers the extra-flags confirmation (SEC-07).

## fake-claude (`tools/fake-claude`)

A scriptable stand-in for the `claude` CLI in `-p --input-format stream-json --output-format stream-json`
mode. Event shapes follow the real 2.1.325 recordings, so the parser, driver, supervisor and MCP loop are
exercised end to end.

- Entry points: `bin/fake-claude.mjs` (run with `node`; `buildLaunch` and `detectCli` do this for any
  `.mjs` CLI path) and `bin/fake-claude.cmd` (Windows shim, used to test `.cmd` quoting).
- Accepts the real flags (`--session-id`, `--resume`, `--model`, `--permission-mode` with the real choices,
  `--mcp-config`, `--permission-prompt-tool`, `--allowedTools`, `--agents`, `--include-partial-messages`,
  `--forward-subagent-text`, …), `--version` and `--help` (prints `fixtures/help-2.1.325.txt`).
- Reads stream-json user messages; answers `interrupt` and `set_permission_mode` control requests.
- **Permission prompts are real:** tools that need permission are sent to the MCP tool named by
  `--permission-prompt-tool`, over the HTTP server in `--mcp-config` (with its headers), so tests run the full
  CLI → MCP server → supervisor → answer loop. `mcp__oide__*` tool calls also go to that server.
- Choosing behaviour: `--fake-scenario a,b,c` (or `FAKE_CLAUDE_SCENARIO`), one scenario per user turn,
  the last repeats. In supervisor tests it is passed through Settings › Extra CLI flags, because the agent
  env is allow-listed.

| Scenario | What it emits |
| --- | --- |
| `basic` | thinking, streamed text "Hello from fake-claude. You said: …", `rate_limit_event` (allowed), result. With `--resume <id>` the first reply is "Resumed session <id>." |
| `tools` | TodoWrite, Read, Write + Edit of `fake-output.txt` in cwd (real file changes for diffs), Bash `npm test` (prompted) |
| `permission` | Bash `npm test` through the prompt tool; reply depends on allow / deny |
| `review` | Write `feature.txt`, Bash `npm test`, `mcp__oide__submit_for_review` over MCP |
| `subagents` | foreground `Agent` (report as tool_result) and async `Agent` (lead result first, then tagged subagent events, a prompted Bash with the subagent's tool_use id, `task_notification`, a woken lead turn) |
| `rate-limit` | rejected `rate_limit_event` with `resetsAt`, synthetic assistant `error:"rate_limit"`, result 429 |
| `auth` | synthetic `authentication_failed`, result 401 "Not logged in · Please run /login" |
| `crash` | a partial, stderr line, exit code 3 (or `--fake-exit-code n`) |
| `slow` | 400 text deltas 25 ms apart (for interrupt / pause tests) |
| `replay:<file>` | replays a fixture from `fixtures/` turn by turn (up to each `result`) |
| `commit-work` | Write `committed.txt`, Bash `git commit` (prompted; really commits with `Oide-Agent: <name>` from the system prompt), Write `pending.txt` (left uncommitted), Bash `npm test`, submit_for_review |
| `address-feedback` | Edit `pending.txt` with the first review comment, submit_for_review again |
| `commit-all` | Bash `git add -A && git commit` (prompted, real), then a question |
| `mcp-tool` | `ToolSearch select:<tool>` then the tool from `[fake-tool:mcp__srv__tool]` with `[fake-args:{…}]` (default: first tool of the first stdio server); "No MCP tool is available." without one |
| `artifacts` | `mcp__oide__artifacts_read` of the `{"id":"…"}` in the message (else the first design from `artifacts_list`), then `artifacts_create` of a doc "Notes on <title>" listing its headings |
| `artifact-update` | `mcp__oide__artifacts_read` of the `{"id":"…"}` in the message, then `artifacts_write` of a new version (a design gets an `<h2>`, a doc a list item): an agent-written update of an artifact the user may have open |
| `resolve-conflicts` | Bash `git merge <ref>` (the ref named in oIDE's merge-conflicts message; prompted, real), Write each conflicted file with both sides kept (ours, then theirs), Bash `git commit` of the merge with the trailer, submit_for_review. Picked automatically for any message starting "[Sent by oIDE] Merge conflicts", whatever the list says |
| any + `/compact` | compacting status, `compact_boundary`, local-command stdout, result `local_command:"compact"` |

A user message containing `[fake-scenario:<name>]` runs that scenario for its turn, whatever the list says
(the soak uses it to script each turn). MCP servers in `--mcp-config` are reached over HTTP (`url`) or, for
`command` entries, started once over stdio (newline-delimited JSON-RPC) and killed when fake-claude exits;
`mcp__srv__db_schema` is mapped back to the server's own `db.schema` like the CLI does. MCP tool errors and
`isError` results become `is_error` tool results. `--fake-record` lines also carry `pid`.

Options (flag or env): `--fake-record <file>` / `FAKE_CLAUDE_RECORD` appends argv, env **key names** (never
values) and stdin lines; `--fake-no-control` / `FAKE_CLAUDE_NO_CONTROL=1` ignores control requests (tests the
fallbacks); `FAKE_CLAUDE_DELAY_MS`, `FAKE_CLAUDE_VERSION`, `FAKE_CLAUDE_HELP`, `FAKE_CLAUDE_WRITE_FILES=0`.

### Fixtures

`fixtures/real-*.jsonl` are sanitized recordings of the real CLI (see [cli-integration](cli-integration.md)):
`real-basic-multiturn` (partials, Read, set_permission_mode, interrupt, `/compact`), `real-permission-review`
(Write and MCP tools through the prompt tool, submit_for_review), `real-subagent` (routed `simple-task`,
async run, denied Bash), `real-resume`, `real-model-error`, `real-mcp-permission-calls` (what the prompt tool
received and answered), `real-stdin-messages` (what was sent). To refresh: rerun a handful of small
`--model haiku` sessions in a throwaway repo, strip hook output, connector lists, plugins, user paths and
`credential_expires_at`, and diff against the parser tests.

### agent-core and mcp-server suites

`packages/agent-core`: parser (all real fixtures), args, reducer, SubagentTracker, cli (help parsing, `.cmd`
quoting with `& | % ^ " ( ) !`), driver (turns, interrupt, setMode, fallbacks, crash, resume, env allow-list,
review feedback), supervisor (queue + permission round trip with Always, review, stop/resume/restore,
crash, rate limit, routed subagents with permission attribution, stop subagent, setMode fallback,
pause/compact/remove). `packages/mcp-server`: mcp.json, secret / Host / Origin checks, exact-id answers,
deny on shutdown, submit_for_review, artifacts tools and resources.
