import { memo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { Project } from '@oide/protocol';
import { Icon, IconButton, SectionLabel, StatusDot, cn } from '@oide/ui';
import { ipcErrorMessage } from '../../../lib/bridge';
import { useAgents } from '../../../stores/agents';
import { useProjects } from '../../../stores/projects';
import { useScope } from '../../../stores/scope';
import { toast } from '../../../stores/ui';
import { useWall } from '../wallState';
import { tileDomId } from './AgentTile';

export async function openProject(): Promise<void> {
  try {
    await useProjects.getState().open();
  } catch (err) {
    toast(`Could not open the project: ${ipcErrorMessage(err)}`, 'error');
  }
}

/**
 * Projects + sessions tree (Main.dc.html left aside, 248px). "All projects" and each project
 * header are the shared project scope switcher (they scope the Wall, Files and Source control).
 * Clicking an agent selects its tile.
 */
export function ProjectSidebar() {
  const projects = useProjects((s) => s.list);
  const scope = useScope((s) => s.scope);
  const total = useAgents((s) => s.order.length);
  return (
    <aside aria-label="Projects" className="w-[248px] shrink-0 flex flex-col gap-1 px-2.5 py-3.5 bg-panel border-r border-line box-border overflow-y-auto">
      <div className="flex items-center justify-between px-1.5 pb-2">
        <SectionLabel as="h2">Projects</SectionLabel>
        <IconButton icon="plus" aria-label="Open project" onClick={() => void openProject()} />
      </div>

      <button
        type="button"
        aria-pressed={scope === 'all'}
        title="Scopes the wall, Files and Source control"
        onClick={() => void useScope.getState().setScope('all')}
        className={cn(
          'flex items-center gap-2 p-1.5 mb-1 border rounded-[7px] text-[13px] font-semibold text-left',
          scope === 'all' ? 'border-line-3 bg-selected text-ink' : 'border-transparent bg-transparent text-ink-2 hover:bg-raised',
        )}
      >
        <Icon name="projects" className="text-ink-3" />
        <span className="flex-1">All projects</span>
        <span className="text-ink-3 text-[12px] font-normal">{total}</span>
      </button>

      {projects.map((p, i) => (
        <ProjectGroup key={p.id} project={p} selected={scope === p.id} first={i === 0} />
      ))}

      <div className="flex-1" />
      <div className="flex flex-col gap-1.5 p-2.5 mt-3 border border-line-2 rounded-lg bg-card">
        <SectionLabel>Legend</SectionLabel>
        <LegendRow color="var(--color-ok)">Running</LegendRow>
        <LegendRow color="var(--color-warn)">Waiting on you</LegendRow>
        <LegendRow color="var(--color-review)">Ready for review</LegendRow>
        <span className="flex items-center gap-2 text-ink-2 mt-1">
          <span className="font-mono h-4 px-[5px] rounded-lg border border-line-4 text-[9.5px] text-ink-3 inline-flex items-center">S</span>
          Subagent, letter = model
        </span>
      </div>
    </aside>
  );
}

function LegendRow({ color, children }: { color: string; children: string }) {
  return (
    <span className="flex items-center gap-2 text-ink-2">
      <StatusDot color={color} size={7} />
      {children}
    </span>
  );
}

function ProjectGroup({ project, selected, first }: { project: Project; selected: boolean; first: boolean }) {
  const ids = useAgents(useShallow((s) => s.order.filter((id) => s.byId[id]?.projectId === project.id)));
  return (
    <div className={cn('flex flex-col gap-0.5', !first && 'mt-1.5')} role="group" aria-label={project.name}>
      <button
        type="button"
        aria-pressed={selected}
        title={`Show only ${project.name}`}
        onClick={() => void useScope.getState().setScope(selected ? 'all' : project.id)}
        className={cn(
          'flex items-center gap-2 p-1.5 rounded-sm border-0 font-semibold text-[13px] text-left',
          selected ? 'bg-selected text-ink' : 'bg-transparent text-ink hover:bg-raised',
        )}
      >
        <Icon name="folder" className="text-ink-3" />
        <span className="flex-1 truncate">{project.name}</span>
        <span className="text-ink-3 text-[12px] font-normal">{ids.length}</span>
      </button>
      {ids.map((id) => (
        <SidebarAgent key={id} agentId={id} />
      ))}
    </div>
  );
}

const SidebarAgent = memo(function SidebarAgent({ agentId }: { agentId: string }) {
  const title = useAgents((s) => s.byId[agentId]?.title ?? '');
  const status = useAgents((s) => s.byId[agentId]?.status);
  const focused = useWall((s) => s.focusedId === agentId);
  const select = () => {
    const el = document.getElementById(tileDomId(agentId));
    if (el) {
      el.focus();
      el.scrollIntoView?.({ block: 'nearest' });
    } else {
      // Hidden by the filter or the scope: show everything, then select it.
      useWall.getState().setFilter('all');
      void useScope.getState().setScope('all');
      useWall.getState().setFocused(agentId);
      requestAnimationFrame(() => document.getElementById(tileDomId(agentId))?.focus());
    }
  };
  return (
    <button
      type="button"
      onClick={select}
      aria-current={focused ? 'true' : undefined}
      className={cn(
        'flex items-center gap-2 py-[5px] pr-1.5 pl-8 rounded-sm border-0 text-left text-[13px]',
        focused ? 'bg-selected text-ink' : 'bg-transparent text-ink-2 hover:bg-raised',
      )}
    >
      {status && <StatusDot status={status} size={7} />}
      <span className="truncate">{title}</span>
    </button>
  );
});
