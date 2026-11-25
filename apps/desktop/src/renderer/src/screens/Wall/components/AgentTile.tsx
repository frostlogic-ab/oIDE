import { memo, useId, type KeyboardEvent, type MouseEvent } from 'react';
import type { AgentSummary } from '@oide/protocol';
import { Badge, Card, ContextRingButton, Icon, ModelLetterChip, StatusLabel, agentStatusMeta, cn, contextFraction, contextTooltip } from '@oide/ui';
import { useAgent } from '../../../stores/agents';
import { navigate } from '../../../stores/router';
import { useSetting } from '../../../stores/settings';
import { useNow } from '../actions';
import { branchLabel, modeBadge, statusAnnouncement, statusDetail, subagentDetail, subagentSummary, tileStatusLabel } from '../logic';
import { useWall } from '../wallState';
import { TileBody, TileFooter } from './TileBody';

export const tileDomId = (agentId: string) => `wall-tile-${agentId}`;

const INTERACTIVE = 'button, a, input, textarea, select, label, [role="button"]';

/**
 * One agent on the Wall (Main.dc.html "Tile 1…6"). Subscribes to its own agent only, so an event
 * on one agent re-renders one tile. Click (outside its controls) or Enter opens Focus.
 */
export const AgentTile = memo(function AgentTile({ agentId, projectName }: { agentId: string; projectName: string }) {
  const agent = useAgent(agentId);
  const focused = useWall((s) => s.focusedId === agentId);
  const highlighted = useWall((s) => s.highlighted[agentId] === true);
  if (!agent) return null;
  return <TileView agent={agent} projectName={projectName} focused={focused} highlighted={highlighted} />;
});

interface TileViewProps {
  agent: AgentSummary;
  projectName: string;
  focused: boolean;
  highlighted: boolean;
}

function TileView({ agent, projectName, focused, highlighted }: TileViewProps) {
  const titleId = useId();
  const now = useNow();
  const warnAt = useSetting((s) => s.agents.contextWarnAt, 0.65);
  const suggestAt = useSetting((s) => s.agents.contextSuggestCompactAt, 0.85);
  const defaultMode = useSetting((s) => s.claude.defaultMode, 'auto');
  const meta = agentStatusMeta(agent.status);
  const needsTone = meta.tone === 'needs';
  const used = contextFraction(agent.contextUsed, agent.contextWindow);
  const badge = modeBadge(agent.mode, defaultMode);
  const statusLabel = tileStatusLabel(agent, meta.label);

  const open = () => navigate('focus', { agentId: agent.id });
  const onClick = (e: MouseEvent<HTMLElement>) => {
    if ((e.target as HTMLElement).closest(INTERACTIVE)) return;
    open();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === 'Enter' && e.target === e.currentTarget) {
      e.preventDefault();
      open();
    }
  };

  return (
    <Card
      as="article"
      id={tileDomId(agent.id)}
      tone={meta.tone === 'muted' ? 'default' : meta.tone}
      tabIndex={0}
      aria-labelledby={titleId}
      data-agent-id={agent.id}
      data-status={agent.status}
      data-focused={focused || undefined}
      onClick={onClick}
      onKeyDown={onKeyDown}
      onFocus={() => useWall.getState().setFocused(agent.id)}
      className={cn(
        'flex flex-col overflow-visible! cursor-pointer outline-none transition-shadow',
        focused && 'ring-2 ring-accent ring-offset-2 ring-offset-ground',
        highlighted && !focused && 'ring-2 ring-accent/60 ring-offset-2 ring-offset-ground',
      )}
    >
      <span className="sr-only" aria-live="polite" aria-atomic="true">
        {statusAnnouncement(agent, statusLabel)}
      </span>
      <div className="flex items-center gap-2 px-3 pt-2.5 min-w-0">
        <span className={cn('font-mono text-[11px] truncate min-w-0', needsTone ? 'text-warn-ink' : 'text-ink-3')}>
          {projectName} · {branchLabel(agent)}
        </span>
        <div className="flex-1" />
        <StatusLabel status={agent.status} label={statusLabel} detail={statusDetail(agent, now)} />
        <ContextRingButton
          used={used}
          subject={agent.title}
          warnAt={warnAt}
          dangerAt={suggestAt}
          tooltip={contextTooltip({
            used: agent.contextUsed,
            window: agent.contextWindow,
            baseline: agent.contextBaseline,
            suffix: used >= suggestAt ? '/compact suggested' : 'click to /compact',
          })}
          className="ml-1"
          onClick={() => useWall.getState().openCompact(agent.id)}
        />
      </div>
      {/* The title owns its row; badges wrap on the row below so they never squeeze it. */}
      <h2 id={titleId} className="m-0 mx-3 mt-1 mb-2 min-w-0 text-[14px] font-semibold leading-[1.35] break-words">
        {agent.title}
      </h2>
      {(badge || agent.mergeConflict) && (
        <div className="flex flex-wrap items-center gap-1.5 mx-3 -mt-1 mb-2">
          {badge && (
            <Badge tone={badge.warn ? 'bad' : 'neutral'} icon={badge.warn ? 'warning' : undefined} title={badge.title}>
              {badge.label}
            </Badge>
          )}
          {agent.mergeConflict && (
            <Badge tone="warn" icon="branch" title={`Resolving the merge conflicts with ${agent.mergeConflict.target} that oIDE sent it`}>
              Resolving merge conflicts
            </Badge>
          )}
        </div>
      )}
      <TileBody agent={agent} />
      <SubagentChips agent={agent} now={now} />
      <TileFooter agent={agent} projectName={projectName} focused={focused} />
    </Card>
  );
}

function SubagentChips({ agent, now }: { agent: AgentSummary; now: number }) {
  if (!agent.subagents.length) return <div className="px-3 pt-2 text-[11px] text-ink-3">No subagents</div>;
  const summary = subagentSummary(agent.subagents);
  return (
    <div role="group" aria-label={`Subagents: ${summary}`} className="flex items-center gap-[5px] px-3 pt-2 flex-wrap">
      <Icon name="subagents" size={13} className="text-ink-3" />
      <span className="text-[11px] text-ink-3 mr-0.5">{summary}</span>
      {agent.subagents.map((s) => (
        <ModelLetterChip
          key={s.id}
          name={s.name}
          model={s.model}
          status={s.status}
          detailText={subagentDetail(s, agent.pendingPermission, now)}
          onClick={() => navigate('focus', { agentId: agent.id, subagentId: s.id })}
        />
      ))}
    </div>
  );
}
