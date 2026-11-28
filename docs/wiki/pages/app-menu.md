# macOS menu bar

On macOS oIDE has a full native menu bar in the system bar at the top of the screen, like every Mac
app. Windows and Linux get no menu bar: packaged builds remove Electron's default one, and the
command bar (Mod+K) has every item. Shell: [desktop-shell](desktop-shell.md). Windows:
[windows](windows.md). Telemetry: [telemetry](telemetry.md).

## The menus

| Menu | Items |
| --- | --- |
| **oIDE** | About oIDE · Check for Updates… · Settings… ⌘, · Services · Hide oIDE ⌘H, Hide Others, Show All · Quit oIDE ⌘Q |
| **File** | New Agent… ⌘N · New Window ⇧⌘N · Open Project Folder… ⌘O · Clone Repository… · New Repository… · Close Window ⌘W |
| **Edit** | Undo, Redo, Cut, Copy, Paste, Paste and Match Style, Delete, Select All (native) · Find in Files… ⇧⌘F; macOS adds AutoFill, Dictation and Emoji & Symbols |
| **View** | Command Bar… ⌘K · Agents ⌘1, Artifacts ⌘2, Files ⌘3, Source Control ⌘4, Marketplace ⌘5, Usage ⌘6 (left rail order) · Back ⌥←, Forward ⌥→ · Toggle Terminal ⌃\` · Actual Size, Zoom In, Zoom Out · Enter Full Screen · dev runs only: Reload, Force Reload, Toggle Developer Tools |
| **Agent** | Jump to Session… · Next Agent, Previous Agent, Next That Needs You · Show Archived Agents |
| **Window** | Electron's `windowMenu` role: Minimize ⌘M, Zoom, Bring All to Front and the list of open windows |
| **Help** | oIDE Documentation · Keyboard Shortcuts · Report an Issue… · Show Logs Folder; macOS adds its search box |

## How it works

- `apps/desktop/src/main/app-menu.ts` builds the template (`buildAppMenuTemplate`, pure and unit
  tested); `installAppMenu` in `main/index.ts` sets it once the services exist and rebuilds it when
  `settings.keybindings` changes.
- Item ids are the `AppMenuItem` enum in `packages/protocol/src/menu.ts`. Items that act in the
  window (`AppMenuWindowItem`) go to the window the user used last as the `menu.run` event (Zod
  validated like every event). `renderer/src/lib/appMenu.ts` maps each one to a command bar command
  (`oide.go.files`, `oide.spawn`, …) or to a keymap action run through the active scopes with
  `keymap.trigger` (Back, Forward, Next / Previous Agent, Toggle Terminal). So a menu item does exactly
  what its shortcut or command does. Toggle Terminal opens Files when the Files screen is not showing.
- New Window, the Help links and Show Logs Folder run in main. The Help links are on the external URL
  allow-list (`getoide.com`, `github.com`).
- **Shortcuts.** Items whose key belongs to the window keymap (New Window, Find in Files, Command Bar,
  Back, Forward, Toggle Terminal) show the user's binding: an override in `settings.keybindings`
  (Settings › Keys), else `DEFAULT_KEYBINDINGS` from the protocol (the keymap's defaults too). The menu's
  own keys (⌘, ⌘N ⌘O ⌘1…⌘6) are fixed. Electron always registers accelerators on macOS
  (`registerAccelerator: false` is Windows/Linux only); Chromium gives the page each key first and only
  hands it to the menu when the page did not handle it, so a key never runs twice.
- **No bare keys on menu items.** A combo without Cmd, Ctrl or Alt (J, K, N, Shift+Tab) is never put on
  a menu item (`toAccelerator` returns undefined): an unhandled key goes to the menu, so it would fire
  while typing in a text field. Those items show no shortcut; the keys still work in the window.
- Telemetry: `app_menu_used` (`item`: the menu item id) for the items oIDE handles, not the native
  roles (Copy, Minimize, …). New Window also sends `window_opened` with `trigger: menu`.
- The Dock menu (New Window) is separate: `app.dock.setMenu` in `main/index.ts`.
