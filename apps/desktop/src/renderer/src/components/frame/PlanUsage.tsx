import type { AgentSummary } from '@oide/protocol';
import { Tooltip } from '@oide/ui';
import { formatResetTime } from '../../lib/format';

export type PlanUsage = NonNullable<AgentSummary['planUsage']>;

/** Newest plan usage reported by any agent (the CLI's `rate_limit_event`, once per turn). */
export function latestPlanUsage(agents: readonly AgentSummary[]): PlanUsage | undefined {
  let best: AgentSummary | undefined;
  for (const a of agents) if (a.planUsage && (!best || a.updatedAt > best.updatedAt)) best = a;
  return best?.planUsage;
}

/** "five_hour" → "Session", "seven_day" → "Week". */
export function windowLabel(window: string | undefined): { short: string; long: string } {
  if (!window) return { short: 'Plan', long: 'Plan limit' };
  if (/five_hour|session/i.test(window)) return { short: 'Session', long: 'Session limit' };
  if (/seven_day|week/i.test(window)) return { short: /opus/i.test(window) ? 'Week (Opus)' : 'Week', long: 'Weekly limit' };
  return { short: window.replace(/_/g, ' '), long: `${window.replace(/_/g, ' ')} limit` };
}

/**
 * Status-bar plan meter (Focus.dc.html footer `.lim`): a 64×5 bar only when the CLI reported a
 * utilization number, never a guessed percentage (build brief, "Context ring and plan usage").
 * Without one it shows only the reset time.
 */
export function PlanUsageMeter({ usage, now = Date.now() }: { usage: PlanUsage; now?: number }) {
  const label = windowLabel(usage.window);
  const reset = usage.resetsAt && usage.resetsAt > now ? `${label.long} resets ${formatResetTime(usage.resetsAt, now)}` : `${label.long} reported by the Claude Code CLI`;
  const btn = 'h-[22px] flex items-center gap-1.5 px-2 border-0 rounded-[5px] bg-transparent text-ink-3 text-[11.5px] hover:bg-selected hover:text-ink focus-visible:bg-selected';
  if (typeof usage.utilization !== 'number') {
    if (!usage.resetsAt || usage.resetsAt <= now) return null;
    return (
      <Tooltip content={reset} placement="top-end">
        <button type="button" className={btn}>
          {label.short} resets <span className="text-ink">{formatResetTime(usage.resetsAt, now)}</span>
        </button>
      </Tooltip>
    );
  }
  const pct = Math.round(Math.min(1, Math.max(0, usage.utilization)) * 100);
  return (
    <Tooltip content={reset} placement="top-end">
      <button type="button" className={btn} aria-label={`${label.short} plan usage ${pct}%`}>
        {label.short}
        <span aria-hidden="true" className="w-16 h-[5px] rounded-[3px] bg-line-2 inline-block overflow-hidden">
          <span className="block h-[5px]" style={{ width: `${pct}%`, background: usage.utilization >= 0.6 ? 'var(--color-warn)' : 'var(--color-accent)' }} />
        </span>
        <span aria-hidden="true" className="text-ink">
          {pct}%
        </span>
      </button>
    </Tooltip>
  );
}
