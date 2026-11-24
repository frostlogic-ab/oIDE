# ADR 0007: The status bar shows plan meters from the CLI's rate_limit_event

- Status: accepted
- Date: 2026-11-24
- Departs from: build brief, Context ring and plan usage ("v1 ... hides the percentage meters until a supported source exists"), open question 4

## Context
The brief hides the Session / Week percentage meters because no documented source was known. The
Claude Code CLI (2.1.x) emits `rate_limit_event` on every turn in stream-json, with
`rate_limit_info.utilization`, `resetsAt` and per-window values (see [cli-integration](../wiki/pages/cli-integration.md)).
This is the CLI's own output on stdout, not a scraped screen and not an API call.

## Decision
agent-core turns `rate_limit_event` into `plan-usage` events and `AgentSummary.planUsage`. The status
bar (`components/frame/PlanUsage.tsx`) shows a meter only when an event carried a utilization; without
one it shows only the reset time. It never guesses a percentage.

## Consequences
- The meters appear only once an agent has run a turn, and reflect the latest event.
- If the CLI drops the field, the meter disappears and the reset time remains (no breakage).
