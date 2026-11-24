import { useMemo } from 'react';
import { StatusDot, Tooltip } from '@oide/ui';
import { cliHealth, useCli } from '../../stores/cli';
import { countAgents, useAgents } from '../../stores/agents';
import { useProjects } from '../../stores/projects';
import { toast } from '../../stores/ui';
import { ipcErrorMessage } from '../../lib/bridge';
import { formatResetTime, formatTokens, plural } from '../../lib/format';

/**
 * 26px status bar. Plan percentage meters (Session / Week) are hidden: there is no supported
 * source for them (build brief, "Context ring and plan usage"). Shows what oIDE can measure:
 * tokens today and the reset time of the last rate-limit event.
 */
export function StatusBar() {
  const info = useCli((s) => s.info);
  const detected = useCli((s) => s.detected);
  const usage = useCli((s) => s.usage);
  const byId = useAgents((s) => s.byId);
  const projects = useProjects((s) => s.list);

  const derived = useMemo(() => {
    const list = Object.values(byId);
    return {
      sessions: list.length,
      worktrees: list.filter((a) => a.worktreePath || a.branch).length,
      subagentsActive: countAgents(list).subagentsActive,
      rateLimitResetAt: list.map((a) => a.rateLimitResetAt ?? 0).reduce((m, x) => Math.max(m, x), 0) || undefined,
    };
  }, [byId]);

  const sessions = usage?.sessions ?? derived.sessions;
  const worktrees = usage?.worktrees ?? derived.worktrees;
  const subagents = usage?.subagentsActive ?? derived.subagentsActive;
  const projectsOpen = usage?.projectsOpen ?? projects.length;
  const resetAt = usage?.rateLimitResetAt ?? derived.rateLimitResetAt;
  const limited = resetAt !== undefined && resetAt > Date.now();

  return (
    <footer className="h-status shrink-0 flex items-center gap-4 px-3.5 bg-chrome border-t border-line text-ink-3 text-[11.5px] whitespace-nowrap overflow-hidden">
      <CliStatus health={cliHealth(info, detected)} version={info?.version} />
      <span>
        {plural(sessions, 'session')} · {plural(worktrees, 'worktree')} · {subagents} {subagents === 1 ? 'subagent' : 'subagents'} active
      </span>
      <div className="flex-1" />
      <div role="group" aria-label="Usage" className="h-[22px] flex items-center gap-1">
        {usage && (
          <Tooltip content="Tokens used by oIDE agents today (input + output)" placement="top-end">
            <button type="button" className="h-[22px] flex items-center gap-1.5 px-2 border-0 rounded-[5px] bg-transparent text-ink-3 text-[11.5px] hover:bg-selected hover:text-ink focus-visible:bg-selected">
              Tokens today <span className="text-ink font-mono text-[11px]">{formatTokens(usage.tokensToday)}</span>
            </button>
          </Tooltip>
        )}
        {limited && (
          <Tooltip content={`Rate limit resets ${formatResetTime(resetAt)}. Agents wait, they do not retry in a loop.`} placement="top-end">
            <button type="button" className="h-[22px] flex items-center gap-1.5 px-2 border-0 rounded-[5px] bg-transparent text-warn text-[11.5px] hover:bg-selected focus-visible:bg-selected">
              <StatusDot color="var(--color-warn)" size={6} />
              Rate limited · resets {formatResetTime(resetAt)}
            </button>
          </Tooltip>
        )}
      </div>
      <span>{plural(projectsOpen, 'project')} open</span>
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
        className="flex items-center gap-1.5 border-0 bg-transparent p-0 text-warn text-[11.5px] hover:underline"
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
  return (
    <span className="flex items-center gap-1.5" title={version ? `claude ${version}` : undefined}>
      <StatusDot color={meta.color} size={6} />
      {meta.text}
    </span>
  );
}
