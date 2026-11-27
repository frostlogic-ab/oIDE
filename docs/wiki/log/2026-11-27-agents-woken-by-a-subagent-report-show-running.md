## [2026-11-27] build | Agents woken by a subagent report show Running, not Has a question

A lead that delegated to background subagents showed "Has a question" while it was busy starting more
subagents. In the event log, a turn ended (`result`) just as the last running subagent reported back,
so `backgroundTasks` was 0 and the status became has-question. The CLI then woke the lead with a new
turn (`init`, text, tool calls) and no user message, so nothing set the status back to running; it
stayed "Has a question" until the lead finally submitted for review. Replaying the stored events of
all local agents found 89 turns like this, each of them preceded by `init`.

The reducer now puts an idle agent (has-question or ready-for-review) back to running when the lead
thinks, writes or calls a tool. Subagent output and a bare `init` do not count. The next `result`
settles the status the usual way, so a submitted review still ends as ready-for-review. A short
has-question (about a second, between the `result` and the woken turn's first output) remains.

Pages: [agent-supervisor](../pages/agent-supervisor.md), [subagents](../pages/subagents.md).
