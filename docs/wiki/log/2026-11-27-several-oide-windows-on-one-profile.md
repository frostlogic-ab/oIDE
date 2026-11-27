## [2026-11-27] decision | Several oIDE windows on one profile

ADR 0019, departing from the build brief's "v1 is one window". One main process per profile now
drives any number of windows (`main/windows.ts`: `WindowRegistry`, `cascadePosition`); every event
goes to every window. Open one with Ctrl/Cmd+Shift+N, "New window" in the command bar
(`app.newWindow`), File › New Window and the Dock menu on macOS, the taskbar jump list on Windows,
or by starting oIDE again (`second-instance` now opens a window instead of focusing). The losing
process exits with `app.exit(0)` before Chromium opens the profile, which ends the "Unable to move
the cache: Access is denied" line on a second `pnpm dev`. The project scope is per window: `scope.set`
is saved but no longer broadcast, and the `scope.changed` event is gone. Dialogs, notification clicks
and `extensions.panelOpen` (`ctx.emitActive`) go to the window focused last. New telemetry event
`window_opened` (`trigger`, `windows`). Pages: [windows](../pages/windows.md),
[desktop-shell](../pages/desktop-shell.md), [telemetry](../pages/telemetry.md).
