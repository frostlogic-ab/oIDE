/**
 * Source control (docs/wiki/raw/design/SourceControl.dc.html): one card per project in the shared
 * scope with sync state, your changes on main, agent worktrees and recent commits; the right column
 * lists work ready to review and heads-up warnings. Data: ./gitStore.ts. Wiki: screen-source-control.md.
 */
import { useMemo, useState } from 'react';
import { Button, EmptyState } from '@oide/ui';
import { agentsInScope, useAgents } from '../../stores/agents';
import { useProjects } from '../../stores/projects';
import { openNewProject } from '../../stores/newProject';
import { useScope } from '../../stores/scope';
import { useGit, useGitData } from './gitStore';
import { ProjectCard } from './ProjectCard';
import { SidePanel } from './SidePanel';

export default function SourceControlScreen() {
  const allProjects = useProjects((s) => s.list);
  const loaded = useProjects((s) => s.loaded);
  const scope = useScope((s) => s.scope);
  const byId = useAgents((s) => s.byId);
  const order = useAgents((s) => s.order);
  const git = useGit((s) => s.byProject);

  const projects = useMemo(() => allProjects.filter((p) => scope === 'all' || p.id === scope), [allProjects, scope]);
  const agents = useMemo(() => agentsInScope(byId, order, scope), [byId, order, scope]);
  useGitData(projects.map((p) => p.id));

  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const [logs, setLogs] = useState<Record<string, boolean>>({});

  const worktreeCount = projects.reduce((n, p) => n + (git[p.id]?.worktrees.length ?? 0), 0);
  const gitLoading = projects.some((p) => !git[p.id]?.loadedAt);
  const scoped = scope === 'all' ? undefined : projects[0];
  const title = scope === 'all' ? 'All projects' : (scoped?.name ?? scope);

  return (
    <>
      <main className="flex-1 min-w-[360px] px-6 py-5 box-border flex flex-col gap-3.5 overflow-auto">
        <div className="flex items-baseline gap-3 flex-wrap">
          <h1 className="m-0 text-[18px] font-semibold">{title}</h1>
          <span className="text-[12.5px] text-ink-3">
            {projects.length} {projects.length === 1 ? 'project' : 'projects'} ·{' '}
            {gitLoading && worktreeCount === 0 ? 'loading agent worktrees…' : `${worktreeCount} agent ${worktreeCount === 1 ? 'worktree' : 'worktrees'}`}
          </span>
        </div>
        <span className="text-[12.5px] text-ink-3 leading-normal -mt-1.5">
          Each project is its own git repository. Every agent works on its own branch in a worktree, so your main branch only changes when you merge.
        </span>

        {loaded && projects.length === 0 && (
          <EmptyState
            icon="source-control"
            title={allProjects.length ? 'This project is no longer open' : 'No projects open'}
            description="Open a git repository to see its branches, agent worktrees and recent commits."
            action={
              <Button variant="primary" size={32} icon="plus" onClick={() => openNewProject('open')}>
                New project
              </Button>
            }
            className="flex-1"
          />
        )}

        {projects.map((p, i) => (
          <ProjectCard
            key={p.id}
            project={p}
            git={git[p.id] ?? { worktrees: [], log: [], overlaps: [], loading: true }}
            agents={byId}
            open={!closed[p.id]}
            onToggle={() => setClosed({ ...closed, [p.id]: !closed[p.id] })}
            logOpen={logs[p.id] ?? i === 0}
            onToggleLog={() => setLogs({ ...logs, [p.id]: !(logs[p.id] ?? i === 0) })}
          />
        ))}
      </main>
      <SidePanel projects={projects} git={git} agents={agents} />
    </>
  );
}
