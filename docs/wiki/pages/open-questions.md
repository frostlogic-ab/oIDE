# Open questions and risks

The build brief's table ([raw/build-brief.md](../raw/build-brief.md), "Open questions and risks") with a
**Finding** column. Findings for questions 2, 4, 6, 7, 8, 9 and 10 come from real CLI 2.1.325 sessions on
2026-11-24; details in [cli-integration](cli-integration.md) and [subagents](subagents.md).

| # | Question or risk | Default until answered | Finding |
| --- | --- | --- | --- |
| 1 | Does Anthropic accept oIDE driving the user's own CLI, many sessions at once, on a Pro or Max plan? | Build as designed; ask before any public release; API-key mode as a fallback | Open (needs Georges to ask Anthropic). |
| 2 | Is stream-json stable enough, and which control messages (mode change, interrupt) are supported? | Pin a tested range, parse in one package, weekly fixture diff | **Answered for 2.1.325.** `control_request` `interrupt` and `set_permission_mode` both work and return `control_response` `success` (`{still_queued:[]}` / `{mode}`); the mode change is echoed as `system/status {permissionMode}`. Fallbacks (SIGINT, interrupt + `--resume`) are implemented and tested against fake-claude. The format carries many fields oIDE ignores; the parser keeps unknown types as `unknown` events. |
| 3 | Raw CLI or the Agent SDK pointed at the user's binary? | Raw CLI behind `AgentDriver` | Raw CLI shipped (`ClaudeCliDriver`). Open until question 1. |
| 4 | Where do plan usage percentages and reset times come from? | Tokens per agent and rate-limit reset times; hide meters | **New source found:** every turn emits `rate_limit_event.rate_limit_info` with `status`, `resetsAt`, `rateLimitType` (`seven_day`, …) and `unifiedWindows.<window>.utilization` (0.65 = 65%). Surfaced as `plan-usage` events and `AgentSummary.planUsage`. Only the window the CLI reports is known (one at a time), so a full Session/Week pair may not always be available. |
| 5 | Is there an API or connector for claude.ai artifacts? | Local artifacts plus manual import | Open. |
| 6 | Exact names for Auto mode, effort level and subagent model settings | Detect from `--help`, hide what is missing | **Auto:** `--permission-mode auto` (accepted, init reports `auto`). Help lists `manual` instead of `default`; `default` is still accepted. New mode `dontAsk`. **Effort:** `--effort low|medium|high|xhigh|max` (per session). **Subagent model:** `CLAUDE_CODE_SUBAGENT_MODEL` env var (not verified in a session); `--agents` definitions take a `model` per subagent (verified). |
| 7 | Does `/compact` work when sent through stream-json input? | Tell the user to compact in the Raw terminal | **Yes.** A user message with content `"/compact"` compacts (status `compacting`, `compact_boundary` with pre/post tokens, `result` with `local_command:"compact"`). |
| 8 | Do subagent events, usage and permission prompts carry the parent Task id? | Show subagents from Task calls and results only | **Yes for events and usage** with `--forward-subagent-text`: subagent `assistant`/`user` lines (text, tool_use, tool_result, usage) carry `parent_tool_use_id` = the lead's `Agent` tool_use id. **Permission prompts** carry only the subagent's own `tool_use_id`, which oIDE maps to the subagent via its tagged tool_use. Also: the tool is now `Agent` (not `Task`), subagents may run **async** (the lead's turn ends first; the report arrives in `system/task_notification.summary`), and `system/task_*` events give start, progress, end and total tokens. |
| 9 | Can one subagent be stopped on its own? | Deny its next tool call with a stop message; otherwise hide the button | No control message found for it. Implemented the default: `stopSubagent` denies the subagent's pending and next prompts with a stop message. It only bites when the subagent's next tool needs a prompt (not for auto-allowed tools such as Read). |
| 10 | Per-subagent effort in `--agents` definitions | Effort on the lead only, tiers labelled by model | `effort` inside an `--agents` definition is accepted without error, but nothing in the stream shows whether it is applied. oIDE passes it and labels it unverified. |
| 11 | Plan limits with 6+ agents and their subagents | Max running 3, queue, clear limit errors, subagent token share | Implemented: queue with `maxRunning`, `rate-limited` status with reset time and no retry, `subagentTokenShare()`. |
| 12 | Extension and custom-tool sandboxing | Consent dialog, no install scripts, hash check | Open (extension host). |
| 13 | Remote MCP servers without dynamic client registration | Paste a client id or a header token | Open (marketplace). |
| 14 | Code signing accounts and costs | Unsigned betas | Open. |
| 15 | Licence and name check | Apache-2.0 (guess) | Repo is MIT today (see LICENSE). |
| 16 | Whiteboard library licence | Excalidraw | Open. |
