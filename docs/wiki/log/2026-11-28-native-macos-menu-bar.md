## [2026-11-28] build | Native macOS menu bar

On macOS oIDE now has a full native menu bar in the system bar: oIDE (About, Check for Updates,
Settings ⌘,, Hide, Quit), File (New Agent ⌘N, New Window, Open Project Folder ⌘O, Clone, New
Repository, Close Window), Edit (native editing, Find in Files), View (Command Bar, the screens ⌘1…⌘6,
Back / Forward, Toggle Terminal, zoom, full screen), Agent (Jump to Session, Next / Previous, Next
That Needs You, Show Archived), Window and Help (Documentation, Keyboard Shortcuts, Report an Issue,
Show Logs Folder). Windows and Linux stay without a menu bar (decision: macOS only). Items reach the
window as the new `menu.run` event and run the existing command or keymap action
(`keymap.trigger`); shortcuts shown in the menu follow Settings › Keys, and bare-letter keys are never
put on a menu item. The built-in keys moved to `@oide/protocol` (`DEFAULT_KEYBINDINGS`) so main can
show them. Telemetry: `app_menu_used`. Pages: [app-menu](../pages/app-menu.md),
[desktop-shell](../pages/desktop-shell.md), [windows](../pages/windows.md),
[telemetry](../pages/telemetry.md).
