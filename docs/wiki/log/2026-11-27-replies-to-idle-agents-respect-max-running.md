## [2026-11-27] build | Replies to idle agents respect Max running

A user saw 4 agents running with Max running at 3: the 4th was an idle agent (Ready for review)
woken by a reply. `Supervisor.send` delivered to any live process at once, and idle agents hold no
slot, so the reply bypassed the cap (hard rule 6). Now a reply to an idle live process (and messages
flushed on Resume) goes through `wake()`: it is delivered only when a slot is free and nobody is
queued ahead, otherwise the agent shows `queued` with its process kept alive and `pump()` hands it
the held messages when a slot frees, without a relaunch. Agents already working still get replies
directly. See [agent supervisor](../pages/agent-supervisor.md).
