# ADR 0019: Several windows on one profile, one main process

- Status: accepted
- Date: 2026-11-27
- Departs from: the build brief, "Multi-window. v1 is one window." (Process model and repo layout).

## Context
People run agents across several projects and want them side by side, often on two monitors: the
Wall of one project next to the Focus view of another. Starting oIDE a second time only focused the
running window, and a second process on the same profile cannot work anyway: the main process owns
the database, the agent processes, the worktrees, the MCP server and the extension host. A second
`pnpm dev` while oIDE ran also printed Chromium's "Unable to move the cache: Access is denied"
before it quit, because the losing process started Chromium on the locked profile.

## Decision
1. **One main process per profile, any number of windows.** The single-instance lock (per userData
   folder) stays. Every window is a full oIDE on the same profile: projects, agents, settings,
   extensions and artifacts are shared because they live in main. Main → renderer events go to every
   window; the stores already rebuild from `agents.list` / `agents.events`, as after a reload.
2. **Ways to open one**: Ctrl/Cmd+Shift+N and "New window" in the command bar (`app.newWindow`),
   File › New Window and the Dock menu on macOS, the taskbar jump list "New window" task on Windows
   (installed builds), and starting oIDE again while it runs (`second-instance`). The losing process
   now calls `app.exit(0)` right after the lock check instead of `app.quit()`, so it never starts
   Chromium on the profile (no cache error); dev runs print where the window went.
3. **Per-window view state.** The screen, the focused agent and the project scope belong to the
   window. `scope.set` still saves the last choice (new windows and the next launch start on it) but
   is no longer broadcast; the `scope.changed` event is removed. A window scoped to a removed project
   falls back to all projects on `projects.changed`.
4. **The active window** is the one the user focused last (`main/windows.ts`). It parents dialogs
   (folder pickers, confirms), is raised by OS notification clicks, and alone receives
   `extensions.panelOpen` (`ctx.emitActive`), so an extension panel opens once, not in every window.
5. **Quit** stays as before: closing the last window quits (agents stop through the quit hooks);
   closing any other window leaves agents running.
6. **Telemetry**: `window_opened { trigger, windows }` answers whether people use more than one
   window and how they open them.

## Consequences
- Answering a permission prompt in one window updates every window (the request id is the key).
- Two windows can edit the same file in the Files editor; the last save wins, as with two editors.
- A dev build started while the installed oIDE runs on the same profile opens a window in the
  installed app. Set `OIDE_USER_DATA` to run a dev build on its own profile.
