## [2026-11-27] decision | Drop the agent counters from the Wall and Focus header

The `command` header (Wall, Focus, Spawn) no longer shows "N running · N subagents · N need you"
next to the command-bar trigger. The user found them redundant: the Wall's filter chips, tiles and
subagent chips, and the status bar, already show how many agents run, their subagents and what
needs you. This departs from the Mission Control canvas, which draws the counters; by user request.
`HeaderCounts` and the `ScreenDef.counts` field are gone; `useAgentCounts` stays in the store.
Pages: [desktop-shell](../pages/desktop-shell.md), [screen-wall](../pages/screen-wall.md).
