import { tokenSum, type UsageRange, type UsageStats, type UsageStatsDay } from '@oide/protocol';
import { formatDuration, formatTokens, plural } from '../../lib/format';

/** One bar of a chart: `label` names it in the tooltip and table, `tick` on the x axis (sparse). */
export interface Bar {
  key: string;
  label: string;
  tick?: string;
  value: number;
}

/** Local date of a `YYYY-MM-DD` day (not UTC midnight, which is the day before west of Greenwich). */
export function parseDay(date: string): Date {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y!, (m ?? 1) - 1, d ?? 1);
}

const fmt = (date: string, opts: Intl.DateTimeFormatOptions) => parseDay(date).toLocaleDateString(undefined, opts);

/** "Tue 3 Mar". */
export function dayLabel(date: string): string {
  return fmt(date, { weekday: 'short', day: 'numeric', month: 'short' });
}

/**
 * The bars of a per-day chart. A year is shown per week (52 bars, the last one ending today, the first taking the odd day); 7 and
 * 30 days per day. `pick` reads the value of a day.
 */
export function dayBars(range: UsageRange, days: UsageStatsDay[], pick: (d: UsageStatsDay) => number): Bar[] {
  if (range !== '1y') {
    return days.map((d, i) => ({
      key: d.date,
      label: dayLabel(d.date),
      ...(range === '7d' ? { tick: fmt(d.date, { weekday: 'short' }) } : i % 5 === (days.length - 1) % 5 ? { tick: fmt(d.date, { day: 'numeric', month: 'short' }) } : {}),
      value: pick(d),
    }));
  }
  const weeks: UsageStatsDay[][] = [];
  for (let end = days.length; end > 0; end -= 7) weeks.unshift(days.slice(Math.max(0, end - 7), end));
  // 365 days are 52 weeks and a day: the odd day joins the first week rather than drawing a stub bar.
  if (weeks.length > 1 && weeks[0]!.length < 7) weeks.splice(0, 2, [...weeks[0]!, ...weeks[1]!]);
  let lastMonth = -1;
  return weeks.map((w) => {
    const first = w[0]!;
    const month = parseDay(first.date).getMonth();
    // Tick the first week of every other month.
    const tick = month !== lastMonth && month % 2 === 0 ? fmt(first.date, { month: 'short' }) : undefined;
    lastMonth = month;
    return {
      key: first.date,
      label: `Week of ${fmt(first.date, { day: 'numeric', month: 'short' })}`,
      ...(tick ? { tick } : {}),
      value: w.reduce((n, d) => n + pick(d), 0),
    };
  });
}

/** The smallest 1, 2 or 5 × 10^k at or above `max` (axis top); 1 for an empty chart. */
export function niceMax(max: number): number {
  if (max <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(max));
  for (const m of [1, 2, 5, 10]) if (m * p >= max) return m * p;
  return 10 * p;
}

/** "+24%", "−8%", or undefined when there is nothing to compare with. */
export function change(now: number, before: number): string | undefined {
  if (before <= 0) return undefined;
  const pct = Math.round(((now - before) / before) * 100);
  if (pct === 0) return '±0%';
  return pct > 0 ? `+${pct}%` : `−${Math.abs(pct)}%`;
}

export const RANGE_LABEL: Record<UsageRange, string> = { '7d': 'Last 7 days', '30d': 'Last 30 days', '1y': 'Last year' };
const PERIOD: Record<UsageRange, string> = { '7d': 'the 7 days before', '30d': 'the 30 days before', '1y': 'the year before' };

export function percent(part: number, whole: number): string {
  if (whole <= 0) return '0%';
  const p = (part / whole) * 100;
  return p > 0 && p < 1 ? '<1%' : `${Math.round(p)}%`;
}

const HOUR = (h: number) => new Date(2000, 0, 1, h).toLocaleTimeString(undefined, { hour: 'numeric' });
export const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

export function hourBars(hours: number[]): Bar[] {
  return hours.map((value, h) => ({ key: String(h), label: `${HOUR(h)} – ${HOUR((h + 1) % 24)}`, ...(h % 6 === 0 ? { tick: HOUR(h) } : {}), value }));
}

export function weekdayBars(weekdays: number[]): Bar[] {
  return weekdays.map((value, i) => ({ key: WEEKDAYS[i]!, label: WEEKDAYS[i]!, tick: WEEKDAYS[i]!.slice(0, 3), value }));
}

/** Index of the largest value, or -1 when all are 0. */
function peak(values: number[]): number {
  let best = -1;
  values.forEach((v, i) => {
    if (v > 0 && (best < 0 || v > values[best]!)) best = i;
  });
  return best;
}

export interface Fact {
  id: string;
  label: string;
  value: string;
  detail?: string;
}

/** The "How you work" list: only facts the range has data for. */
export function facts(s: UsageStats): Fact[] {
  const out: Fact[] = [];
  const total = tokenSum(s.totals);
  const n = s.sessions.total;
  const h = peak(s.hours);
  if (h >= 0) out.push({ id: 'peak-hour', label: 'Most sessions start', value: `${HOUR(h)} – ${HOUR((h + 1) % 24)}`, detail: plural(s.hours[h]!, 'session') });
  const w = peak(s.weekdays);
  if (w >= 0) out.push({ id: 'peak-weekday', label: 'Busiest weekday', value: WEEKDAYS[w]!, detail: plural(s.weekdays[w]!, 'session') });
  if (s.busiestDay) out.push({ id: 'busiest-day', label: 'Busiest day', value: dayLabel(s.busiestDay.date), detail: `${formatTokens(s.busiestDay.tokens)} tokens` });
  if (s.longestStreak > 1) out.push({ id: 'streak', label: 'Longest streak', value: plural(s.longestStreak, 'day'), detail: s.currentStreak > 0 ? `${plural(s.currentStreak, 'day')} running now` : undefined });
  if (n > 0 && total > 0) out.push({ id: 'per-session', label: 'Tokens per session', value: formatTokens(Math.round(total / n)), detail: 'on average' });
  if (s.sessions.medianMs !== undefined) out.push({ id: 'median', label: 'Typical session', value: formatDuration(s.sessions.medianMs), detail: 'median, start to end' });
  if (total > 0) out.push({ id: 'cache', label: 'Served from cache', value: percent(s.totals.cacheRead, total), detail: 'of all tokens were cache reads' });
  if (n > 0 && s.sessions.inWorktree > 0) out.push({ id: 'worktree', label: 'In their own worktree', value: percent(s.sessions.inWorktree, n), detail: 'of sessions' });
  if (s.sessions.merged + s.sessions.discarded > 0)
    out.push({
      id: 'merged',
      label: 'Merged',
      value: plural(s.sessions.merged, 'session'),
      detail: s.sessions.discarded ? `${s.sessions.discarded} discarded` : undefined,
    });
  if (s.sessions.parallel > 0) out.push({ id: 'parallel', label: 'Parallel attempts', value: plural(s.sessions.parallel, 'session'), detail: 'ran as one of several attempts' });
  if (s.sessions.subagents > 0) out.push({ id: 'subagents', label: 'Subagents', value: String(s.sessions.subagents), detail: n > 0 ? `${(s.sessions.subagents / n).toFixed(1)} per session` : undefined });
  return out;
}

/** "+24% vs the 7 days before". */
export function changeText(s: UsageStats): string | undefined {
  const c = change(tokenSum(s.totals), s.previousTotal);
  return c ? `${c} vs ${PERIOD[s.range]}` : undefined;
}
