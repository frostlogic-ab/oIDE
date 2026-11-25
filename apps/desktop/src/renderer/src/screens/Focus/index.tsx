/**
 * Focus: one agent in depth (docs/wiki/raw/design/Focus.dc.html, docs/wiki/pages/screen-focus.md).
 *
 *   [Agents list 216] [Session: header · transcript · permission prompt · composer] [Inspector 300–340]
 *
 * The transcript is the agent's full event log (`agents.events`, paged backwards) plus the live
 * tail, virtualized. Selecting a subagent (route param `subagentId`) shows its own transcript:
 * events tagged with its Task tool_use id.
 */
import './focus.css';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AgentSummary, PermissionMode, SubagentInfo } from '@oide/protocol';
import { Button, EmptyState, contextFraction } from '@oide/ui';
import { ipcErrorMessage, oide } from '../../lib/bridge';
import { useKeymapScope, useShortcutLabel } from '../../lib/useKeymap';
import { INTERRUPTED_PERMISSION_NOTE, nextNeedsYou, stepAgent, useAgent, useAgentsInScope } from '../../stores/agents';
import { archiveAgent, deleteAgentPermanently, unarchiveAgent, useArchive } from '../../stores/archive';
import { useCli } from '../../stores/cli';
import { projectName as nameOf, useProjects } from '../../stores/projects';
import { useRouter } from '../../stores/router';
import { useScope } from '../../stores/scope';
import { useSetting } from '../../stores/settings';
import { toast } from '../../stores/ui';
import { AgentList } from './components/AgentList';
import { CompactDialog } from './components/CompactDialog';
import { Composer } from './components/Composer';
import { Inspector, type InspectorTab } from './components/Inspector';
import { PermissionPrompt } from './components/PermissionPrompt';
import type { RowContext, ViewRow } from './components/rows';
import { LeadHeader, SubagentHeader } from './components/SessionHeader';
import { Streaming } from './components/Streaming';
import { Transcript } from './components/Transcript';
import { DEFAULT_SLASH_COMMANDS, modeChoices, nextMode, sortAgentList, type ModeChoice } from './model/focus';
import { loadOlder, useFocusHistory, useTranscriptHistory } from './model/history';
import { buildRows, eventsFor, groupByParent, reportedSlashCommands } from './model/transcript';

const EMPTY_SUBS: Record<string, SubagentInfo> = {};

function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

export default function FocusScreen() {
  const route = useRouter((s) => s.route);
  const agentId = route.screen === 'focus' ? route.params.agentId : undefined;
  const subagentId = route.screen === 'focus' ? route.params.subagentId : undefined;
  const live = useAgent(agentId);
  // Not on the Wall: maybe archived (opens read-only, transcript from the database).
  const archived = useArchive((s) => (agentId && !live ? s.byId[agentId] : undefined));
  const [lookedUp, setLookedUp] = useState<string | null>(null);
  useEffect(() => {
    if (!agentId || live || archived) return;
    let cancelled = false;
    void useArchive
      .getState()
      .fetchOne(agentId)
      .finally(() => !cancelled && setLookedUp(agentId));
    return () => {
      cancelled = true;
    };
  }, [agentId, live, archived]);
  const agent = live ?? archived;
  // A subagent id the agent does not have (stale link, mistyped id) falls back to the lead view.
  const unknownSub = !!agent && !!subagentId && !agent.subagents.some((s) => s.id === subagentId);
  const scope = useScope((s) => s.scope);
  const inScope = useAgentsInScope(scope);
  const list = useMemo(() => {
    const sorted = sortAgentList(inScope);
    // The agent on screen stays listed even when it is outside the project scope.
    return agent && !sorted.some((a) => a.id === agent.id) ? [agent, ...sorted] : sorted;
  }, [inScope, agent]);
  const projects = useProjects((s) => s.list);
  const projectName = useCallback((id: string) => nameOf(projects, id), [projects]);
  const warnAt = useSetting((s) => s.agents.contextWarnAt, undefined);
  const dangerAt = useSetting((s) => s.agents.contextSuggestCompactAt, undefined);
  const allowBypass = useSetting((s) => s.claude.allowBypass, false);
  const hasAuto = useCli((s) => s.info?.features['mode:auto']);
  const { replace, navigate } = useRouter.getState();

  useEffect(() => {
    if (unknownSub && agentId) replace('focus', { agentId });
  }, [unknownSub, agentId, replace]);

  const labels = {
    next: useShortcutLabel('agent.next'),
    prev: useShortcutLabel('agent.prev'),
    needs: useShortcutLabel('agent.nextNeedsYou'),
    back: useShortcutLabel('view.back'),
    mode: useShortcutLabel('agent.cycleMode'),
  };

  const go = useCallback((a: AgentSummary | undefined) => a && replace('focus', { agentId: a.id }), [replace]);
  const selectSub = useCallback((id: string | undefined) => agentId && replace('focus', id ? { agentId, subagentId: id } : { agentId }), [agentId, replace]);

  const inWorktree = !!agent?.worktreePath;
  const autoOk = hasAuto !== false;
  const modes = useMemo(() => modeChoices({ allowBypass, inWorktree, hasAuto: autoOk }), [allowBypass, inWorktree, autoOk]);
  const agentKey = agent?.id;
  const currentMode = agent?.mode;
  const setMode = useCallback(
    (mode: PermissionMode) => {
      if (!agentKey) return;
      oide.invoke('agents.setMode', { agentId: agentKey, mode }).catch((err: unknown) => toast(ipcErrorMessage(err), 'error'));
    },
    [agentKey],
  );
  const cycleMode = useCallback(() => {
    if (currentMode) setMode(nextMode(currentMode, { allowBypass, inWorktree, hasAuto: autoOk }));
  }, [currentMode, setMode, allowBypass, inWorktree, autoOk]);

  useKeymapScope('focus', {
    'agent.next': () => go(stepAgent(list, agentId, 1)),
    'agent.prev': () => go(stepAgent(list, agentId, -1)),
    'agent.nextNeedsYou': () => go(nextNeedsYou(list, agentId)),
    'view.back': () => navigate('wall'),
    // Shift+Tab cycles the mode only when nothing has focus; otherwise it moves focus back as usual.
    // In the composer it is handled by the composer itself (as in the CLI).
    'agent.cycleMode': () => {
      const el = document.activeElement;
      if (el && el !== document.body) return false;
      cycleMode();
    },
  });

  if (agentId && !agent && lookedUp !== agentId) return null;
  if (!agentId || !agent) {
    return (
      <EmptyState
        icon="agents"
        title={agentId ? 'This agent is gone' : 'No agent selected'}
        description="Pick an agent on the wall to see it in depth."
        action={
          <Button variant="primary" size={32} onClick={() => navigate('wall')}>
            Back to wall
          </Button>
        }
        className="flex-1"
      />
    );
  }

  return (
    <FocusBody
      key={agent.id}
      agent={agent}
      subagentId={unknownSub ? undefined : subagentId}
      list={list}
      projectName={projectName}
      warnAt={warnAt}
      dangerAt={dangerAt}
      labels={labels}
      onSelectAgent={(id) => replace('focus', { agentId: id })}
      onSelectSub={selectSub}
      onBack={() => navigate('wall')}
      onCycleMode={cycleMode}
      modes={modes}
      onSetMode={setMode}
    />
  );
}

interface BodyProps {
  agent: AgentSummary;
  subagentId?: string;
  list: AgentSummary[];
  projectName(id: string): string;
  warnAt?: number;
  dangerAt?: number;
  labels: { next: string; prev: string; needs: string; back: string; mode: string };
  onSelectAgent(id: string): void;
  onSelectSub(id: string | undefined): void;
  onBack(): void;
  onCycleMode(): void;
  modes: readonly ModeChoice[];
  onSetMode(mode: PermissionMode): void;
}

function FocusBody({ agent, subagentId, list, projectName, warnAt, dangerAt, labels, onSelectAgent, onSelectSub, onBack, onCycleMode, modes, onSetMode }: BodyProps) {
  useTranscriptHistory(agent.id);
  const events = useFocusHistory((s) => s.events);
  const hasMore = useFocusHistory((s) => s.hasMore);
  const loading = useFocusHistory((s) => s.loading);
  const now = useNow();
  const [tab, setTab] = useState<InspectorTab>(agent.subagents.length ? 'subs' : 'plan');
  const [compactOpen, setCompactOpen] = useState(false);
  const [stopRequested, setStopRequested] = useState<ReadonlySet<string>>(new Set());

  const subs = useMemo(() => Object.fromEntries(agent.subagents.map((s) => [s.id, s])) as Record<string, SubagentInfo>, [agent.subagents]);
  const sub = subagentId ? subs[subagentId] : undefined;
  const subEvents = useMemo(() => groupByParent(events), [events]);
  const leadEvents = useMemo(() => eventsFor(events), [events]);
  const leadRows = useMemo(() => buildRows(leadEvents), [leadEvents]);
  const ownSubEvents = subagentId ? subEvents.get(subagentId) : undefined;
  const rows = useMemo<ViewRow[]>(() => {
    if (!subagentId) return leadRows;
    const inner = buildRows(ownSubEvents ?? []);
    return [
      { kind: 'sub-intro', key: `intro:${subagentId}`, seq: -1, v: 0, task: sub?.task ?? '' },
      ...inner,
      { kind: 'sub-outro', key: `outro:${subagentId}`, seq: Number.MAX_SAFE_INTEGER, v: sub?.status === 'done' ? 1 : 0, done: sub?.status === 'done', report: sub?.report },
    ];
  }, [subagentId, leadRows, ownSubEvents, sub?.task, sub?.status, sub?.report]);

  const commands = useMemo(() => reportedSlashCommands(leadEvents) ?? [...DEFAULT_SLASH_COMMANDS], [leadEvents]);
  const pending = agent.pendingPermission;

  const ctx = useMemo<RowContext>(
    () => ({
      agentId: agent.id,
      subagents: agent.subagents.length ? subs : EMPTY_SUBS,
      subEvents,
      pendingToolUseId: pending?.toolUseId,
      now,
      onOpenSubagent: (id) => onSelectSub(id),
      onOpenReview: () => useRouter.getState().navigate('review', { agentId: agent.id }),
    }),
    [agent.id, agent.subagents.length, subs, subEvents, pending?.toolUseId, now, onSelectSub],
  );

  // Polite announcement of new assistant text (not history loaded on open).
  const announceFrom = useRef<number | null>(null);
  const [announce, setAnnounce] = useState('');
  useEffect(() => {
    const last = [...leadRows].reverse().find((r) => r.kind === 'assistant');
    if (!last) return;
    if (announceFrom.current === null) {
      announceFrom.current = last.seq;
      return;
    }
    if (last.seq > announceFrom.current && last.kind === 'assistant') {
      announceFrom.current = last.seq;
      setAnnounce(last.text.length > 300 ? `${last.text.slice(0, 300)}…` : last.text);
    }
  }, [leadRows]);

  const doCompact = () => {
    setCompactOpen(false);
    oide.invoke('agents.compact', { agentId: agent.id }).then(
      () => toast(`Sent /compact to ${agent.title}. Compacting…`, 'info'),
      (err: unknown) => toast(ipcErrorMessage(err), 'error'),
    );
  };
  const act = (cmd: 'agents.pause' | 'agents.resume' | 'agents.stop') => oide.invoke(cmd, { agentId: agent.id }).catch((err: unknown) => toast(ipcErrorMessage(err), 'error'));
  const stopSub = (id: string) => {
    setStopRequested((s) => new Set([...s, id]));
    oide.invoke('agents.stopSubagent', { agentId: agent.id, subagentId: id }).then(
      () => toast(`${subs[id]?.name ?? 'The subagent'} stops at its next tool call and reports back to the lead agent.`, 'info'),
      (err: unknown) => {
        setStopRequested((s) => new Set([...s].filter((x) => x !== id)));
        toast(ipcErrorMessage(err), 'error');
      },
    );
  };

  const readOnly = Boolean(agent.archived);
  const pendingSub = pending?.subagentId ? subs[pending.subagentId] : undefined;
  const queued = agent.status === 'queued';
  const placeholder = sub ? `Message the lead agent about ${sub.name}` : 'Steer this agent, or type / for commands';
  const used = contextFraction(agent.contextUsed, agent.contextWindow);

  return (
    <>
      <AgentList
        agents={list}
        currentId={agent.id}
        subagentId={sub ? sub.id : undefined}
        projectName={projectName}
        warnAt={warnAt}
        dangerAt={dangerAt}
        onBack={onBack}
        onSelect={onSelectAgent}
        onSelectSubagent={onSelectSub}
        labels={labels}
      />
      {/* A size container: the header and the permission prompt adapt to the session width. */}
      <main className="@container flex-1 min-w-[360px] min-h-0 flex flex-col" aria-label={sub ? `Subagent ${sub.name}` : agent.title}>
        {sub ? (
          <SubagentHeader agent={agent} sub={sub} now={now} onLead={() => onSelectSub(undefined)} onStop={() => stopSub(sub.id)} stopRequested={stopRequested.has(sub.id)} />
        ) : (
          <LeadHeader
            agent={agent}
            project={projectName(agent.projectId)}
            now={now}
            warnAt={warnAt}
            dangerAt={dangerAt}
            modeShortcut={labels.mode}
            modes={modes}
            onSetMode={onSetMode}
            onCompact={() => setCompactOpen(true)}
            onRawTerminal={() => setTab('term')}
            onPause={() => act('agents.pause')}
            onResume={() => act('agents.resume')}
            onStop={() => act('agents.stop')}
            onArchive={() => void archiveAgent(agent.id, agent.title)}
            onUnarchive={() => void unarchiveAgent(agent.id, agent.title)}
            onDelete={() => void deleteAgentPermanently(agent.id).then((ok) => ok && onBack())}
          />
        )}
        <Transcript
          rows={rows}
          ctx={ctx}
          resetKey={`${agent.id}:${subagentId ?? ''}`}
          hasMore={!subagentId && hasMore}
          loading={!subagentId && loading}
          onLoadOlder={() => void loadOlder()}
          footer={<Streaming agentId={agent.id} parent={subagentId} />}
          label={sub ? `Transcript of subagent ${sub.name}` : 'Transcript'}
        />
        <div aria-live="polite" className="sr-only">
          {announce}
        </div>
        <div className="px-5 pb-4 pt-1">
          <div className="max-w-[860px] mx-auto flex flex-col gap-2.5">
            {pending && (
              <PermissionPrompt
                agentId={agent.id}
                request={pending}
                projectName={projectName(agent.projectId)}
                subagentName={pendingSub?.name}
                onViewSubagent={pendingSub ? () => onSelectSub(pendingSub.id) : undefined}
              />
            )}
            {!pending && agent.interruptedPermission && (
              <div role="note" aria-label="Unanswered permission prompt" className="flex flex-col gap-1 px-3.5 py-2.5 rounded-lg border border-warn-line bg-card text-[12.5px] leading-normal">
                <span className="text-warn">{INTERRUPTED_PERMISSION_NOTE}</span>
                <span className="text-ink-3">
                  It was asking to use <span className="font-mono text-ink-2">{agent.interruptedPermission.toolName}</span>
                  {agent.interruptedPermission.summary ? `: ${agent.interruptedPermission.summary}` : ''}. The agent was told no; tell it what to do next.
                </span>
              </div>
            )}
            {readOnly ? (
              <div role="note" className="flex items-center gap-3 px-3.5 py-2.5 rounded-lg border border-line bg-card text-[12.5px] text-ink-3">
                <span className="flex-1">
                  This agent is archived; its transcript is read-only.{agent.resumeBlocked ? ' Its worktree was deleted, so it cannot be resumed.' : ' Unarchive it to put it back on the Wall and resume it.'}
                </span>
              </div>
            ) : (
            <Composer
              agentId={agent.id}
              projectId={agent.projectId}
              placeholder={placeholder}
              commands={commands}
              subagentName={sub?.name}
              disabledReason={queued ? 'Queued: messages open once this agent gets a free slot' : undefined}
              onCompact={() => setCompactOpen(true)}
              onCycleMode={sub ? undefined : onCycleMode}
            />
            )}
          </div>
        </div>
      </main>
      <Inspector
        agent={agent}
        events={events}
        subEvents={subEvents}
        tab={tab}
        onTab={setTab}
        now={now}
        stopRequested={stopRequested}
        onOpenSubagent={(id) => onSelectSub(id)}
        onStopSubagent={stopSub}
      />
      <CompactDialog open={compactOpen} agentName={agent.title} used={used} warnAt={warnAt} dangerAt={dangerAt} onCancel={() => setCompactOpen(false)} onConfirm={doCompact} />
    </>
  );
}
