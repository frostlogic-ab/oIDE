## [2026-11-27] build | Usage screen from Tokens today

Clicking **Tokens today** in the status bar now opens a new Usage screen
([screen-usage](../pages/screen-usage.md)): tokens and agent sessions per day (per week for a year)
over 7 days, 30 days or a year, by project, by kind and by model, when sessions start, and a list of
facts about how you work. New IPC `usage.stats`; numbers are built in main from the store.

Storage migration 4 adds `usage_daily`: token samples past the 90-day retention are rolled up per
local day, project and model before deletion, so the year view stays whole
([storage](../pages/storage.md)). Telemetry: `/usage` pageview and the `oide.go.usage` command id
([telemetry](../pages/telemetry.md)); no new event, the pageview answers whether people use it.
