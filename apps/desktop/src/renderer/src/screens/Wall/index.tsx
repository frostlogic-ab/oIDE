/**
 * The Wall: Mission Control main screen (docs/wiki/raw/design/Main.dc.html).
 * Page: docs/wiki/pages/screen-wall.md.
 *
 * Projects sidebar (scope switcher) · Active / Archived (N) · filter chips · one tile per agent ·
 * Artifacts / Marketplace teasers. Archived shows finished, merged and discarded agents as a list. Keys: J / K move between tiles, N jumps to the next tile that needs you, Enter opens
 * Focus, Y / D answer the focused tile's permission prompt, Esc clears the selection.
 *
 * Re-render budget: this component subscribes to the visible id list and the counts (both
 * shallow-compared), so an activity line on one agent re-renders only that agent's tile.
 */
import { useEffect, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { AgentSummary } from '@oide/protocol';
import { Button, EmptyState, FilterChip, Kbd, SegmentedControl, TextField, buttonClass, cn } from '@oide/ui';
import { useKeymapScope, useShortcutLabel } from '../../lib/useKeymap';
import { nextNeedsYou, stepAgent, useAgents } from '../../stores/agents';
import { useArchive } from '../../stores/archive';
import { projectName, useProjects } from '../../stores/projects';
import { navigate } from '../../stores/router';
import { useScope } from '../../stores/scope';
import { toast } from '../../stores/ui';
import { answerPermission } from './actions';
import { AgentTile, tileDomId } from './components/AgentTile';
import { ArchivedList } from './components/ArchivedList';
import { ArtifactsAside } from './components/ArtifactsAside';
import { CompactDialog } from './components/CompactDialog';
import { ProjectSidebar, openProject } from './components/ProjectSidebar';
import { openNewProject } from '../../stores/newProject';
import { filterCounts, matchesFilter } from './logic';
import { useWall, type WallFilter, type WallView } from './wallState';

const FILTERS: Array<{ id: WallFilter; label: string; tone?: 'warn' }> = [
  { id: 'all', label: 'All' },
  { id: 'needs', label: 'Needs you', tone: 'warn' },
  { id: 'running', label: 'Running' },
  { id: 'review', label: 'Review' },
];

/** Move DOM focus (and the selection) to a tile. */
export function focusTile(agentId: string): void {
  useWall.getState().setFocused(agentId);
  const el = document.getElementById(tileDomId(agentId));
  if (el) {
    el.focus({ preventScroll: true });
    el.scrollIntoView?.({ block: 'nearest' });
  }
}

/** Visible agents in display order (scope + filter), read at call time for key handlers. */
function visibleAgents(): AgentSummary[] {
  const { byId, order } = useAgents.getState();
  const scope = useScope.getState().scope;
  const filter = useWall.getState().filter;
  const out: AgentSummary[] = [];
  for (const id of order) {
    const a = byId[id];
    if (a && (scope === 'all' || a.projectId === scope) && matchesFilter(a, filter)) out.push(a);
  }
  return out;
}

/** N: the next agent that needs you, after the focused one. Widens the filter if it hides them. */
export function jumpToNextNeedsYou(): boolean {
  const focused = useWall.getState().focusedId ?? undefined;
  let next = nextNeedsYou(visibleAgents(), focused);
  if (!next && useWall.getState().filter !== 'all') {
    useWall.getState().setFilter('all');
    next = nextNeedsYou(visibleAgents(), focused);
  }
  if (!next) {
    toast('No agent needs you right now');
    return false;
  }
  const id = next.id;
  requestAnimationFrame(() => focusTile(id));
  useWall.getState().setFocused(id);
  return true;
}

export default function WallScreen() {
  const scope = useScope((s) => s.scope);
  const filter = useWall((s) => s.filter);
  const view = useWall((s) => s.view);
  const archiveQuery = useWall((s) => s.archiveQuery);
  const archivedCount = useArchive((s) => (s.countScope === scope ? s.count : undefined));
  const loadError = useAgents((s) => s.loadError);
  const agentsLoading = useAgents((s) => s.loading);
  const projects = useProjects((s) => s.list);
  const projectsLoaded = useProjects((s) => s.loaded);
  const ids = useAgents(
    useShallow((s) =>
      s.order.filter((id) => {
        const a = s.byId[id];
        return !!a && (scope === 'all' || a.projectId === scope) && matchesFilter(a, filter);
      }),
    ),
  );
  const counts = useAgents(
    useShallow((s) => filterCounts(s.order.map((id) => s.byId[id]!).filter((a) => a && (scope === 'all' || a.projectId === scope)))),
  );
  const firstHighlighted = useWall((s) => Object.keys(s.highlighted)[0]);
  const nKey = useShortcutLabel('agent.nextNeedsYou');

  useEffect(() => {
    if (firstHighlighted) requestAnimationFrame(() => focusTile(firstHighlighted));
  }, [firstHighlighted]);

  // The "Archived (N)" count for this scope.
  useEffect(() => {
    void useArchive.getState().refreshCount(scope);
  }, [scope]);

  // Push the scope after the first commit: child effects run before App's, and the newest scope
  // wins, so pushing on mount would let App's global N (open Focus) shadow the Wall's N.
  const [keysReady, setKeysReady] = useState(false);
  useEffect(() => setKeysReady(true), []);

  useKeymapScope('wall', {
    'agent.next': () => {
      const a = stepAgent(visibleAgents(), useWall.getState().focusedId ?? undefined, 1);
      if (a) focusTile(a.id);
    },
    'agent.prev': () => {
      const a = stepAgent(visibleAgents(), useWall.getState().focusedId ?? undefined, -1);
      if (a) focusTile(a.id);
    },
    'agent.nextNeedsYou': () => {
      jumpToNextNeedsYou();
    },
    'permission.allow': () => answerFocused('allow'),
    'permission.deny': () => answerFocused('deny'),
    'view.back': () => {
      if (!useWall.getState().focusedId) return false;
      useWall.getState().setFocused(null);
      const active = document.activeElement as HTMLElement | null;
      if (active?.closest('[data-agent-id]')) active.blur();
    },
  }, { enabled: keysReady && view === 'active' });

  const title = scope === 'all' ? 'All agents' : projectName(projects, scope);
  const noProjects = projectsLoaded && projects.length === 0;
  const archived = view === 'archived';
  const viewOptions: Array<{ value: WallView; label: string }> = [
    { value: 'active', label: 'Active' },
    { value: 'archived', label: archivedCount === undefined ? 'Archived' : `Archived (${archivedCount})` },
  ];

  return (
    <>
      <ProjectSidebar />
      <main className="flex-1 min-w-[360px] overflow-y-auto flex flex-col gap-3.5 px-5 py-[18px] box-border" aria-label="Agents">
        {/* One row down to the 1100px window minimum: "Next that needs you" shortens to "Next". */}
        <div className="flex items-center gap-3 flex-nowrap min-w-0 min-h-8">
          <h1 className="m-0 min-w-0 truncate text-[18px] font-semibold tracking-[-0.01em]">{title}</h1>
          {!noProjects && <SegmentedControl label="Show agents" options={viewOptions} value={view} onChange={(v) => useWall.getState().setView(v)} size={28} className="shrink-0" />}
          {archived && (
            <TextField
              label="Search archived agents"
              hideLabel
              type="search"
              size={28}
              placeholder="Search by title"
              value={archiveQuery}
              onChange={(e) => useWall.getState().setArchiveQuery(e.target.value)}
              containerClassName="w-[240px] shrink min-w-[140px]"
              autoComplete="off"
            />
          )}
          <div role="group" aria-label="Filter" className={cn('flex gap-1.5 flex-wrap shrink-0', (counts.all === 0 || archived) && 'hidden')}>
            {FILTERS.map((f) => (
              <FilterChip key={f.id} selected={filter === f.id} tone={f.tone} onClick={() => useWall.getState().setFilter(f.id)}>
                {f.label} · {counts[f.id]}
              </FilterChip>
            ))}
          </div>
          <div className="flex-1" />
          <button
            type="button"
            className={buttonClass('warn-outline', 32, cn('text-warn! gap-2! shrink-0', (counts.all === 0 || archived) && 'hidden!'))}
            onClick={() => jumpToNextNeedsYou()}
            aria-keyshortcuts={nKey}
            aria-label="Next that needs you"
            title="Next that needs you"
          >
            <span aria-hidden="true">
              Next<span className="hidden min-[1280px]:inline"> that needs you</span>
            </span>
            <Kbd tone="warn">{nKey}</Kbd>
          </button>
          {/* Spawn needs a project: with none open, the empty state offers the New project options instead. */}
          {!noProjects && (
            <Button variant="primary" size={32} icon="plus" className="text-[13px]! px-3.5! rounded-md! shrink-0" onClick={() => navigate('spawn', scope === 'all' ? {} : { projectId: scope })}>
              Spawn agent
            </Button>
          )}
        </div>

        {/* A failed agents.list never looks like an empty Wall (it retries with backoff in stores/agents). */}
        {loadError && !archived && (
          <div role="alert" className="flex items-center gap-3 px-3.5 py-2.5 rounded-lg border border-bad-line bg-bad-bg text-[12.5px] text-ink-2">
            <span className="flex-1 min-w-0">
              <span className="text-bad font-semibold">Couldn't load your agents from oIDE.</span> They keep running in the background. {loadError}
              {agentsLoading ? ' Retrying…' : ''}
            </span>
            <Button disabled={agentsLoading} onClick={() => void useAgents.getState().load()}>
              Retry
            </Button>
          </div>
        )}

        {archived ? (
          <ArchivedList scope={scope} />
        ) : noProjects && counts.all === 0 ? (
          <EmptyState
            icon="folder"
            title="Start a project"
            description="A project is a git repository. Open one you have, clone one, or create a new one. Every agent you spawn in it gets its own worktree and branch, so agents never edit the same files on disk."
            className="flex-1"
            action={
              <div className="flex gap-2 flex-wrap justify-center">
                <Button variant="primary" size={32} icon="folder" onClick={() => openNewProject('open')}>
                  Open folder
                </Button>
                <Button size={32} icon="branch" onClick={() => openNewProject('clone')}>
                  Clone repository
                </Button>
                <Button size={32} icon="plus" onClick={() => openNewProject('create')}>
                  New repository
                </Button>
              </div>
            }
          />
        ) : counts.all === 0 && loadError ? null : counts.all === 0 ? (
          <EmptyState
            icon="agents"
            title="No agents yet"
            description="Spawn an agent with a goal. Each agent is your own claude CLI, running in its own git worktree."
            className="flex-1"
            action={
              <div className="flex gap-2">
                <Button variant="primary" size={32} icon="plus" onClick={() => navigate('spawn', scope === 'all' ? {} : { projectId: scope })}>
                  Spawn agent
                </Button>
                <Button size={32} onClick={openProject}>
                  New project
                </Button>
              </div>
            }
          />
        ) : ids.length === 0 ? (
          <div className="flex items-center gap-3 text-[12.5px] text-ink-3 py-6">
            No agents match this filter.
            <Button onClick={() => useWall.getState().setFilter('all')}>Show all</Button>
          </div>
        ) : (
          <div className={cn('grid gap-3 grid-cols-[repeat(auto-fill,minmax(300px,1fr))] content-start')}>
            {ids.map((id) => (
              <TileSlot key={id} agentId={id} />
            ))}
          </div>
        )}
      </main>
      <ArtifactsAside />
      <CompactDialog />
    </>
  );
}

/** Resolves the project name for a tile without making the grid depend on every agent. */
function TileSlot({ agentId }: { agentId: string }) {
  const projectId = useAgents((s) => s.byId[agentId]?.projectId);
  const name = useProjects((s) => projectName(s.list, projectId));
  return <AgentTile agentId={agentId} projectName={name} />;
}

function answerFocused(choice: 'allow' | 'deny'): boolean | void {
  const id = useWall.getState().focusedId;
  const agent = id ? useAgents.getState().byId[id] : undefined;
  const req = agent?.status === 'needs-permission' ? agent.pendingPermission : undefined;
  if (!agent || !req) return false;
  void answerPermission(agent.id, req.requestId, choice);
}
