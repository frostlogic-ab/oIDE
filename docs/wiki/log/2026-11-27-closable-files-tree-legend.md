## [2026-11-27] build | Closable Files tree legend

The legend under the Files tree (agent dots, M and D) now has a × in its top-right corner. Closing it
saves `settings.ui.filesLegendHidden` (new, default `false`), so it never shows again and the tree
takes the room. `ui.filesLegendHidden` joins `TELEMETRY_SETTING_KEYS` so `setting_changed` tells us
whether people close it. Pages: [screen-files](../pages/screen-files.md), [telemetry](../pages/telemetry.md).
