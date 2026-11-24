import type { AgentSummary, SubagentInfo } from '@oide/protocol';
import { Button, ContextRing, ContextRingButton, Icon, Tooltip, contextFraction, contextPercent, modelFamily, subagentStatusMeta } from '@oide/ui';
import { formatTokens } from '../../../lib/format';
import { MODE_LABEL, isSubagentActive, modelEffort, routeLabel, runningText, subagentStatusText, tokenCount } from '../model/focus';

const SEP = (
  <span aria-hidden="true" className="text-ink-3">
    ·
  </span>
);

export interface LeadHeaderProps {
  agent: AgentSummary;
  project: string;
  now: number;
  warnAt?: number;
  dangerAt?: number;
  modeShortcut: string;
  onCycleMode(): void;
  onCompact(): void;
  onRawTerminal(): void;
  onPause(): void;
  onResume(): void;
  onStop(): void;
}

const RESUMABLE = new Set(['paused', 'stopped', 'error', 'rate-limited']);
const STOPPABLE = new Set(['running', 'starting', 'needs-permission', 'queued']);

export function LeadHeader({ agent, project, now, warnAt, dangerAt, modeShortcut, onCycleMode, onCompact, onRawTerminal, onPause, onResume, onStop }: LeadHeaderProps) {
  const worktree = agent.branch ? agent.branch.split('/').pop() : undefined;
  const resumable = RESUMABLE.has(agent.status);
  return (
    <div className="flex items-center gap-3 px-5 py-3 border-b border-line flex-wrap">
      <div className="flex flex-col gap-[3px] flex-1 min-w-[240px]">
        <h1 className="m-0 text-[17px] font-semibold tracking-[-0.01em]">{agent.title}</h1>
        <span className="flex items-center gap-2 text-[12px] text-ink-3 flex-wrap">
          <span>{project}</span>
          {worktree && (
            <>
              {SEP}
              <span className="font-mono">worktree {worktree}</span>
            </>
          )}
          {SEP}
          <Tooltip content={`Switch mode (${modeShortcut})`} placement="bottom-start">
            <button
              type="button"
              onClick={onCycleMode}
              aria-label={`${MODE_LABEL[agent.mode]}. Switch permission mode`}
              className="border-0 bg-transparent p-0 text-ink-3 text-[12px] hover:text-ink hover:underline"
            >
              {MODE_LABEL[agent.mode]}
            </button>
          </Tooltip>
          {SEP}
          <span>{modelFamily(agent.model)}</span>
          {SEP}
          <span>{runningText(agent, now)}</span>
        </span>
      </div>
      <ContextRingButton variant="header" used={contextFraction(agent.contextUsed, agent.contextWindow)} warnAt={warnAt} dangerAt={dangerAt} onClick={onCompact} />
      <Button size={28} className="!h-[30px] !rounded-[7px]" icon="terminal" onClick={onRawTerminal}>
        Raw terminal
      </Button>
      {resumable ? (
        <Button size={28} className="!h-[30px] !rounded-[7px]" icon="play" onClick={onResume}>
          Resume
        </Button>
      ) : (
        <Button size={28} className="!h-[30px] !rounded-[7px]" icon="pause" onClick={onPause} disabled={agent.status === 'queued'}>
          Pause
        </Button>
      )}
      <Button size={28} variant="danger" className="!h-[30px] !rounded-[7px]" onClick={onStop} disabled={!STOPPABLE.has(agent.status)}>
        Stop
      </Button>
    </div>
  );
}

export interface SubagentHeaderProps {
  agent: AgentSummary;
  sub: SubagentInfo;
  now: number;
  onLead(): void;
  onStop(): void;
  stopRequested: boolean;
}

export function SubagentHeader({ agent, sub, now, onLead, onStop, stopRequested }: SubagentHeaderProps) {
  const meta = subagentStatusMeta(sub.status);
  const used = contextFraction(sub.contextUsed ?? 0, agent.contextWindow);
  const active = isSubagentActive(sub);
  return (
    <div className="flex items-center gap-3 px-5 py-3 border-b border-line flex-wrap">
      <div className="flex flex-col gap-[3px] flex-1 min-w-[240px]">
        <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-[12px] text-ink-3">
          <button type="button" onClick={onLead} className="border-0 bg-transparent p-0 text-link text-[12px] hover:text-link-hover">
            {agent.title}
          </button>
          <span aria-hidden="true">›</span>
          <span>Subagent</span>
        </nav>
        <h1 className="m-0 text-[17px] font-semibold tracking-[-0.01em] flex items-center gap-2">
          <span aria-hidden="true" className="w-2 h-2 rounded-full" style={{ background: meta.color }} />
          {sub.name}
        </h1>
        <span className="flex items-center gap-2 text-[12px] text-ink-3 flex-wrap">
          <span>{modelEffort(sub, ', ')}</span>
          {SEP}
          <span>routed as {routeLabel(sub)}</span>
          {SEP}
          <span style={{ color: meta.color }}>{subagentStatusText(sub, now)}</span>
          {SEP}
          <span>{formatTokens(tokenCount(sub.usage))} tokens</span>
        </span>
      </div>
      <Tooltip content="A subagent has its own context. It is discarded when the subagent reports back." placement="bottom-end">
        <span
          tabIndex={0}
          aria-label={`Subagent context ${contextPercent(used)}% full`}
          className="h-[30px] flex items-center gap-1.5 pl-[5px] pr-2.5 border border-line-2 rounded-full text-ink-2 text-[12px] hover:bg-selected hover:border-line-3 focus-visible:bg-selected"
        >
          <ContextRing used={used} size={22} color="var(--color-accent)" />
          <span>
            Own context <span className="font-mono">{contextPercent(used)}%</span>
          </span>
        </span>
      </Tooltip>
      {active && (
        <Tooltip content="Takes effect at its next tool call: oIDE denies that call with a stop message, so it reports back early." placement="bottom-end">
          <Button size={28} variant="danger" className="!h-[30px] !rounded-[7px]" onClick={onStop} disabled={stopRequested}>
            {stopRequested ? 'Stopping at next tool call…' : 'Stop subagent'}
          </Button>
        </Tooltip>
      )}
      {sub.status === 'done' && <Icon name="check" size={16} className="text-ok" title="Done" />}
    </div>
  );
}
