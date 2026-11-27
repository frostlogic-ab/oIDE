# Usage screen

Opened by clicking **Tokens today** in the status bar (or *Go to Usage* in the command bar). Shows how
you work with oIDE over the **last 7 days, 30 days or year** (a segmented control above everything;
the range is a route param, `usage { range? }`, so Back returns to it; 7 days by default). It has no rail item and no design screen in
[raw/design](../raw/design/); it follows the [design system](design-system.md).

Code: `apps/desktop/src/renderer/src/screens/Usage/` (`index.tsx`, pure helpers in `model.ts`),
`apps/desktop/src/main/services/usage-stats.ts`, IPC `usage.stats { range }` → `UsageStats`
(`packages/protocol/src/usage.ts`).

## What it shows

- **Tiles**: tokens (with the change against the same number of days before), agent sessions
  (subagents spawned), active days and the running streak, projects.
- **Tokens per day** and **Agent sessions per day** (per week for a year: 52 bars, the last ending
  today, the first also taking the odd 365th day). Two charts, never one with two axes. Single-hue accent columns, hover and keyboard focus
  show a tooltip; a screen-reader table carries every value.
- **By project**: sessions and tokens per project, most tokens first. Tokens of agents whose project
  was removed (or samples with no agent) fold into one "Removed or unknown project" row.
- **Token mix**: input, output, cache read, cache write, and **Models** (tokens per model id as the
  CLI named it).
- **When you start sessions** (local hour) and **Sessions by weekday**.
- **How you work**: peak hour, busiest weekday, busiest day, longest streak, tokens per session,
  typical (median) session length start to end, share served from cache, share in worktrees, merged
  and discarded, parallel attempts, subagents per session. A fact is left out when the range has no
  data for it.

## Where the numbers come from

Everything is local, from oIDE's own [storage](storage.md); nothing is asked of Anthropic and nothing
is sent anywhere (only the `/usage` pageview, if telemetry is on; see [telemetry](telemetry.md)).

- **Tokens** are the `usage_samples` the CLI's usage events produce (input + output + cache read +
  cache creation, the same sum as *Tokens today*). Samples are kept 90 days; at startup older ones
  are summed into `usage_daily` (one row per local day, project and model) before they are deleted,
  so the year view stays complete. Data from before this rollup existed (older than 90 days at the
  time) is already gone.
- **Sessions** are `agents` rows by `created_at`, so archived agents count; deleted agents do not.
- **Days** are local calendar days. The rollup uses the UTC offset at the time it runs, so a day
  next to a daylight-saving change can be off by an hour at its edges.
