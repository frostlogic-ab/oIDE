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
| any + `/compact` | compacting status, `compact_boundary`, local-command stdout, result `local_command:"compact"` |

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
