# Multiple windows

oIDE can show several windows at once, all on the same profile: the same projects, agents,
settings, extensions and artifacts. Decision: [ADR 0019](../../adr/0019-multiple-windows-one-profile.md).
Shell: [desktop-shell](desktop-shell.md). Telemetry: [telemetry](telemetry.md).

## Opening a window

| Where | How | `window_opened.trigger` |
| --- | --- | --- |
| Any window | Ctrl/Cmd+Shift+N (`app.newWindow` keymap action, rebindable) | `shortcut` |
| Command bar | "New window" (`oide.newWindow`) | `command` |
| macOS menu bar | File › New Window | `menu` |
| macOS Dock | right-click › New Window | `dock` |
| Windows taskbar | right-click › New window (jump list task, installed builds; runs `oIDE.exe --oide-new-window`) | `taskbar` |
| Starting oIDE again | Start menu, desktop shortcut, a second `pnpm dev` | `relaunch` |

A new window opens one step (28 px) down and right of the active window, at its size, and maximized
when it is; it wraps to the top-left of that display's work area when the step would leave it
(`cascadePosition` in `apps/desktop/src/main/windows.ts`). The first window of a launch uses the
saved bounds (`window-state.json`); every window saves its bounds when moved, resized or closed, so
the last one wins.

## One process, one profile

The single-instance lock is per userData folder. A second start on the same profile asks the
running process for a window (`second-instance`) and exits with `app.exit(0)` right after the lock
check, before Chromium opens the profile (the old `app.quit()` let it start and print "Unable to
move the cache: Access is denied"). Unpackaged runs print a line saying where the window went. To
run a dev build next to the installed oIDE, set `OIDE_USER_DATA` to another folder.

## What is shared and what is per window

- **Shared (main)**: the database, projects, agents and their transcripts, permission prompts,
  settings, extensions, artifacts, terminals, git state. Every main → renderer event goes to every
  window (`ctx.emit`), and each window's stores load the same state at boot.
- **Per window (renderer)**: the screen and its history, the focused agent, open Files tabs, panel
  layout, and the **project scope**. `scope.set` saves the last choice so new windows and the next
  launch start on it, but other open windows keep theirs. When a window's scoped project is removed
  (in any window) it shows all projects again (`connectScope` listens to `projects.changed`).
- **Active window** (`WindowRegistry` in `main/windows.ts`, the window focused last): parents
  dialogs (`ctx.getWindow()`), is raised by OS notification clicks, and is the only window that gets
  `extensions.panelOpen` (`ctx.emitActive`), so an extension's `ctx.panels.open` opens one panel.

Closing a window with others open leaves agents running. Closing the last one quits oIDE as before
(on macOS too).

Each window has its own renderer watchdog (crash reload, unresponsive prompt); a crash in one window
does not touch the others or the agents.
