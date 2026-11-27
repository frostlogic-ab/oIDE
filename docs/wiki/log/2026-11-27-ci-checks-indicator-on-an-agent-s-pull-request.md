## [2026-11-27] build | CI checks indicator on an agent's pull request
Tiles, the Focus header and Review now show the CI status of an agent's open PR next to its state
badge: running ("7/9", amber), passed (green) or failed ("2 failed", red), opening the PR's Checks
tab. Counted from gh's `statusCheckRollup`; PRs with running checks are polled every minute until they
finish, and a push watches for new checks for 10 minutes. New telemetry: `pr_checks_finished`,
`pr_checks_opened`. See [screen-wall](../pages/screen-wall.md) and [telemetry](../pages/telemetry.md).
