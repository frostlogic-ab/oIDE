## [2026-11-27] build | Auto-fetch projects and Pull from the Projects sidebar

A main checkout left behind its upstream means new agents branch from old code. The background fetch
used to run only every fetch interval (first round 10 minutes after launch) and nothing in the Wall
said a project was behind. Now `GitService` also fetches trusted projects with a remote 15 s after
launch and on window focus when the last round is 3+ minutes old (never when the interval is 0 or
offline; one round at a time), and the Wall's Projects sidebar shows an amber **Pull N** button next
to any project whose main checkout is behind (`git.pull --ff-only`, `from: 'sidebar'`). New telemetry
event `project_pulled { from }`. Pages: [screen-wall](../pages/screen-wall.md),
[desktop-shell](../pages/desktop-shell.md), [screen-source-control](../pages/screen-source-control.md),
[telemetry](../pages/telemetry.md).
