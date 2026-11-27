import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { AgentEvent, AgentSummary, ArtifactMeta, ArtifactUse, FileDiff, InstalledExtension } from '@oide/protocol';
import { Button, ContextMeter, EmptyState, Icon, Spinner, Tabs, contextFraction, modelFamily, subagentStatusMeta, tabPanelProps } from '@oide/ui';
import { invokeOr, ipcErrorMessage, oide } from '../../../lib/bridge';
import { formatDuration, formatTokens } from '../../../lib/format';
import { navigate } from '../../../stores/router';
import { isSubagentActive, modelEffort, routeLabel, routingLine, subagentStatusText, subagentSummary, subagentTokenShare, timeline, tokenCount } from '../model/focus';
import { subagentFiles } from '../model/transcript';
import { InspectorPanelFrames, useInspectorPanels } from '../../../extensions/InspectorPanels';
import { Markdown } from './Markdown';
import { ResizableAside } from '../../../components/ResizableAside';
import { PANELS } from '../../../lib/panels';

import { TerminalTabs } from '../../../components/terminal/TerminalTabs';

/** `ext:<extension>::<panel id>`: an extension panel (`contributes.panels`, location "inspector"). */
export type InspectorTab = 'plan' | 'subs' | 'changes' | 'artifacts' | 'term' | `ext:${string}`;

export interface InspectorProps {
  agent: AgentSummary;
  /** Lead + subagent events held by the transcript (for artifact use and subagent files). */
  events: readonly AgentEvent[];
  subEvents: ReadonlyMap<string, AgentEvent[]>;
  tab: InspectorTab;
  onTab(tab: InspectorTab): void;
  now: number;
  stopRequested: ReadonlySet<string>;
  onOpenSubagent(id: string): void;
  onStopSubagent(id: string): void;
}

const ID = 'focus-insp';

export function Inspector({ agent, events, subEvents, tab, onTab, now, stopRequested, onOpenSubagent, onStopSubagent }: InspectorProps) {
  const [termMounted, setTermMounted] = useState(tab === 'term');
  useEffect(() => {
    if (tab === 'term') setTermMounted(true);
  }, [tab]);

  const extTabs = useInspectorPanels(agent, onTab, ID);
  const isExt = tab.startsWith('ext:');
  const tabs: Array<{ id: InspectorTab; label: string }> = [
    { id: 'plan', label: 'Plan' },
    { id: 'subs', label: `Subagents${agent.subagents.length ? ` ${agent.subagents.length}` : ''}` },
    { id: 'changes', label: 'Changes' },
    { id: 'artifacts', label: 'Artifacts' },
    { id: 'term', label: 'Terminal' },
    ...extTabs.map((t) => ({ id: t.id, label: t.label })),
  ];

  return (
    // A size container: below its 340px maximum (the 1100–1280px windows) the five tabs tighten
    // their padding so "Terminal" is never clipped.
    <ResizableAside panel={PANELS.focusInspector} aria-label="Inspector" className="@container flex flex-col bg-panel border-l border-line box-border min-h-0">
      <div className="px-2 @max-[339px]:px-1 pt-2 border-b border-line">
        <Tabs
          tabs={tabs}
          value={tab}
          onChange={onTab}
          label="Inspector"
          idPrefix={ID}
          // Extension panels add tabs: tighter padding, and the row wraps so every tab stays visible
          // (a hidden-scrollbar row clipped "Preview" past the panel edge at 1440 and 1100).
          className={extTabs.length ? 'flex-wrap' : '[scrollbar-width:none]'}
          tabClassName={extTabs.length ? 'px-1' : '@max-[339px]:px-1'}
        />
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto flex flex-col" hidden={tab === 'term' || isExt}>
        {tab === 'plan' && <PlanPanel agent={agent} events={events} />}
        {tab === 'subs' && <SubagentsPanel agent={agent} subEvents={subEvents} now={now} stopRequested={stopRequested} onOpen={onOpenSubagent} onStop={onStopSubagent} />}
        {tab === 'changes' && <ChangesPanel agent={agent} />}
        {tab === 'artifacts' && <ArtifactsPanel agent={agent} events={events} />}
      </div>
      {termMounted && (
        <div {...tabPanelProps(ID, 'term')} hidden={tab !== 'term'} className="flex-1 min-h-0 flex flex-col" style={tab !== 'term' ? { display: 'none' } : undefined}>
          {agent.worktreePath ? (
            // Several shells per agent, in its worktree (xterm loads with the first one shown).
            <TerminalTabs key={agent.id} group={`agent:${agent.id}`} label="Terminals in the agent's worktree" newCwd={agent.worktreePath} autoStart visible={tab === 'term'} />
          ) : (
            <EmptyState icon="terminal" title="No worktree yet" description="The terminal opens in the agent's worktree once it has one." className="flex-1" />
          )}
        </div>
      )}
      <InspectorPanelFrames agent={agent} tabs={extTabs} tab={tab} idPrefix={ID} />
      {tab !== 'term' && !isExt && <AgentTools projectId={agent.projectId} />}
    </ResizableAside>
  );
}

function Panel({ id, children, className }: { id: InspectorTab; children: ReactNode; className?: string }) {
  return (
    <div {...tabPanelProps(ID, id)} className={`flex flex-col outline-none ${className ?? ''}`}>
      {children}
    </div>
  );
}

const SECTION = 'px-4 pt-2 pb-1 text-[11px] font-semibold tracking-[0.08em] uppercase text-ink-3';

// ---------- Plan ----------

function PlanPanel({ agent, events }: { agent: AgentSummary; events: readonly AgentEvent[] }) {
  return (
    <Panel id="plan" className="gap-0">
      {agent.todos.length === 0 && !agent.planText ? (
        <EmptyState icon="info" title="No plan yet" description="When the agent writes a todo list or leaves plan mode, its plan shows here." className="py-10" />
      ) : (
        <ul aria-label="Plan" className="m-0 list-none flex flex-col gap-[9px] px-4 py-3.5">
          {agent.todos.map((t, i) => (
            <li key={i} className={`flex gap-2 items-start ${t.status === 'completed' ? 'text-ink-2' : t.status === 'in_progress' ? 'font-semibold text-ink' : 'text-ink-3'}`}>
              {t.status === 'completed' ? (
                <Icon name="check" size={16} className="text-ok shrink-0" />
              ) : (
                <span aria-hidden="true" className={`w-4 h-4 rounded-full box-border shrink-0 ${t.status === 'in_progress' ? 'border-2 border-warn' : 'border-[1.5px] border-line-hover'}`} />
              )}
              <span>{t.status === 'in_progress' && t.activeForm ? t.content : t.content}</span>
              <span className="sr-only">({t.status === 'completed' ? 'done' : t.status === 'in_progress' ? 'in progress' : 'to do'})</span>
            </li>
          ))}
        </ul>
      )}
      {agent.planText && (
        <>
          <div className={SECTION}>Plan from plan mode</div>
          <div className="px-4 pb-4 text-[12.5px]">
            <Markdown text={agent.planText} />
          </div>
        </>
      )}
      {/* The canvas draws the plan with the changed files and artifacts in use underneath. */}
      <div className={SECTION}>Changed files</div>
      <ChangesList agent={agent} />
      <div className={`${SECTION} pt-1`}>Artifacts in use</div>
      <ArtifactsList agent={agent} events={events} />
    </Panel>
  );
}

// ---------- Subagents ----------

function SubagentsPanel({
  agent,
  subEvents,
  now,
  stopRequested,
  onOpen,
  onStop,
}: {
  agent: AgentSummary;
  subEvents: ReadonlyMap<string, AgentEvent[]>;
  now: number;
  stopRequested: ReadonlySet<string>;
  onOpen(id: string): void;
  onStop(id: string): void;
}) {
  const subs = agent.subagents;
  if (!subs.length) {
    return (
      <Panel id="subs">
        <EmptyState icon="subagents" title="No subagents" description="When this agent hands a task to a subagent, it shows here with its own transcript and context." className="py-10" />
      </Panel>
    );
  }
  const summary = subagentSummary(subs);
  const { bars, spanMs } = timeline(agent.createdAt, subs, now);
  const share = Math.round(subagentTokenShare(agent) * 100);
  const mins = Math.max(1, Math.round(spanMs / 60_000));
  return (
    <Panel id="subs" className="gap-3 px-4 py-3.5">
      <span className="text-[12.5px] text-ink-2">
        {summary.total}
        {summary.parts.map((p, i) => (
          <span key={i}>
            {' · '}
            <span className={p.warn ? 'text-warn' : undefined}>{p.text}</span>
          </span>
        ))}
      </span>
      <span className="text-[11.5px] text-ink-3 leading-[1.5]">{routingLine(agent.model, subs)}</span>

      <div role="img" aria-label={`Timeline of subagents over this agent's ${mins} minutes`} className="flex flex-col gap-[5px] p-2.5 rounded-[10px] border border-line-2 bg-card">
        <div className="flex items-center gap-2 text-[10.5px] text-ink-3">
          <span className="w-[92px] truncate">Lead · {modelFamily(agent.model)}</span>
          <span className="flex-1 h-1.5 rounded-[3px] bg-[#4A5568]" />
        </div>
        {subs.map((s, i) => (
          <div key={s.id} className="flex items-center gap-2 text-[10.5px] text-ink-2">
            <span className="w-[92px] truncate">{s.name}</span>
            <span className="flex-1 h-1.5 rounded-[3px] bg-line-6 relative">
              <span className="absolute top-0 bottom-0 rounded-[3px]" style={{ left: `${bars[i]!.left}%`, width: `${bars[i]!.width}%`, background: subagentStatusMeta(s.status).color }} />
            </span>
          </div>
        ))}
        <div className="font-mono flex justify-between pl-[100px] text-[10px] text-ink-3">
          <span>0m</span>
          <span>{formatDuration(spanMs / 2)}</span>
          <span>now {formatDuration(spanMs)}</span>
        </div>
      </div>

      {subs.map((s) => {
        const meta = subagentStatusMeta(s.status);
        const need = s.status === 'needs-permission';
        const requested = stopRequested.has(s.id);
        return (
          <div key={s.id} className={`flex flex-col gap-2 p-2.5 rounded-[10px] border ${need ? 'border-warn-line bg-warn-bg' : 'border-line-2 bg-card'}`}>
            <div className="flex items-center gap-2">
              <span aria-hidden="true" className="w-[7px] h-[7px] rounded-full" style={{ background: meta.color }} />
              <span className="flex-1 font-semibold text-[12.5px] truncate">{s.name}</span>
              <ContextMeter used={contextFraction(s.contextUsed ?? 0, s.contextWindow ?? agent.contextWindow)} color="var(--color-accent)" />
            </div>
            <span className="text-[11.5px] text-ink-3">
              {modelEffort(s, ', ')} · routed as {routeLabel(s)}
            </span>
            <span className="text-[11.5px]" style={{ color: meta.color }}>
              {subagentStatusText(s, now)} ·{' '}
              <span className="text-ink-3">
                {formatTokens(tokenCount(s.usage))} tokens · {subagentFiles(subEvents.get(s.id) ?? [])}
              </span>
            </span>
            <div className="flex gap-1.5">
              <Button size={28} className="!h-[26px] !px-[9px] !text-[11.5px]" onClick={() => onOpen(s.id)} aria-label={`Open subagent ${s.name}`}>
                Open
              </Button>
              {isSubagentActive(s) && (
                <Button
                  size={28}
                  variant="danger"
                  className="!h-[26px] !px-[9px] !text-[11.5px]"
                  disabled={requested}
                  onClick={() => onStop(s.id)}
                  aria-label={`Stop subagent ${s.name}`}
                  title="Takes effect at its next tool call"
                >
                  {requested ? 'Stopping…' : 'Stop'}
                </Button>
              )}
            </div>
          </div>
        );
      })}
      <span className="text-[11.5px] text-ink-3">Subagents have used {share}% of this agent's tokens so far.</span>
    </Panel>
  );
}

// ---------- Changes ----------

function ChangesPanel({ agent }: { agent: AgentSummary }) {
  return (
    <Panel id="changes">
      <div className={`${SECTION} pt-3.5`}>Changed files</div>
      <ChangesList agent={agent} showReviewAll />
    </Panel>
  );
}

function ChangesList({ agent, showReviewAll }: { agent: AgentSummary; showReviewAll?: boolean }) {
  const [files, setFiles] = useState<FileDiff[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const diffKey = `${agent.diff?.files ?? 0}:${agent.diff?.additions ?? 0}:${agent.diff?.deletions ?? 0}`;
  const [bump, setBump] = useState(0);

  useEffect(() => oide.on('git.changed', ({ projectId }) => projectId === agent.projectId && setBump((n) => n + 1)), [agent.projectId]);
  useEffect(() => {
    let cancelled = false;
    invokeOr('git.diff', { agentId: agent.id }, [] as FileDiff[]).then(
      (f) => !cancelled && (setFiles(f), setError(null)),
      (err: unknown) => !cancelled && setError(ipcErrorMessage(err)),
    );
    return () => {
      cancelled = true;
    };
  }, [agent.id, diffKey, bump]);

  return (
    <>
      {error && <div className="px-4 py-2 text-[12px] text-bad">{error}</div>}
      {!files && !error && (
        <div className="px-4 py-3">
          <Spinner size={14} />
        </div>
      )}
      {files?.length === 0 && <div className="px-4 py-2 text-[12px] text-ink-3">No changes in this worktree yet.</div>}
      <ul className="m-0 p-0 px-2.5 pb-3 list-none font-mono flex flex-col gap-0.5 text-[11.5px]">
        {files?.map((f) => (
          <li key={f.path}>
            <button
              type="button"
              onClick={() => navigate('review', { agentId: agent.id })}
              title={`Open ${f.path} in Review`}
              className="w-full flex gap-2 p-1.5 border-0 rounded-sm bg-transparent text-ink-2 text-left font-mono text-[11.5px] hover:bg-raised"
            >
              <span className="flex-1 min-w-0 truncate">{f.path}</span>
              {f.additions > 0 && <span className="text-ok">+{f.additions}</span>}
              {f.deletions > 0 && <span className="text-bad">−{f.deletions}</span>}
              {f.additions === 0 && f.deletions === 0 && <span className="text-ink-3">{f.status}</span>}
            </button>
          </li>
        ))}
      </ul>
      {showReviewAll && files && files.length > 0 && (
        <div className="px-4 pb-3">
          <Button size={28} onClick={() => navigate('review', { agentId: agent.id })}>
            Review all changes
          </Button>
        </div>
      )}
    </>
  );
}

// ---------- Artifacts ----------

const ARTIFACT_TOOLS: Record<string, ArtifactUse['op']> = {
  mcp__oide__artifacts_read: 'read',
  mcp__oide__artifacts_write: 'write',
  mcp__oide__artifacts_create: 'create',
};

/** Artifact ids this agent touched, from its oIDE MCP tool calls (fallback when main has no uses log). */
export function artifactUsesFromEvents(events: readonly AgentEvent[]): Map<string, Set<ArtifactUse['op']>> {
  const out = new Map<string, Set<ArtifactUse['op']>>();
  for (const e of events) {
    if (e.type !== 'tool-use') continue;
    const op = ARTIFACT_TOOLS[e.name];
    const id = e.input && typeof e.input === 'object' ? (e.input as Record<string, unknown>).id : undefined;
    if (!op || typeof id !== 'string') continue;
    if (!out.has(id)) out.set(id, new Set());
    out.get(id)!.add(op);
  }
  return out;
}

function ArtifactsPanel({ agent, events }: { agent: AgentSummary; events: readonly AgentEvent[] }) {
  return (
    <Panel id="artifacts">
      <div className={`${SECTION} pt-3.5`}>Artifacts in use</div>
      <ArtifactsList agent={agent} events={events} />
    </Panel>
  );
}

function ArtifactsList({ agent, events }: { agent: AgentSummary; events: readonly AgentEvent[] }) {
  const [list, setList] = useState<ArtifactMeta[] | null>(null);
  const [uses, setUses] = useState<Record<string, ArtifactUse[]>>({});
  const fromEvents = useMemo(() => artifactUsesFromEvents(events), [events]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const all = await invokeOr('artifacts.list', { projectId: agent.projectId }, [] as ArtifactMeta[]).catch(() => [] as ArtifactMeta[]);
      const u = all.length ? await invokeOr('artifacts.uses', { ids: all.map((a) => a.id).slice(0, 500) }, {} as Record<string, ArtifactUse[]>).catch(() => ({})) : {};
      if (!cancelled) {
        setList(all);
        setUses(u);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [agent.projectId, agent.id]);

  const used = useMemo(() => {
    if (!list) return null;
    return list
      .map((a) => {
        const ops = new Set<ArtifactUse['op']>(fromEvents.get(a.id) ?? []);
        for (const u of uses[a.id] ?? []) if (u.agentId === agent.id) ops.add(u.op);
        return { a, ops: [...ops].filter((o) => o !== 'list') };
      })
      .filter((x) => x.ops.length > 0);
  }, [list, uses, fromEvents, agent.id]);

  return (
    <>
      {!used && (
        <div className="px-4 py-3">
          <Spinner size={14} />
        </div>
      )}
      {used?.length === 0 && <div className="px-4 py-2 text-[12px] text-ink-3">This agent has not used any artifacts. Attach one from the composer.</div>}
      <ul className="m-0 list-none flex flex-col gap-2 px-4 pt-1 pb-3">
        {used?.map(({ a, ops }) => (
          <li key={a.id}>
            <button
              type="button"
              onClick={() => navigate('artifacts', { artifactId: a.id })}
              className="w-full flex gap-2.5 items-center p-2 border border-line-2 rounded-[10px] bg-card text-left text-ink hover:border-line-hover"
            >
              <ArtifactThumb kind={a.kind} />
              <span className="flex flex-col gap-0.5 min-w-0">
                <span className="font-semibold truncate">{a.title}</span>
                <span className="text-[11.5px] text-ink-3">
                  {a.kind === 'design' ? 'Design' : a.kind === 'doc' ? 'Doc' : 'Whiteboard'} · {ops.join(', ')}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

function ArtifactThumb({ kind }: { kind: ArtifactMeta['kind'] }) {
  if (kind === 'whiteboard') {
    return (
      <span aria-hidden="true" className="w-[50px] h-9 rounded-sm bg-raised relative shrink-0">
        <span className="absolute left-[5px] top-[11px] w-[15px] h-3 border-[1.5px] border-link rounded-[3px]" />
        <span className="absolute left-5 top-[17px] w-2.5 h-[1.5px] bg-ink-4" />
        <span className="absolute left-[30px] top-[11px] w-[15px] h-3 border-[1.5px] border-ok rounded-sm" />
      </span>
    );
  }
  if (kind === 'doc') {
    return (
      <span aria-hidden="true" className="w-[50px] h-9 rounded-sm bg-raised flex flex-col gap-[3px] p-[6px] box-border shrink-0">
        <span className="h-[3px] w-3/4 bg-line-3 rounded-[2px]" />
        <span className="h-[3px] w-full bg-line-5 rounded-[2px]" />
        <span className="h-[3px] w-2/3 bg-line-5 rounded-[2px]" />
      </span>
    );
  }
  return (
    <span aria-hidden="true" className="w-[50px] h-9 rounded-sm bg-raised flex gap-[3px] p-[5px] box-border shrink-0">
      <span className="w-[30%] bg-line-3 rounded-[2px]" />
      <span className="flex-1 bg-line-5 rounded-[2px]" />
    </span>
  );
}

// ---------- Agent tools ----------

function enabledFor(ext: InstalledExtension, projectId: string): boolean {
  if (ext.disabledProjects.includes(projectId)) return false;
  return ext.enabledGlobally || ext.enabledProjects.includes(projectId);
}

function AgentTools({ projectId }: { projectId: string }) {
  const [exts, setExts] = useState<InstalledExtension[]>([]);
  useEffect(() => {
    let cancelled = false;
    invokeOr('extensions.installed', undefined, [] as InstalledExtension[]).then(
      (l) => !cancelled && setExts(Array.isArray(l) ? l : []),
      () => {},
    );
    const off = oide.on('extensions.changed', (l) => setExts(l));
    return () => {
      cancelled = true;
      off();
    };
  }, []);
  const enabled = exts.filter((e) => enabledFor(e, projectId));
  return (
    <div className="px-4 py-3 border-t border-line flex flex-col gap-2">
      <span className="text-[11px] font-semibold tracking-[0.08em] uppercase text-ink-3">Agent tools</span>
      <div className="flex gap-1.5 flex-wrap">
        {enabled.map((e) => (
          <span key={e.id} className="px-2 py-[3px] rounded-sm bg-selected text-[12px] text-ink-2">
            {e.displayName}
          </span>
        ))}
        <button type="button" onClick={() => navigate('marketplace', {})} className="px-2 py-[3px] rounded-sm border border-dashed border-line-hover bg-transparent text-[12px] text-ink-2 hover:bg-raised">
          + Marketplace
        </button>
      </div>
    </div>
  );
}
