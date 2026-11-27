import { describe, expect, it } from 'vitest';
import { tokenSum, type UsageRange, type UsageStats } from '@oide/protocol';
import { mockUsageStats } from '../../lib/mock/usage';
import { WEEKDAYS, change, changeText, dayBars, facts, niceMax, parseDay, percent } from './model';

const NOW = new Date(2026, 10, 27, 12).getTime();

/** Deterministic stats with every field present; `over` replaces fields. */
function stats(range: UsageRange = '7d', over: Partial<UsageStats> = {}): UsageStats {
  return { ...mockUsageStats(range, NOW), ...over };
}

/** Stats with nothing in them. */
function emptyStats(range: UsageRange = '7d'): UsageStats {
  const base = mockUsageStats(range, NOW);
  const zero = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
  return {
    ...base,
    days: base.days.map((d) => ({ ...d, tokens: zero, sessions: 0 })),
    totals: zero,
    previousTotal: 0,
    sessions: { total: 0, merged: 0, discarded: 0, completed: 0, errored: 0, inWorktree: 0, parallel: 0, subagents: 0 },
    projects: [],
    models: [],
    hours: Array<number>(24).fill(0),
    weekdays: Array<number>(7).fill(0),
    activeDays: 0,
    longestStreak: 0,
    currentStreak: 0,
    busiestDay: undefined,
  };
}

const ids = (s: UsageStats) => facts(s).map((f) => f.id);

describe('parseDay', () => {
  it('reads YYYY-MM-DD as a local calendar day', () => {
    const d = parseDay('2026-03-05');
    expect([d.getFullYear(), d.getMonth(), d.getDate()]).toEqual([2026, 2, 5]);
    expect([d.getHours(), d.getMinutes()]).toEqual([0, 0]);
  });
});

describe('dayBars', () => {
  it('7d: one bar per day, each with an x-axis tick', () => {
    const s = stats('7d');
    const bars = dayBars('7d', s.days, (d) => d.sessions);
    expect(bars).toHaveLength(7);
    expect(bars.every((b) => typeof b.tick === 'string' && b.tick.length > 0)).toBe(true);
    expect(bars.map((b) => b.key)).toEqual(s.days.map((d) => d.date));
    expect(bars.map((b) => b.value)).toEqual(s.days.map((d) => d.sessions));
  });

  it('30d: one bar per day, with sparse ticks that include the last day', () => {
    const s = stats('30d');
    const bars = dayBars('30d', s.days, (d) => tokenSum(d.tokens));
    expect(bars).toHaveLength(30);
    expect(bars.map((b) => b.value)).toEqual(s.days.map((d) => tokenSum(d.tokens)));
    const ticked = bars.filter((b) => b.tick);
    expect(ticked.length).toBeGreaterThan(0);
    expect(ticked.length).toBeLessThan(30);
    expect(bars[29]!.tick).toBeTruthy();
  });

  it('1y: groups the days into 52 weekly buckets (the odd day in the first) that sum to the daily total', () => {
    const s = stats('1y');
    expect(s.days).toHaveLength(365);
    const pick = (d: (typeof s.days)[number]) => tokenSum(d.tokens);
    const bars = dayBars('1y', s.days, pick);
    expect(bars).toHaveLength(52);
    expect(bars[0]!.key).toBe(s.days[0]!.date);
    expect(bars.reduce((n, b) => n + b.value, 0)).toBe(s.days.reduce((n, d) => n + pick(d), 0));
    expect(bars.every((b) => b.label.startsWith('Week of '))).toBe(true);
  });

  it('1y: the last bucket ends on the last day and weeks run oldest first', () => {
    const s = stats('1y');
    const bars = dayBars('1y', s.days, (d) => d.sessions);
    // The last bucket is the 7 days ending on the last day: keyed by the first of them.
    expect(bars[bars.length - 1]!.key).toBe(s.days[s.days.length - 7]!.date);
    expect(bars[bars.length - 1]!.value).toBe(s.days.slice(-7).reduce((n, d) => n + d.sessions, 0));
    // The odd day out (365 = 52 weeks + 1) joins the oldest week: 8 days, keyed by the first.
    expect(bars[0]!.key).toBe(s.days[0]!.date);
    expect(bars[0]!.value).toBe(s.days.slice(0, 8).reduce((n, d) => n + d.sessions, 0));
    const keys = bars.map((b) => b.key);
    expect([...keys].sort()).toEqual(keys);
  });

  it('1y: ticks at most the first week of every other month', () => {
    const bars = dayBars('1y', stats('1y').days, (d) => d.sessions);
    const ticked = bars.filter((b) => b.tick);
    expect(ticked.length).toBeGreaterThan(0);
    expect(ticked.length).toBeLessThanOrEqual(7);
  });

  it('1y: handles fewer than a full year and no days', () => {
    const s = stats('7d');
    expect(dayBars('1y', s.days, (d) => d.sessions)).toHaveLength(1);
    expect(dayBars('1y', [], (d) => d.sessions)).toEqual([]);
  });
});

describe('niceMax', () => {
  it.each([
    [0, 1],
    [-3, 1],
    [1, 1],
    [7, 10],
    [12, 20],
    [450, 500],
    [500, 500],
    [501, 1000],
    [2_300_000, 5_000_000],
  ])('niceMax(%s) is %s', (input, expected) => {
    expect(niceMax(input)).toBe(expected);
  });
});

describe('change', () => {
  it('is undefined without a previous period', () => {
    expect(change(100, 0)).toBeUndefined();
    expect(change(0, 0)).toBeUndefined();
  });
  it('formats growth with a plus', () => expect(change(124, 100)).toBe('+24%'));
  it('formats a drop with a real minus sign', () => expect(change(92, 100)).toBe('−8%'));
  it('formats no change as ±0%', () => {
    expect(change(100, 100)).toBe('±0%');
    expect(change(100.2, 100)).toBe('±0%');
  });
});

describe('changeText', () => {
  it('names the comparison period', () => {
    const base = stats('7d');
    const total = tokenSum(base.totals);
    expect(changeText({ ...base, previousTotal: Math.round(total / 1.24) })).toMatch(/^\+\d+% vs the 7 days before$/);
    expect(changeText({ ...stats('30d'), previousTotal: 10 ** 12 })).toMatch(/^−\d+% vs the 30 days before$/);
    expect(changeText({ ...stats('1y'), previousTotal: 1 })).toMatch(/ vs the year before$/);
  });
  it('is undefined without a previous period', () => {
    expect(changeText({ ...stats('7d'), previousTotal: 0 })).toBeUndefined();
  });
});

describe('percent', () => {
  it('rounds to whole percents', () => {
    expect(percent(1, 2)).toBe('50%');
    expect(percent(2, 3)).toBe('67%');
    expect(percent(5, 5)).toBe('100%');
  });
  it('shows <1% for a share that would round to nothing', () => {
    expect(percent(1, 1000)).toBe('<1%');
    expect(percent(4, 1000)).toBe('<1%');
  });
  it('shows 0% for no share or no whole', () => {
    expect(percent(0, 100)).toBe('0%');
    expect(percent(5, 0)).toBe('0%');
  });
});

describe('facts', () => {
  it('omits every fact when there is no data', () => {
    expect(facts(emptyStats())).toEqual([]);
  });

  it('includes peak hour, peak weekday and cache share when present', () => {
    const hours = Array<number>(24).fill(0);
    hours[15] = 7;
    hours[9] = 3;
    const weekdays = [0, 0, 4, 1, 0, 0, 0];
    const base = emptyStats();
    const s: UsageStats = { ...base, hours, weekdays, totals: { input: 100, output: 100, cacheRead: 700, cacheCreation: 100 } };
    const list = facts(s);
    const byId = Object.fromEntries(list.map((f) => [f.id, f]));
    expect(byId['peak-hour']?.detail).toBe('7 sessions');
    expect(byId['peak-weekday']?.value).toBe(WEEKDAYS[2]);
    expect(byId['peak-weekday']?.detail).toBe('4 sessions');
    expect(byId.cache?.value).toBe('70%');
    expect(ids(s)).toEqual(['peak-hour', 'peak-weekday', 'cache']);
  });

  it('uses the singular for a single session', () => {
    const hours = Array<number>(24).fill(0);
    hours[8] = 1;
    expect(facts({ ...emptyStats(), hours }).find((f) => f.id === 'peak-hour')?.detail).toBe('1 session');
  });

  it('shows a streak only above one day, with the running streak as detail', () => {
    expect(ids({ ...emptyStats(), longestStreak: 1 })).not.toContain('streak');
    const f = facts({ ...emptyStats(), longestStreak: 5, currentStreak: 2 }).find((x) => x.id === 'streak');
    expect(f?.value).toBe('5 days');
    expect(f?.detail).toBe('2 days running now');
    expect(facts({ ...emptyStats(), longestStreak: 5, currentStreak: 0 }).find((x) => x.id === 'streak')?.detail).toBeUndefined();
  });

  it('shows the merged fact only when something was merged or discarded', () => {
    const none = emptyStats();
    expect(ids(none)).not.toContain('merged');
    const s = { ...none, sessions: { ...none.sessions, merged: 3, discarded: 2 } };
    const f = facts(s).find((x) => x.id === 'merged');
    expect(f?.value).toBe('3 sessions');
    expect(f?.detail).toBe('2 discarded');
  });

  it('computes per-session figures only with sessions and tokens', () => {
    const none = emptyStats();
    expect(ids({ ...none, totals: { input: 10, output: 0, cacheRead: 0, cacheCreation: 0 } })).not.toContain('per-session');
    const s = { ...none, sessions: { ...none.sessions, total: 2, subagents: 3 }, totals: { input: 1000, output: 0, cacheRead: 0, cacheCreation: 0 } };
    const list = facts(s);
    expect(list.find((x) => x.id === 'per-session')?.value).toBe('500');
    expect(list.find((x) => x.id === 'subagents')?.detail).toBe('1.5 per session');
  });

  it('is rich for a full payload', () => {
    expect(ids(stats('30d'))).toEqual(expect.arrayContaining(['peak-hour', 'peak-weekday', 'busiest-day', 'streak', 'per-session', 'median', 'cache', 'worktree', 'merged', 'parallel', 'subagents']));
  });
});
