## [2026-11-27] build | Send the oIDE version on app_started

The app version already went to Umami as session data (`identify`, `app_version`) and as `release`
on error reports, but no event carried it, so Umami's Events › Properties breakdown could not show
it. `app_started` now has an `app_version` property (`AppVersionValue`: a version such as `0.5.1`, or
`unknown`, never free text; `appVersionValue()` in `@oide/protocol`). The `unknown` fallback means an
odd version string cannot get the whole start-up event dropped. [telemetry](../pages/telemetry.md)
now has a section on where each view of the version is in Umami (per install, per launch, per error).
