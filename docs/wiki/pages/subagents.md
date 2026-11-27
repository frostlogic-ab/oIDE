# Subagents (`SubagentTracker`)

Every subagent view (Wall chips, Focus agent tree, subagent cards, Subagents tab, timeline, per-subagent
transcript and context ring) comes from one `SubagentTracker` per agent, inside the agent's
`AgentReducer` (`packages/agent-core/src/subagents.ts`). oIDE never starts subagents itself.
Raw facts: [cli-integration](cli-integration.md); questions 8 to 10: [open-questions](open-questions.md).
Owner: [agent-supervisor](agent-supervisor.md).

## What the CLI sends (2.1.325, `--forward-subagent-text`)

1. The lead calls the `Agent` tool (older CLIs: `Task`) with `{subagent_type, description, prompt}`.
2. `system/task_started {task_id, tool_use_id, description, subagent_type, is_backgrounded}` and
   `system/background_tasks_changed {tasks:[…]}` when it runs async.
3. The lead's `tool_result` for the Agent call: the report (foreground) or
   `"Async agent launched successfully…"` (async). With async runs the lead's turn can end (`result`)
   while the subagent keeps working.
4. Subagent `assistant` / `user` lines, each with `parent_tool_use_id` = the Agent tool_use id, including its
   tool_use blocks, tool_results and `usage`.
5. `system/task_progress {last_tool_name, usage.total_tokens}`, `system/task_updated {patch:{status:"completed"}}`,
   `system/task_notification {tool_use_id, status, summary}`, `background_tasks_changed {tasks:[]}`.
6. The CLI wakes the lead with a new turn (new `init`, assistant text, `result`) without a user message.
   The reducer puts an idle agent (has-question, ready-for-review) back to running on the lead's first
   thinking, text or tool call in that turn, so the tile says Running while the lead acts on the report.

## Mapping

| Shown | Derived from |
| --- | --- |
| Exists, name, task | Lead `tool-use` of `Agent`/`Task`: `description` (name), `prompt` (task) |
| Tier, model, effort | `subagent_type` matched to the `--agents` definitions (`simple-task` / `standard-task` / `complex-task` → tier and slot) via `subagentTiers(strategy)`; other types get tier `custom` |
| Status | `queued` at the tool_use; `running` on `task_started` or the first tagged event; `needs-permission` while a prompt for one of its tool calls is pending; `done` / `error` / `stopped` from `task_notification` / `task_updated` status or the lead's tool_result; anything still running is `stopped` on process exit |
| Transcript | Tagged events (no partials), up to 2000 per subagent: `supervisor.subagentTranscript(agentId, subId)` |
| Tokens and context ring | Tagged `usage` events, de-duplicated by message id; `contextUsed` = latest input + cache read + cache creation; `contextWindow` from the subagent's own model (learned window, else the table) |
| Report | `task_notification.summary`, or the lead's tool_result content (foreground) |
| Timeline | `startedAt` / `endedAt` (event timestamps) |
| "Subagents have used 38% of this agent's tokens" | `tracker.tokenShare(leadUsage)` → `supervisor.subagentTokenShare(agentId)` |
| Chip counts ("2 of 3 running", "1 needs you") | `tracker.counts()` |
| Permission attribution | The prompt's `tool_use_id` looked up in the tool ids seen inside each subagent (`ownerOfToolUse`) |
| Stop subagent | `requestStop(id)`; the supervisor denies its pending and next prompts with a stop message |

Every change is also emitted as a `subagent` event (persisted) so Focus can rebuild history.
