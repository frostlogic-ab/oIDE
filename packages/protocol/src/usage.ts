import { z } from 'zod';
import { Id, TokenUsage } from './agent.js';

/**
 * The Usage screen (status bar › Tokens today): how you work with oIDE over a range of days.
 * Everything is measured locally from oIDE's own store (token samples the CLI reports, agent rows);
 * nothing is asked of Anthropic. "Tokens" means input + output + cache read + cache creation, the
 * same sum the status bar shows.
 */
export const USAGE_RANGES = ['7d', '30d', '1y'] as const;
export const UsageRange = z.enum(USAGE_RANGES);
export type UsageRange = z.infer<typeof UsageRange>;
export const USAGE_RANGE_DAYS: Record<UsageRange, number> = { '7d': 7, '30d': 30, '1y': 365 };

const Count = z.number().int().nonnegative();

export const UsageStatsDay = z.object({
  /** Local calendar day, `YYYY-MM-DD`. */
  date: z.string(),
  tokens: TokenUsage,
  /** Agent sessions started that day. */
  sessions: Count,
});
export type UsageStatsDay = z.infer<typeof UsageStatsDay>;

export const UsageStats = z.object({
  range: UsageRange,
  /** One entry per day of the range, oldest first, today last. */
  days: z.array(UsageStatsDay),
  totals: TokenUsage,
  /** Total tokens of the same number of days just before the range (for the change). */
  previousTotal: Count,
  sessions: z.object({
    total: Count,
    merged: Count,
    discarded: Count,
    completed: Count,
    errored: Count,
    /** Started in their own git worktree. */
    inWorktree: Count,
    /** Part of a parallel-attempts group. */
    parallel: Count,
    subagents: Count,
    /** Median time from start to end, of the sessions that ended. */
    medianMs: z.number().nonnegative().optional(),
  }),
  /** Sessions and tokens per project, most tokens first. No `projectId`: a removed project or unknown. */
  projects: z.array(z.object({ projectId: Id.optional(), name: z.string(), sessions: Count, tokens: Count })),
  /** Tokens per model as the CLI named it, most first. */
  models: z.array(z.object({ model: z.string(), tokens: Count })),
  /** Sessions started per local hour of day (0-23). */
  hours: z.array(Count).length(24),
  /** Sessions started per weekday, Monday first. */
  weekdays: z.array(Count).length(7),
  /** Days with any tokens or sessions. */
  activeDays: Count,
  longestStreak: Count,
  /** Consecutive active days ending today (or yesterday, if today has nothing yet). */
  currentStreak: Count,
  busiestDay: z.object({ date: z.string(), tokens: Count }).optional(),
});
export type UsageStats = z.infer<typeof UsageStats>;

export function tokenSum(u: TokenUsage): number {
  return u.input + u.output + u.cacheRead + u.cacheCreation;
}
