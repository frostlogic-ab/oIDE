import { memo } from 'react';
import type { AgentSummary } from '@oide/protocol';
import { ContextMeter, Icon, Kbd, agentStatusMeta, contextFraction, modelLetter, subagentStatusMeta } from '@oide/ui';
import { agentListLine } from '../model/focus';
import { ResizableAside } from '../../../components/ResizableAside';
import { PANELS } from '../../../lib/panels';

export interface AgentListProps {
  /** Already in list order (sortAgentList). */
  agents: AgentSummary[];
  currentId: string;
  /** Selected subagent of the current agent, or undefined for the lead. */
  subagentId?: string;
  projectName(id: string): string;
  warnAt?: number;
  dangerAt?: number;
  onBack(): void;
  onSelect(agentId: string): void;
  onSelectSubagent(subagentId: string | undefined): void;
  labels: { next: string; prev: string; needs: string; back: string };
}

/** Mini wall (Focus.dc.html, 216px): the other agents stay visible; the current one shows its tree. */
export const AgentList = memo(function AgentList({ agents, currentId, subagentId, projectName, warnAt, dangerAt, onBack, onSelect, onSelectSubagent, labels }: AgentListProps) {
  return (
    // The list scrolls; the keyboard hints stay pinned at the bottom (visible at 700px tall).
    <ResizableAside panel={PANELS.focusAgents} aria-label="Other agents" className="flex flex-col bg-panel border-r border-line box-border min-h-0">
      <div className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-1.5 px-2.5 pt-3 pb-1.5">
      <a
        href="#wall"
        onClick={(e) => {
          e.preventDefault();
          onBack();
        }}
        className="flex items-center gap-2 px-2 py-1.5 rounded-md text-ink-2 no-underline text-[12px] hover:bg-raised hover:text-ink"
      >
        <Icon name="chevron-left" size={15} />
        <span className="flex-1">Back to wall</span>
        <Kbd>{labels.back}</Kbd>
      </a>
      <h2 className="m-0 px-2 pt-1.5 pb-0.5 text-[11px] font-semibold tracking-[0.08em] uppercase text-ink-3">Agents</h2>
      <ul className="m-0 p-0 list-none flex flex-col gap-1.5">
        {agents.map((a) => (
          <li key={a.id} className="flex flex-col">
            <AgentCard agent={a} current={a.id === currentId} project={projectName(a.projectId)} warnAt={warnAt} dangerAt={dangerAt} onSelect={onSelect} />
            {a.id === currentId && <SubTree agent={a} subagentId={subagentId} onSelect={onSelectSubagent} />}
          </li>
        ))}
      </ul>
      </div>
      <div className="shrink-0 flex flex-col gap-1.5 px-4.5 pt-2 pb-5 text-[11.5px] text-ink-3">
        <span className="flex justify-between">
          Next agent <Kbd>{labels.next}</Kbd>
        </span>
        <span className="flex justify-between">
          Previous agent <Kbd>{labels.prev}</Kbd>
        </span>
        <span className="flex justify-between">
          Next that needs you <Kbd>{labels.needs}</Kbd>
        </span>
      </div>
    </ResizableAside>
  );
});

function AgentCard({ agent, current, project, warnAt, dangerAt, onSelect }: { agent: AgentSummary; current: boolean; project: string; warnAt?: number; dangerAt?: number; onSelect(id: string): void }) {
  const meta = agentStatusMeta(agent.status);
  const line = agentListLine(agent);
  const needs = meta.tone === 'needs' || meta.tone === 'error';
  const used = contextFraction(agent.contextUsed, agent.contextWindow);
  const body = (
    <>
      {/* Titles wrap to two lines (as on the canvas) so every agent stays identifiable at 216px. */}
      <span className="flex items-start gap-1.5 font-semibold text-[12.5px] leading-[1.25] min-w-0">
        <span aria-hidden="true" className="w-[7px] h-[7px] rounded-full shrink-0 mt-[4px]" style={{ background: meta.color }} />
        <span className="flex-1 min-w-0 line-clamp-2 break-words" title={agent.title}>
          {agent.title}
        </span>
        <ContextMeter used={used} warnAt={warnAt} dangerAt={dangerAt} />
      </span>
      {current ? (
        <span className="font-mono text-[10.5px] text-ink-3 truncate">{project} · viewing</span>
      ) : (
        <span className={`truncate ${line.mono ? 'font-mono text-[10.5px]' : 'text-[11px]'} ${line.tone === 'warn' ? 'text-warn' : 'text-ink-3'}`}>{line.text}</span>
      )}
      <span className="sr-only">, {meta.label}</span>
    </>
  );
  if (current) {
    return (
      <div aria-current="true" className="p-2 rounded-md bg-selected border border-line-3 flex flex-col gap-[3px]">
        {body}
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={() => onSelect(agent.id)}
      className={`p-2 rounded-md border flex flex-col gap-[3px] text-left text-ink ${needs ? 'bg-warn-bg border-warn-line hover:bg-warn-bg-2' : 'bg-transparent border-line-2 hover:bg-raised'}`}
    >
      {body}
    </button>
  );
}

function SubTree({ agent, subagentId, onSelect }: { agent: AgentSummary; subagentId?: string; onSelect(id: string | undefined): void }) {
  return (
    <div role="group" aria-label="Lead agent and its subagents" className="flex flex-col gap-px mt-1 mb-1.5 ml-3 pl-2 border-l border-line-3">
      <button
        type="button"
        aria-current={subagentId ? undefined : 'true'}
        onClick={() => onSelect(undefined)}
        className={`h-[26px] flex items-center gap-1.5 px-1.5 border-0 rounded-sm text-ink text-[11.5px] text-left ${subagentId ? 'bg-transparent hover:bg-raised' : 'bg-selected'}`}
      >
        <span className="flex-1">Lead agent</span>
        <span className="font-mono text-[9.5px] text-ink-3">{modelLetter(agent.model)}</span>
      </button>
      {agent.subagents.map((s) => {
        const cur = s.id === subagentId;
        return (
          <button
            key={s.id}
            type="button"
            aria-current={cur ? 'true' : undefined}
            onClick={() => onSelect(s.id)}
            className={`h-[26px] flex items-center gap-1.5 px-1.5 border-0 rounded-sm text-[11.5px] text-left ${cur ? 'bg-selected text-ink' : 'bg-transparent text-ink-2 hover:bg-raised'}`}
          >
            <span aria-hidden="true" className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: subagentStatusMeta(s.status).color }} />
            <span className="flex-1 truncate">{s.name}</span>
            <span className="sr-only">, {subagentStatusMeta(s.status).label}</span>
            <span className="font-mono text-[9.5px] text-ink-3">{modelLetter(s.model)}</span>
          </button>
        );
      })}
    </div>
  );
}
