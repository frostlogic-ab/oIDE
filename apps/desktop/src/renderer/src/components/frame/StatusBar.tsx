import { useMemo } from 'react';
import { StatusDot, Tooltip } from '@oide/ui';
import { cliHealth, useCli } from '../../stores/cli';
import { countAgents, useAgents } from '../../stores/agents';
import { useProjects } from '../../stores/projects';
import { toast } from '../../stores/ui';
import { navigate } from '../../stores/router';
import { ipcErrorMessage } from '../../lib/bridge';
import { formatResetTime, formatTokens, plural } from '../../lib/format';
import { PlanUsageMeter, latestPlanUsage } from './PlanUsage';
import { AccountsUsage } from './AccountsUsage';
import { useAccounts } from '../../stores/accounts';
import { useSettings } from '../../stores/settings';

/**
 * 26px status bar. The plan meter (Session / Week) shows only when an agent's `planUsage` (the
 * CLI's `rate_limit_event`) carries a utilization; otherwise only its reset time (PlanUsage.tsx).
 * Also shows what oIDE measures: tokens today (opens the Usage screen) and the reset time of the last
 * rate-limit event. With two or more Claude Code accounts (ADR 0021), the plan meter and the
 * rate-limit notice are per account instead (AccountsUsage.tsx).
 */
export function StatusBar() {
  const info = useCli((s) => s.info);
  const detected = useCli((s) => s.detected);
  const usage = useCli((s) => s.usage);
  const byId = useAgents((s) => s.byId);
  const projects = useProjects((s) => s.list);
  const extraAccounts = useSettings((s) => s.settings?.accounts.list.length ?? 0);
  const accountUsage = useAccounts((s) => s.usage);
  // One account: exactly the single meter as before. More: per account, once main sent the usage.
  const perAccount = extraAccounts > 0 && accountUsage.length > 1;

  const derived = useMemo(() => {
    const list = Object.values(byId);
    return {
      sessions: list.length,
      worktrees: list.filter((a) => a.worktreePath || a.branch).length,
      subagentsActive: countAgents(list).subagentsActive,
      rateLimitResetAt: list.map((a) => a.rateLimitResetAt ?? 0).reduce((m, x) => Math.max(m, x), 0) || undefined,
      planUsage: latestPlanUsage(list),
    };
  }, [byId]);

  // Counts come from the live stores (the same `countAgents` the header uses), so the status bar
  // never disagrees with the header. `usage` supplies only what the renderer cannot count:
  // tokens today and the last rate-limit reset time.
  const { sessions, worktrees, subagentsActive: subagents } = derived;
  const projectsOpen = projects.length;
  const resetAt = usage?.rateLimitResetAt ?? derived.rateLimitResetAt;
  const limited = resetAt !== undefined && resetAt > Date.now();

  return (
    <footer className="h-status shrink-0 flex items-center gap-4 px-3.5 bg-chrome border-t border-line text-ink-3 text-[11.5px] whitespace-nowrap overflow-hidden">
      <CliStatus health={cliHealth(info, detected)} version={info?.version} />
      {/* The left text gives way first when the bar is narrow (1100px with a rate limit). */}
      <span className="min-w-0 truncate" data-testid="status-counts">
        {plural(sessions, 'session')} · {plural(worktrees, 'worktree')} · {subagents} {subagents === 1 ? 'subagent' : 'subagents'} active
      </span>
      <div className="flex-1" />
      <div role="group" aria-label="Usage" className="h-[22px] flex items-center gap-1 shrink-0">
        {/* Plan meter only from the CLI's own rate_limit_event utilization (never a guessed %). */}
        {perAccount ? <AccountsUsage accounts={accountUsage} /> : derived.planUsage && <PlanUsageMeter usage={derived.planUsage} />}
        {usage && (
          <Tooltip content="Tokens used by oIDE agents today (cache included). Open Usage for charts and stats." placement="top-end">
            <button type="button" onClick={() => navigate('usage', {})} className="h-[22px] flex items-center gap-1.5 px-2 border-0 rounded-[5px] bg-transparent text-ink-3 text-[11.5px] hover:bg-selected hover:text-ink focus-visible:bg-selected">
              Tokens today <span className="text-ink font-mono text-[11px]">{formatTokens(usage.tokensToday)}</span>
            </button>
          </Tooltip>
        )}
        {limited && !perAccount && (
          <Tooltip content={`Rate limit resets ${formatResetTime(resetAt)}. Agents wait, they do not retry in a loop.`} placement="top-end">
            <button type="button" className="h-[22px] flex items-center gap-1.5 px-2 border-0 rounded-[5px] bg-transparent text-warn text-[11.5px] hover:bg-selected focus-visible:bg-selected">
              <StatusDot color="var(--color-warn)" size={6} />
              Rate limited · resets {formatResetTime(resetAt)}
            </button>
          </Tooltip>
        )}
      </div>
      <span className="shrink-0">{plural(projectsOpen, 'project')} open</span>
    </footer>
  );
}

function CliStatus({ health, version }: { health: ReturnType<typeof cliHealth>; version?: string }) {
  const openSignIn = useCli((s) => s.openSignIn);
  if (health === 'sign-in') {
    return (
      <button
        type="button"
        onClick={() => openSignIn().catch((err: unknown) => toast(ipcErrorMessage(err), 'error'))}
        className="flex items-center gap-1.5 shrink-0 border-0 bg-transparent p-0 text-warn text-[11.5px] hover:underline"
      >
        <StatusDot color="var(--color-warn)" size={6} />
        Sign in to Claude Code CLI
      </button>
    );
  }
  const meta = {
    connected: { color: 'var(--color-ok)', text: 'Claude Code CLI connected' },
    untested: { color: 'var(--color-warn)', text: `Claude Code CLI ${version ?? ''} (untested version)` },
    missing: { color: 'var(--color-bad)', text: 'Claude Code CLI not found' },
    checking: { color: 'var(--color-ink-4)', text: 'Checking Claude Code CLI…' },
    unknown: { color: 'var(--color-ink-4)', text: 'Claude Code CLI status unknown' },
  }[health];
  if (health === 'missing' || health === 'untested') {
    return (
      <button
        type="button"
        onClick={() => navigate('settings', { section: 'cli' })}
        title="Set the Claude Code CLI path in Settings"
        className="flex items-center gap-1.5 shrink-0 border-0 bg-transparent p-0 text-ink-3 text-[11.5px] hover:underline"
      >
        <StatusDot color={meta.color} size={6} />
        {meta.text}
      </button>
    );
  }
  return (
    <span className="flex items-center gap-1.5 shrink-0" title={version ? `claude ${version}` : undefined}>
      <StatusDot color={meta.color} size={6} />
      {meta.text}
    </span>
  );
}
