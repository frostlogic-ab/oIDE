# CLI integration (verified)

What oIDE knows about the Claude Code CLI's stream-json mode, checked against the real CLI **2.1.325**
on Windows 11 (2026-11-24) in five small `--model haiku` sessions. Sanitized recordings are the
fixtures in `tools/fake-claude/fixtures/real-*.jsonl` (paths rewritten to `C:\work\repo`, hook output,
connector lists and plugin data removed). The parser in `packages/agent-core/src/parser.ts` is tested
against them. Source for the flags: [raw/claude-cli-help-2.1.325.txt](../raw/claude-cli-help-2.1.325.txt).

Related: [agent-supervisor](agent-supervisor.md), [subagents](subagents.md), [mcp-server](mcp-server.md),
[open-questions](open-questions.md), [testing](testing.md).

## Launch line (what `buildLaunch` produces)

```
claude -p --verbose --input-format stream-json --output-format stream-json
  --include-partial-messages --forward-subagent-text
  --session-id <uuid>              # or --resume <session id>
  --model <alias or id> [--effort <low|medium|high|xhigh|max>]
  --permission-mode <default|acceptEdits|plan|auto|bypassPermissions>
  --mcp-config <app-data>/agents/<id>/mcp.json
  --permission-prompt-tool mcp__oide__permission_prompt
  --append-system-prompt <oIDE contract + system-prompt techniques>
  [--agents <json>]                # routed strategy only
  [--allowedTools a,b] [--disallowedTools c,d]
  <extra flags from Settings, shell-split, protocol flags removed>
```

| Flag | Verified | Note |
| --- | --- | --- |
| `--permission-mode` | yes | Choices in help: `acceptEdits, auto, bypassPermissions, manual, dontAsk, plan`. `default` is still accepted as a hidden alias of `manual`. Invalid values exit 1 with an error. |
| `--permission-mode auto` | yes | Accepted; init reports `permissionMode: "auto"`. |
| `--effort` | yes | `low, medium, high, xhigh, max`. Unknown values print a warning and are ignored (exit 0). |
| `--session-id` / `--resume` | yes | `--resume <id>` keeps the same `session_id` and the model remembers the earlier turns. |
| `--include-partial-messages` | yes | Adds `stream_event` lines (Anthropic SSE events). |
| `--forward-subagent-text` | yes | Subagent messages arrive with `parent_tool_use_id`. |
| `--agents <json>` | yes | Inline JSON works with `-p`; the names appear in init `agents`. An `effort` key in a definition is accepted without error (whether it is applied is not observable). |
| `--permission-prompt-tool` | yes | See below. |
| `--mcp-config` | yes | HTTP servers with `headers` work; the CLI sends them on every request (`User-Agent: claude-code/2.1.325 (sdk-cli)`, no `Origin`). |
| `--permission-prompts host\|none` | listed | New in this version; oIDE keeps the default `host`. |

Features are detected at startup from `claude --help` (`detectCli` → `CliInfo.features`, keys like
`effort`, `mode:auto`, `forward-subagent-text`); controls whose feature is missing are hidden and
`buildLaunch` drops the flag with a warning.

## stdin: user messages and control requests

```json
{"type":"user","message":{"role":"user","content":"Reply with exactly: hello"}}
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"…"}]}}
```

- One long-lived process handles many turns: send the next user message after `result`.
- **Slash commands work as user messages**: `"content":"/compact"` → `system/status {status:"compacting"}`,
  `system/status {compact_result:"success"}`, `system/init`, `system/compact_boundary {compact_metadata:{trigger:"manual",pre_tokens,post_tokens}}`,
  a replayed user message `<local-command-stdout>Compacted </local-command-stdout>` and a `result` with `local_command:"compact"`.
- Control requests (answered with `control_response` on stdout):

```json
{"type":"control_request","request_id":"req-mode-1","request":{"subtype":"set_permission_mode","mode":"plan"}}
→ {"type":"control_response","response":{"subtype":"success","request_id":"req-mode-1","response":{"mode":"plan"}}}
  then {"type":"system","subtype":"status","status":null,"permissionMode":"plan"}

{"type":"control_request","request_id":"req-int-1","request":{"subtype":"interrupt"}}
→ {"type":"control_response","response":{"subtype":"success","request_id":"req-int-1","response":{"still_queued":[]}}}
  then user "[Request interrupted by user]" and result {subtype:"error_during_execution", is_error:true, terminal_reason:"aborted_streaming"}
```

The init `capabilities` list (`interrupt_receipt_v1`, `msg_lifecycle_v1`, …) hints at more control
messages; oIDE uses only the two above. If the CLI sends a `control_request` to us (for example
`can_use_tool` without a prompt tool), the driver answers with an error response.

## stdout event shapes

| Raw line | Fields oIDE reads | Normalized event |
| --- | --- | --- |
| `system/init` | `session_id, model, cwd, tools[], mcp_servers[{name,status}], permissionMode, claude_code_version, agents[]` | `init` (emitted again at the start of **every** turn) |
| `system/status` | `status` (`requesting`, `compacting`, null), `permissionMode`, `compact_result` | `mode-changed`, `compact` |
| `system/compact_boundary` | `compact_metadata.pre_tokens/post_tokens` | `compact` (done) |
| `system/task_started` / `task_progress` / `task_updated` / `task_notification` | `task_id, tool_use_id, description, subagent_type, status, summary, usage.total_tokens` | `subagent-task` |
| `system/background_tasks_changed` | `tasks[]` | `background-tasks` (count) |
| `system/hook_*`, `commands_changed`, `thinking_tokens` | (ignored; hook output may hold user data and is not stored as events) | none |
| `stream_event` | `event.delta.{text_delta,thinking_delta,input_json_delta}`, `parent_tool_use_id`, `api_message_id` | `partial` (not persisted) |
| `assistant` | `message.{id,model,content[],usage}`, `parent_tool_use_id`, `error` | `assistant-text`, `thinking`, `tool-use`, `usage`, plus `error`/`rate-limit` |
| `user` | `message.content` (string or blocks), `tool_result{tool_use_id,content,is_error}`, `parent_tool_use_id` | `user-text`, `tool-result` |
| `result` | `subtype, is_error, result, num_turns, duration_ms, total_cost_usd, usage, modelUsage{model:{contextWindow}}, api_error_status, local_command, permission_denials` | `result` (+ `rate-limit` on 429, `error{code:auth}` on 401) |
| `rate_limit_event` | `rate_limit_info.{status,resetsAt (unix s),rateLimitType,utilization,unifiedWindows}` | `plan-usage`; `rate-limit` when `status:"rejected"` |
| `control_response` | `response.{subtype,request_id,response,error}` | resolves the driver's pending control request |

Details worth knowing:

- `system/init.slash_commands` (e.g. `["compact","context","init"]`) becomes `init.slashCommands`; Focus's `/`
  menu lists them. A malformed list is dropped, never fatal.
- One API message is split into several `assistant` lines (one per content block) that **repeat the same
  `message.id` and `usage`**. Usage is de-duplicated by message id.
- Haiku 5.5 thinking blocks come back with empty `thinking` text and a signature; oIDE only shows "Thinking…".
- Each `user` tool_result carries `tool_use_result` (structured: file, structuredPatch, stdout…) and
  `tool_result_meta[{permission_decision:{decision,source,reason_type}}]`.
- `result.modelUsage[*].contextWindow` is the authoritative window (**1,000,000** for `claude-haiku-5-5`
  and `claude-sonnet-5-5`), so the reducer prefers it over `contextWindowFor()`.
- `result` also has `credential_expires_at`; oIDE ignores it and the fixtures strip it.
- A bad model gives an `assistant` with `model:"<synthetic>"`, `error:"model_not_found"`, then a `result`
  with `is_error:true, api_error_status:404, terminal_reason:"api_error"`, then exit code 1.
- `rate_limit_event` arrives once per turn even when allowed; `unifiedWindows.seven_day.utilization` is
  plan usage (open question 4). A real rejection was not observed; the parser treats `status:"rejected"`,
  assistant `error:"rate_limit"` and `api_error_status:429` as a limit hit (shapes partly guessed).
- Plan mode on this account switched the model to Sonnet (the user's own `opusplan`-style setting); the
  model in `message.model` is the truth, not the `--model` flag.

## Permission prompt tool contract

The CLI calls the MCP tool named in `--permission-prompt-tool` (oIDE: `mcp__oide__permission_prompt`):

```json
arguments: {"tool_name":"Bash","input":{"command":"mkdir deny-me-dir","description":"…"},"tool_use_id":"toolu_01VB…"}
_meta:     {"progressToken":2,"claudecode/toolUseId":"toolu_01VB…"}
```

and expects a text content holding one of:

```json
{"behavior":"allow","updatedInput":{…the (possibly edited) input…}}
{"behavior":"deny","message":"Denied by test server"}
```

- A deny becomes the tool_result `{"is_error":true,"content":"<message>"}` with
  `tool_result_meta.permission_decision {decision:"reject",source:"user_reject"}`.
- MCP tools themselves (including `mcp__oide__submit_for_review`) also go through the prompt unless
  allowed, so `buildLaunch` pre-allows the oIDE read-only tools.
- Read-only commands (`echo …`) and `Read` are auto-allowed by the CLI and never reach the prompt.
- The prompt tool is hidden from the model's tool list; MCP tools are deferred and loaded by the model
  through `ToolSearch` (`select:mcp__oide__submit_for_review`), so the system prompt names the tool exactly.
- Prompts from subagents carry the **subagent's** tool_use id; oIDE maps it to the subagent through the
  `parent_tool_use_id` of the matching `tool-use` event.

## MCP tool names (verified 2026-11-24, CLI 2.1.325)

One real `claude -p --model haiku` run with a stdio MCP server `probe` that lists the tools `db.schema`,
`plain_tool` and `with space+plus` gave, in the `init` event's `tools`:

```
mcp__probe__db_schema  mcp__probe__plain_tool  mcp__probe__with_space_plus
```

- Every character outside `[A-Za-z0-9_-]` in a tool name becomes `_` (`.`, space and `+` each map to
  one `_`). The model loaded it with `ToolSearch select:mcp__probe__db_schema` and called it by that name.
- `--allowedTools mcp__probe__db_schema` pre-allowed the call (no permission prompt, no denial), so
  allow and deny rules must use the normalized name.
- `resolveAgentMcpConfig` / `mcpToolName` (extension-host) already normalize this way, and since this
  check `buildLaunch` normalizes `ExtensionToolRef` server and tool names the same way.
- Server names were not tested with special characters: manifests and custom servers only allow `[A-Za-z0-9_-]`.

## Windows `.cmd` shims and multi-line arguments

`cmd.exe` ends the command line at a newline, so a multi-line `--append-system-prompt` passed through
`cmd.exe /d /s /c` silently drops every later flag (`--allowedTools`, extra flags). `resolveSpawn` now
detects a newline in any argument for a `.cmd`/`.bat` target, reads the shim, and when it is an
npm-style shim (`"%dp0%\node_modules\…\cli.js"`, or `"%~dp0x.mjs"` like fake-claude's) runs that script
with Node directly (`node` from PATH inside Electron). Other shims get newlines replaced by spaces.
`claude.exe` (the native installer) is spawned directly and is not affected.

## Fallbacks

| Feature | Primary | Fallback |
| --- | --- | --- |
| Mode change (Shift+Tab) | `set_permission_mode` control request | interrupt + dispose, respawn with `--resume` and the new mode |
| Stop / Pause | `interrupt` control request | SIGINT (on Windows this terminates the process); `dispose` then kills the tree (`taskkill /T /F`) |
| Auto mode | `--permission-mode auto` | `default` plus oIDE allow rules, when help lacks `auto` |
| Effort | `--effort` | hidden when help lacks it |
| `.cmd` shim on Windows | spawn without a shell | `cmd.exe /d /s /c` with cross-spawn style escaping (tested with `& | % ^ " ( ) !`) |
