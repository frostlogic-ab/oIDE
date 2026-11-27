## [2026-11-27] decision | Updates download automatically and install on quit; header Update button

ADR 0018. Settings › Updates gains Download automatically (`updates.downloadAutomatically`) and
Install when oIDE closes (`updates.installOnQuit`), both on by default. A found update now
downloads in the background (main calls `download()`; electron-updater's `autoDownload` stays off)
and installs on quit through electron-updater's `autoInstallOnAppQuit`, after oIDE's quit hooks have
stopped agents. Restarting now is still a click plus a confirm, from Settings or the new header
Update button right of the logo. New telemetry event `update_install_started` (`trigger` header /
settings / quit, `channel`). Pages: [packaging](../pages/packaging.md),
[screen-settings](../pages/screen-settings.md), [desktop-shell](../pages/desktop-shell.md),
[protocol](../pages/protocol.md), [security](../pages/security.md),
[telemetry](../pages/telemetry.md).
