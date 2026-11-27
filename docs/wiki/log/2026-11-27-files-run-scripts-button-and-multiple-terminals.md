## [2026-11-27] build | Files Run scripts button and multiple terminals

Files › tree toolbar gets a Run button when main finds run scripts in a shown checkout (package.json
scripts with the right package manager, deno tasks, composer scripts, Makefile targets, just
recipes, and fixed verbs for Cargo, Go, .NET, Gradle, Maven and Django). Picking one opens a new
terminal that types the command into an interactive shell, as VS Code's Run Script does; only a
script id crosses IPC (`terminal.runScript`), so SEC-05 holds. Terminals are now multi-session: a
Files terminal panel under the editor (Terminal header button, Ctrl+`) and Focus › Terminal both
use `components/terminal/TerminalTabs.tsx` (tabs, new, close/kill), and sessions outlive their view
(`stores/terminals.ts`). New telemetry event `script_run { runner }`.

Pages: [screen-files](../pages/screen-files.md), [screen-focus](../pages/screen-focus.md),
[security](../pages/security.md), [telemetry](../pages/telemetry.md).
