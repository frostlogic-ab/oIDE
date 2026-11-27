import { USAGE_RANGE_DAYS, type UsageRange, type UsageStats } from '@oide/protocol';
import { projects } from './fixtures';

/** Plausible, deterministic `usage.stats` for the browser mock (`pnpm dev:web`). */
export function mockUsageStats(range: UsageRange, now = Date.now()): UsageStats {
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const n = USAGE_RANGE_DAYS[range];
  const today = new Date(now);
  const days = Array.from({ length: n }, (_, i) => {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (n - 1 - i));
    const weekend = d.getDay() === 0 || d.getDay() === 6;
    const busy = weekend ? rand() * 0.3 : 0.4 + rand();
    const sessions = Math.round(busy * 9);
    const input = Math.round(busy * 2_400_000);
    const output = Math.round(busy * 900_000);
    return {
      date: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
      tokens: { input, output, cacheRead: input * 28, cacheCreation: Math.round(input * 1.6) },
      sessions,
    };
  });
  const totals = days.reduce(
    (t, d) => ({ input: t.input + d.tokens.input, output: t.output + d.tokens.output, cacheRead: t.cacheRead + d.tokens.cacheRead, cacheCreation: t.cacheCreation + d.tokens.cacheCreation }),
    { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
  );
  const sum = totals.input + totals.output + totals.cacheRead + totals.cacheCreation;
  const sessions = days.reduce((x, d) => x + d.sessions, 0);
  const shares = [0.52, 0.31, 0.17];
  const hours = [0, 0, 0, 0, 0, 0, 0, 1, 4, 9, 12, 10, 5, 7, 11, 13, 9, 6, 3, 2, 3, 2, 1, 0].map((h) => Math.round((h * sessions) / 98));
  const weekdays = [0.21, 0.22, 0.2, 0.18, 0.14, 0.03, 0.02].map((w) => Math.round(w * sessions));
  return {
    range,
    days,
    totals,
    previousTotal: Math.round(sum * 0.83),
    sessions: {
      total: sessions,
      merged: Math.round(sessions * 0.55),
      discarded: Math.round(sessions * 0.12),
      completed: Math.round(sessions * 0.1),
      errored: Math.round(sessions * 0.04),
      inWorktree: Math.round(sessions * 0.9),
      parallel: Math.round(sessions * 0.15),
      subagents: Math.round(sessions * 2.3),
      medianMs: 38 * 60_000,
    },
    projects: projects.slice(0, 3).map((p, i) => ({ projectId: p.id, name: p.name, sessions: Math.round(sessions * shares[i]!), tokens: Math.round(sum * shares[i]!) })),
    models: [
      { model: 'claude-opus-5-5', tokens: Math.round(sum * 0.71) },
      { model: 'claude-sonnet-5-5', tokens: Math.round(sum * 0.24) },
      { model: 'claude-haiku-5-5', tokens: Math.round(sum * 0.05) },
    ],
    hours,
    weekdays,
    activeDays: days.filter((d) => d.sessions > 0).length,
    longestStreak: Math.min(n, 12),
    currentStreak: Math.min(n, 4),
    busiestDay: days.reduce((b, d) => {
      const t = d.tokens.input + d.tokens.output + d.tokens.cacheRead + d.tokens.cacheCreation;
      return t > b.tokens ? { date: d.date, tokens: t } : b;
    }, { date: days[0]!.date, tokens: 0 }),
  };
}
