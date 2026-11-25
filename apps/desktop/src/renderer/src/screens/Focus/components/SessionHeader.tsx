import type { AgentSummary, PermissionMode, SubagentInfo } from '@oide/protocol';
import { Badge, Button, ContextRing, ContextRingButton, Icon, Menu, Tooltip, contextFraction, contextPercent, contextTooltip, modelFamily, subagentStatusMeta } from '@oide/ui';
import { ARCHIVE_REASON_LABEL, formatEnded } from '../../../stores/archive';
import { canArchive } from '../../Wall/logic';
import { PrLink } from '../../../components/PrLink';
import { formatTokens } from '../../../lib/format';
import { MODE_LABEL, type ModeChoice, isSubagentActive, modelEffort, routeLabel, runningText, subagentStatusText, tokenCount } from '../model/focus';

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
  /** The modes the menu offers (modeChoices), in Shift+Tab order. */
  modes: readonly ModeChoice[];
  onSetMode(mode: PermissionMode): void;
  onCompact(): void;
  onRawTerminal(): void;
  onPause(): void;
  onResume(): void;
  onStop(): void;
  /** Finished or stopped agents: move to Wall › Archived. */
  onArchive?(): void;
  /** Archived agent (read-only): back to the Wall, or delete permanently. */
  onUnarchive?(): void;
  onDelete?(): void;
}

const RESUMABLE = new Set(['paused', 'stopped', 'error', 'rate-limited']);
const STOPPABLE = new Set(['running', 'starting', 'needs-permission', 'queued']);

/**
 * The permission mode in the meta line: a menu of every mode, so any mode can be picked at any
 * time (Plan, then Manual after the plan is approved, then Auto or Bypass). Shift+Tab still cycles.
 */
function ModeMenu({ current, modes, shortcut, onSetMode }: { current: PermissionMode; modes: readonly ModeChoice[]; shortcut: string; onSetMode(mode: PermissionMode): void }) {
  return (
    <Menu
      portal
      label={`Permission mode: ${MODE_LABEL[current]}. Change mode (${shortcut} cycles)`}
      className="shrink-0"
      triggerClassName="!h-auto !px-0 !border-0 !bg-transparent !text-ink-3 !text-[12px] hover:!text-ink hover:underline !gap-0.5"
      trigger={
        <>
          {MODE_LABEL[current]}
          <Icon name="chevron-down" size={12} />
        </>
      }
      items={modes.map((c) => ({
        id: c.mode,
        label: MODE_LABEL[c.mode],
        checked: c.mode === current,
        ...(c.disabled ? { disabled: true, hint: c.disabled.hint, title: c.disabled.reason } : {}),
        onSelect: () => c.mode !== current && onSetMode(c.mode),
      }))}
    />
  );
}

export function LeadHeader({ agent, project, now, warnAt, dangerAt, modeShortcut, modes, onSetMode, onCompact, onRawTerminal, onPause, onResume, onStop, onArchive, onUnarchive, onDelete }: LeadHeaderProps) {
  const worktree = agent.branch ? agent.branch.split('/').pop() : undefined;
  const resumable = RESUMABLE.has(agent.status) && !agent.resumeBlocked;
  if (agent.archived) return <ArchivedHeader agent={agent} project={project} worktree={worktree} onUnarchive={onUnarchive} onDelete={onDelete} />;
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
          <ModeMenu current={agent.mode} modes={modes} shortcut={modeShortcut} onSetMode={onSetMode} />
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
        tooltip={contextTooltip({ used: agent.contextUsed, window: agent.contextWindow, baseline: agent.contextBaseline, suffix: 'click to /compact this session' })}
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
      {agent.pr && <PrLink pr={agent.pr} className="shrink-0 @max-[700px]:hidden" />}
      {onArchive && canArchive(agent) && (
        <Button size={28} className={ACTION} icon="archive" onClick={onArchive} title="Archive">
          <span className={NARROW_LABEL}>Archive</span>
        </Button>
      )}
      <Button size={28} variant="danger" className={ACTION} onClick={onStop} disabled={!STOPPABLE.has(agent.status)}>
        Stop
      </Button>
    </div>
  );
}

/** Focus header of an archived agent: read-only (transcript from the database), Unarchive or Delete permanently. */
function ArchivedHeader({ agent, project, worktree, onUnarchive, onDelete }: { agent: AgentSummary; project: string; worktree?: string; onUnarchive?(): void; onDelete?(): void }) {
  const info = agent.archived!;
  return (
    <div className={ROW}>
      <div className="flex flex-col gap-[3px] flex-1 min-w-0">
        <div className="flex items-center gap-2 min-w-0">
          <h1 className="m-0 text-[17px] font-semibold tracking-[-0.01em] truncate" title={agent.title}>
            {agent.title}
          </h1>
          <Badge tone={info.reason === 'merged' ? 'ok' : info.reason === 'completed' ? 'review' : 'neutral'} icon="archive" className="shrink-0">
            {ARCHIVE_REASON_LABEL[info.reason]}
          </Badge>
        </div>
        <span className={META}>
          <span className="shrink-0">{project}</span>
          {worktree && (
            <>
              {SEP}
              <span className="font-mono truncate min-w-[3ch]">{worktree}</span>
            </>
          )}
          {SEP}
          <span className="shrink-0">Ended {formatEnded(info.at)}</span>
          {info.mergeCommit && (
            <>
              {SEP}
              <span className="font-mono shrink-0" title={`Merge commit ${info.mergeCommit}`}>
                {info.mergeCommit.slice(0, 7)}
              </span>
            </>
          )}
          <span className="contents @max-[700px]:hidden">
            {SEP}
            <span className="shrink-0">Read only</span>
          </span>
        </span>
      </div>
      {agent.pr && <PrLink pr={agent.pr} className="shrink-0" />}
      <Button size={28} className={ACTION} icon="archive" onClick={onUnarchive}>
        Unarchive
      </Button>
      <Button size={28} variant="danger" className={ACTION} icon="trash" onClick={onDelete}>
        <span className={NARROW_LABEL}>Delete permanently</span>
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
  const subWindow = sub.contextWindow ?? agent.contextWindow;
  const used = contextFraction(sub.contextUsed ?? 0, subWindow);
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
      <Tooltip
        content={contextTooltip({ used: sub.contextUsed ?? 0, window: subWindow, suffix: 'a subagent has its own context, discarded when it reports back' })}
        placement="bottom-end"
      >
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
