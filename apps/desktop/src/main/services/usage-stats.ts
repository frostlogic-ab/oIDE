import { USAGE_RANGE_DAYS, tokenSum, type TokenUsage, type UsageRange, type UsageStats } from '@oide/protocol';
import { localOffsetMs, type AgentSessionRow, type Store, type UsageDay } from '@oide/store';

/**
 * The Usage screen's numbers (`usage.stats`), from oIDE's own store: token samples (and their daily
 * rollup past the 90-day retention) and agent rows. Days are local calendar days.
 */

const DAY_MS = 86_400_000;

const zero = (): TokenUsage => ({ input: 0, output: 0, cacheRead: 0, cacheCreation: 0 });

function addTo(a: TokenUsage, b: TokenUsage): void {
  a.input += b.input;
  a.output += b.output;
  a.cacheRead += b.cacheRead;
  a.cacheCreation += b.cacheCreation;
}

/** `YYYY-MM-DD` of a local day number (days since 1970-01-01 in local time). */
export function dayDate(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

export interface UsageStatsInput {
  range: UsageRange;
  now: number;
  offsetMs: number;
  /** Token rows from the day before the previous period starts on (`UsageRepo.daily`). */
  usage: UsageDay[];
  /** Agents started in the range. */
  sessions: AgentSessionRow[];
  subagents: number;
  projects: Array<{ id: string; name: string }>;
}

/** The first local day of `range` ending today, and the epoch ms it starts at. */
export function rangeStart(range: UsageRange, now: number, offsetMs: number): { sinceDay: number; sinceTs: number; today: number } {
  const today = Math.floor((now + offsetMs) / DAY_MS);
  const sinceDay = today - USAGE_RANGE_DAYS[range] + 1;
  return { sinceDay, sinceTs: sinceDay * DAY_MS - offsetMs, today };
}

export function buildUsageStats(input: UsageStatsInput): UsageStats {
  const { range, now, offsetMs } = input;
  const { sinceDay } = rangeStart(range, now, offsetMs);
  const n = USAGE_RANGE_DAYS[range];
  const dayOf = (ts: number) => Math.floor((ts + offsetMs) / DAY_MS);

  const days = Array.from({ length: n }, (_, i) => ({ date: dayDate(sinceDay + i), tokens: zero(), sessions: 0 }));
  const totals = zero();
  let previousTotal = 0;
  const byProject = new Map<string, { sessions: number; tokens: number }>();
  const byModel = new Map<string, number>();
  const project = (id: string) => {
    let p = byProject.get(id);
    if (!p) byProject.set(id, (p = { sessions: 0, tokens: 0 }));
    return p;
  };

  for (const row of input.usage) {
    const t = tokenSum(row.usage);
    if (row.day < sinceDay) {
      if (row.day >= sinceDay - n) previousTotal += t;
      continue;
    }
    const d = days[row.day - sinceDay];
    if (!d) continue;
    addTo(d.tokens, row.usage);
    addTo(totals, row.usage);
    if (t === 0) continue;
    project(row.projectId ?? '').tokens += t;
    const model = row.model || 'Unknown';
    byModel.set(model, (byModel.get(model) ?? 0) + t);
  }

  const hours = new Array<number>(24).fill(0);
  const weekdays = new Array<number>(7).fill(0);
  const durations: number[] = [];
  const s = { total: 0, merged: 0, discarded: 0, completed: 0, errored: 0, inWorktree: 0, parallel: 0 };
  for (const a of input.sessions) {
    const d = days[dayOf(a.createdAt) - sinceDay];
    if (!d) continue;
    d.sessions++;
    s.total++;
    if (a.archiveReason === 'merged') s.merged++;
    else if (a.archiveReason === 'discarded') s.discarded++;
    else if (a.archiveReason === 'completed' || a.status === 'done') s.completed++;
    if (a.status === 'error') s.errored++;
    if (a.worktree) s.inWorktree++;
    if (a.attemptGroup) s.parallel++;
    if (a.endedAt !== undefined && a.endedAt >= a.createdAt) durations.push(a.endedAt - a.createdAt);
    project(a.projectId).sessions++;
    const at = new Date(a.createdAt);
    hours[at.getHours()]!++;
    weekdays[(at.getDay() + 6) % 7]!++;
  }

  const names = new Map(input.projects.map((p) => [p.id, p.name]));
  const projects: UsageStats['projects'] = [];
  const unknown = { name: 'Removed or unknown project', sessions: 0, tokens: 0 };
  for (const [id, v] of byProject) {
    const name = names.get(id);
    if (name !== undefined) projects.push({ projectId: id, name, ...v });
    else {
      // Every id oIDE no longer knows (and samples with no agent) folds into one row.
      unknown.sessions += v.sessions;
      unknown.tokens += v.tokens;
    }
  }
  if (unknown.sessions || unknown.tokens) projects.push(unknown);
  projects.sort((a, b) => b.tokens - a.tokens || b.sessions - a.sessions || a.name.localeCompare(b.name));

  const models = [...byModel.entries()].map(([model, tokens]) => ({ model, tokens })).sort((a, b) => b.tokens - a.tokens);

  const active = days.map((d) => d.sessions > 0 || tokenSum(d.tokens) > 0);
  let longestStreak = 0;
  let run = 0;
  for (const a of active) {
    run = a ? run + 1 : 0;
    longestStreak = Math.max(longestStreak, run);
  }
  let currentStreak = 0;
  // Today may simply not have started yet: count from yesterday then.
  let i = active.length - 1;
  if (!active[i]) i--;
  for (; i >= 0 && active[i]; i--) currentStreak++;

  let busiestDay: UsageStats['busiestDay'];
  for (const d of days) {
    const t = tokenSum(d.tokens);
    if (t > 0 && (!busiestDay || t > busiestDay.tokens)) busiestDay = { date: d.date, tokens: t };
  }

  durations.sort((a, b) => a - b);
  const medianMs = durations.length ? durations[Math.floor((durations.length - 1) / 2)]! : undefined;

  return {
    range,
    days,
    totals,
    previousTotal,
    sessions: { ...s, subagents: input.subagents, ...(medianMs !== undefined ? { medianMs } : {}) },
    projects,
    models,
    hours,
    weekdays,
    activeDays: active.filter(Boolean).length,
    longestStreak,
    currentStreak,
    ...(busiestDay ? { busiestDay } : {}),
  };
}

/** `usage.stats`: read the store and build the stats for `range`. */
export function usageStats(store: Store, range: UsageRange, now = Date.now()): UsageStats {
  const offsetMs = localOffsetMs(now);
  const { sinceDay, sinceTs } = rangeStart(range, now, offsetMs);
  return buildUsageStats({
    range,
    now,
    offsetMs,
    usage: store.usage.daily({ sinceDay: sinceDay - USAGE_RANGE_DAYS[range], offsetMs }),
    sessions: store.agents.sessionsSince(sinceTs),
    subagents: store.subagents.countSince(sinceTs),
    projects: store.projects.list().map((p) => ({ id: p.id, name: p.name })),
  });
}
