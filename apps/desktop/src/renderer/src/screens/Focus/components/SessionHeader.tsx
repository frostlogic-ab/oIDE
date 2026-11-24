import type { AgentSummary, SubagentInfo } from '@oide/protocol';
import { Button, ContextRing, ContextRingButton, Icon, Tooltip, contextFraction, contextPercent, modelFamily, subagentStatusMeta } from '@oide/ui';
import { formatTokens } from '../../../lib/format';
import { MODE_LABEL, isSubagentActive, modelEffort, routeLabel, runningText, subagentStatusText, tokenCount } from '../model/focus';

const SEP = (
  <span aria-hidden="true" className="text-ink-3 shrink-0">
    ·
  </span>
);

/**
 * The header stays one row down to the 1100px window minimum (main is a size container, see
 * index.tsx): below 700px of session width the title and meta truncate, secondary meta drops,
 * and Raw terminal / Pause / "Context" / "Own context" keep only their icon (the words stay as
 * the accessible name).
 */
const ROW = 'flex items-center gap-3 @max-[700px]:gap-2 px-5 py-3 border-b border-line min-w-0';
const NARROW_LABEL = '@max-[700px]:sr-only';
/** Meta line: one line; items keep their size except the one marked to shrink. */
const META = 'flex items-center gap-2 text-[12px] text-ink-3 whitespace-nowrap overflow-hidden min-w-0 py-0.5 -my-0.5 px-0.5 -mx-0.5';
const ACTION = '!h-[30px] !rounded-[7px] shrink-0';

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
    <div className={ROW}>
      <div className="flex flex-col gap-[3px] flex-1 min-w-0">
        <h1 className="m-0 text-[17px] font-semibold tracking-[-0.01em] truncate" title={agent.title}>
          {agent.title}
        </h1>
        <span className={META}>
          <span className="shrink-0">{project}</span>
          {worktree && (
            <>
              {SEP}
              <span className="font-mono truncate min-w-[3ch]" title={`worktree ${worktree}`}>
                <span className="@max-[700px]:hidden">worktree </span>
                {worktree}
              </span>
            </>
          )}
          {SEP}
          <Tooltip content={`Switch mode (${modeShortcut})`} placement="bottom-start">
            <button
              type="button"
              onClick={onCycleMode}
              aria-label={`${MODE_LABEL[agent.mode]}. Switch permission mode`}
              className="shrink-0 border-0 bg-transparent p-0 text-ink-3 text-[12px] hover:text-ink hover:underline"
            >
              {MODE_LABEL[agent.mode]}
            </button>
          </Tooltip>
          <span className="contents @max-[700px]:hidden">
            {SEP}
            <span className="shrink-0">{modelFamily(agent.model)}</span>
          </span>
          {SEP}
          <span className="shrink-0">{runningText(agent, now)}</span>
        </span>
      </div>
      <ContextRingButton
        variant="header"
        used={contextFraction(agent.contextUsed, agent.contextWindow)}
        warnAt={warnAt}
        dangerAt={dangerAt}
        onClick={onCompact}
        className="shrink-0"
        labelClassName={NARROW_LABEL}
      />
      <Button size={28} className={ACTION} icon="terminal" onClick={onRawTerminal} title="Raw terminal">
        <span className={NARROW_LABEL}>Raw terminal</span>
      </Button>
      {resumable ? (
        <Button size={28} className={ACTION} icon="play" onClick={onResume} title="Resume">
          <span className={NARROW_LABEL}>Resume</span>
        </Button>
      ) : (
        <Button size={28} className={ACTION} icon="pause" onClick={onPause} disabled={agent.status === 'queued'} title="Pause">
          <span className={NARROW_LABEL}>Pause</span>
        </Button>
      )}
      <Button size={28} variant="danger" className={ACTION} onClick={onStop} disabled={!STOPPABLE.has(agent.status)}>
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
    <div className={ROW}>
      <div className="flex flex-col gap-[3px] flex-1 min-w-0">
        <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-[12px] text-ink-3 min-w-0 whitespace-nowrap">
          <button type="button" onClick={onLead} className="min-w-0 truncate border-0 bg-transparent p-0 text-link text-[12px] text-left hover:text-link-hover" title={agent.title}>
            {agent.title}
          </button>
          <span aria-hidden="true">›</span>
          <span>Subagent</span>
        </nav>
        <h1 className="m-0 text-[17px] font-semibold tracking-[-0.01em] flex items-center gap-2 min-w-0">
          <span aria-hidden="true" className="w-2 h-2 rounded-full shrink-0" style={{ background: meta.color }} />
          <span className="truncate">{sub.name}</span>
        </h1>
        <span className={META}>
          <span className="shrink-0">{modelEffort(sub, ', ')}</span>
          <span className="contents @max-[700px]:hidden">
            {SEP}
            <span className="truncate min-w-[3ch]">routed as {routeLabel(sub)}</span>
          </span>
          {SEP}
          <span className="shrink-0" style={{ color: meta.color }}>
            {subagentStatusText(sub, now)}
          </span>
          {SEP}
          <span className="shrink-0">{formatTokens(tokenCount(sub.usage))} tokens</span>
        </span>
      </div>
      <Tooltip content="A subagent has its own context. It is discarded when the subagent reports back." placement="bottom-end">
        <span
          tabIndex={0}
          aria-label={`Subagent context ${contextPercent(used)}% full`}
          className="h-[30px] shrink-0 flex items-center gap-1.5 pl-[5px] pr-2.5 border border-line-2 rounded-full text-ink-2 text-[12px] hover:bg-selected hover:border-line-3 focus-visible:bg-selected"
        >
          <ContextRing used={used} size={22} color="var(--color-accent)" />
          <span>
            <span className={NARROW_LABEL}>Own context </span>
            <span className="font-mono">{contextPercent(used)}%</span>
          </span>
        </span>
      </Tooltip>
      {active && (
        <Tooltip content="Takes effect at its next tool call: oIDE denies that call with a stop message, so it reports back early." placement="bottom-end">
          <Button size={28} variant="danger" className={ACTION} onClick={onStop} disabled={stopRequested}>
            {stopRequested ? 'Stopping at next tool call…' : 'Stop subagent'}
          </Button>
        </Tooltip>
      )}
      {sub.status === 'done' && <Icon name="check" size={16} className="text-ok" title="Done" />}
    </div>
  );
}
