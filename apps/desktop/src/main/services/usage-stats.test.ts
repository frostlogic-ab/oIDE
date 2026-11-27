import { describe, expect, it } from 'vitest';
import { openStore } from '@oide/store';
import { buildUsageStats, dayDate, rangeStart, usageStats } from './usage-stats';

const DAY = 86_400_000;
const spec = (projectId: string) => ({ projectId, title: 'Fix it', goal: 'Make it green', strategy: { kind: 'single' as const, lead: { model: 'opus' } } });

/** Local noon `daysAgo` days before `now`'s local day. */
function noon(now: number, daysAgo: number, hour = 12): number {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - daysAgo, hour).getTime();
}

describe('usage stats', () => {
  const now = new Date(2026, 10, 27, 15).getTime(); // Fri 27 Nov 2026, 3 PM local

  it('fills every day of the range, today last, and splits off the previous period', () => {
    const s = openStore(':memory:');
    const p = s.projects.open('/code/a', { name: 'alpha' });
    const q = s.projects.open('/code/b', { name: 'beta' });
    s.agents.insert({ id: 'a1', projectId: p.id, spec: spec(p.id), status: 'done', createdAt: noon(now, 0, 9), worktreePath: '/wt/1' });
    s.agents.update('a1', { endedAt: noon(now, 0, 9) + 30 * 60_000, archivedAt: noon(now, 0, 10), archiveReason: 'merged' });
    s.agents.insert({ id: 'a2', projectId: q.id, spec: spec(q.id), status: 'error', createdAt: noon(now, 2, 9), attemptGroup: 'g' });
    s.agents.insert({ id: 'old', projectId: q.id, spec: spec(q.id), status: 'done', createdAt: noon(now, 9) });
    s.usage.add({ agentId: 'a1', ts: noon(now, 0), model: 'opus', usage: { input: 100, output: 10, cacheRead: 890 } });
    s.usage.add({ agentId: 'a2', ts: noon(now, 2), model: 'haiku', usage: { input: 40 } });
    s.usage.add({ agentId: 'old', ts: noon(now, 9), model: 'opus', usage: { input: 500 } }); // previous 7 days
    s.usage.add({ agentId: 'old', ts: noon(now, 20), model: 'opus', usage: { input: 9999 } }); // outside both
    s.subagents.upsert({ id: 't1', agentId: 'a1', name: 'r', task: 'x', status: 'done', startedAt: noon(now, 0, 9) + 1 });

    const st = usageStats(s, '7d', now);
    expect(st.days).toHaveLength(7);
    expect(st.days[6]!.date).toBe('2026-11-27');
    expect(st.days[0]!.date).toBe('2026-11-21');
    expect(st.days[6]).toMatchObject({ sessions: 1, tokens: { input: 100, output: 10, cacheRead: 890 } });
    expect(st.days[4]).toMatchObject({ sessions: 1, tokens: { input: 40 } });
    expect(st.totals).toEqual({ input: 140, output: 10, cacheRead: 890, cacheCreation: 0 });
    expect(st.previousTotal).toBe(500);
    expect(st.sessions).toMatchObject({ total: 2, merged: 1, errored: 1, inWorktree: 1, parallel: 1, subagents: 1, medianMs: 30 * 60_000 });
    expect(st.projects).toEqual([
      { projectId: p.id, name: 'alpha', sessions: 1, tokens: 1000 },
      { projectId: q.id, name: 'beta', sessions: 1, tokens: 40 },
    ]);
    expect(st.models).toEqual([
      { model: 'opus', tokens: 1000 },
      { model: 'haiku', tokens: 40 },
    ]);
    expect(st.hours[9]).toBe(2);
    expect(st.weekdays[4]).toBe(1); // Friday
    expect(st.weekdays[2]).toBe(1); // Wednesday
    expect(st).toMatchObject({ activeDays: 2, longestStreak: 1, currentStreak: 1, busiestDay: { date: '2026-11-27', tokens: 1000 } });
  });

  it('a year reaches back past the sample retention through the daily rollup', () => {
    const s = openStore(':memory:');
    const p = s.projects.open('/code/a', { name: 'alpha' });
    s.agents.insert({ id: 'a1', projectId: p.id, spec: spec(p.id), status: 'done', createdAt: noon(now, 200) });
    s.usage.add({ agentId: 'a1', ts: noon(now, 200), model: 'opus', usage: { input: 70 } });
    s.usage.compactOlderThan(now - 90 * DAY);
    expect(s.usage.totals().total).toBe(0);
    const st = usageStats(s, '1y', now);
    expect(st.days).toHaveLength(365);
    expect(st.totals.input).toBe(70);
    expect(st.days.find((d) => d.tokens.input === 70)?.sessions).toBe(1);
    expect(usageStats(s, '30d', now).totals.input).toBe(0);
  });

  it('folds removed projects into one row and counts streaks', () => {
    const offsetMs = 0;
    const { sinceDay } = rangeStart('7d', 10 * DAY + 1, offsetMs);
    const usage = (day: number, projectId?: string) => ({ day, ...(projectId ? { projectId } : {}), usage: { input: 1, output: 0, cacheRead: 0, cacheCreation: 0 } });
    const st = buildUsageStats({
      range: '7d',
      now: 10 * DAY + 1,
      offsetMs,
      usage: [usage(sinceDay, 'gone'), usage(sinceDay + 1), usage(sinceDay + 2, 'p'), usage(sinceDay + 4, 'p'), usage(sinceDay + 5, 'p')],
      sessions: [],
      subagents: 0,
      projects: [{ id: 'p', name: 'kept' }],
    });
    expect(st.projects).toEqual([
      { projectId: 'p', name: 'kept', sessions: 0, tokens: 3 },
      { name: 'Removed or unknown project', sessions: 0, tokens: 2 },
    ]);
    expect(st.days.map((d) => d.date)).toEqual(Array.from({ length: 7 }, (_, i) => dayDate(sinceDay + i)));
    // active: days 0,1,2,4,5 of 7; today (6) empty → current streak counts from yesterday.
    expect(st).toMatchObject({ activeDays: 5, longestStreak: 3, currentStreak: 2 });
    expect(st.models).toEqual([{ model: 'Unknown', tokens: 5 }]);
  });
});
