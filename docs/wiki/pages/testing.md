# Testing

How oIDE is tested. Each section is owned by the package that needs it; add a section rather than
rewriting others. Related: [agent-supervisor](agent-supervisor.md), [cli-integration](cli-integration.md).

## Unit and integration tests (Vitest)

- `pnpm test` (root `vitest.config.ts`): co-located `packages/*/src/**/*.test.ts`, plus `packages/*/test`,
  `tools/*/test`, `test/`. Default timeout 20 s.
- Agent tests never need a Claude login: they run against `tools/fake-claude`.
- `test/no-credentials.test.ts` fails the build if a Claude credential location appears in code.

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
