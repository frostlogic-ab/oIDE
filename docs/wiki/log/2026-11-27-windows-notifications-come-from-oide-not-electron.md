## [2026-11-27] build | Windows notifications come from oIDE, not Electron
Same root cause as the blank taskbar icon above: Windows names a toast's sender after the Start Menu
shortcut with its AUMID, so a dev `Electron.lnk` holding `dev.oide.app` made the installed app's
notifications come from "Electron". The AUMID split and `releaseForeignShortcuts` fix it; added a test
that the installed AUMID stays equal to electron-builder `appId`. See [packaging](../pages/packaging.md).
