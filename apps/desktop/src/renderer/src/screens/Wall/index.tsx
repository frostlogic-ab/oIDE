/**
 * PLACEHOLDER: the Mission Control wall (docs/wiki/raw/design/Main.dc.html) is implemented in
 * wave 2. This stand-in lists agents from the store with the shared components so the frame,
 * stores and mock bridge can be checked end to end.
 */
import type { AgentSummary } from '@oide/protocol';
import { Badge, Card, ContextRingButton, DiffStat, EmptyState, LinkButton, ModelLetterChip, StatusLabel, agentStatusMeta, contextFraction, modelFamily } from '@oide/ui';
import { formatDuration } from '../../lib/format';
import { useAgentsInScope } from '../../stores/agents';
import { projectName, useProjects } from '../../stores/projects';
import { navigate } from '../../stores/router';
import { useScope } from '../../stores/scope';
import { useSetting } from '../../stores/settings';

export default function WallScreen() {
  const scope = useScope((s) => s.scope);
  const agents = useAgentsInScope(scope);
  const projects = useProjects((s) => s.list);


  return (
    <main className="flex-1 min-w-0 overflow-auto flex flex-col gap-3.5 px-5 py-[18px]">
      <div className="flex items-center gap-3 flex-wrap">
        <h1 className="m-0 text-[18px] font-semibold tracking-[-0.01em]">
          {scope === 'all' ? 'All agents' : projectName(projects, scope)}
        </h1>
        <Badge tone="warn">Placeholder wall</Badge>
        <div className="flex-1" />
        <LinkButton
          href="#spawn"
          variant="primary"
          size={32}
          icon="plus"
          onClick={(e) => {
            e.preventDefault();
            navigate('spawn', {});
          }}
        >
          Spawn agent
        </LinkButton>
      </div>
      {agents.length === 0 ? (
        <EmptyState
          icon="agents"
          title="No agents yet"
          description="Open a project and spawn an agent. Each agent is your own claude CLI, in its own git worktree."
          className="flex-1"
        />
      ) : (
        <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(300px,1fr))]">
          {agents.map((a) => (
            <PlaceholderTile key={a.id} agent={a} project={projectName(projects, a.projectId)} />
          ))}
        </div>
      )}
    </main>
  );
}

function PlaceholderTile({ agent, project }: { agent: AgentSummary; project: string }) {
  const warnAt = useSetting((s) => s.agents.contextWarnAt, undefined);
  const dangerAt = useSetting((s) => s.agents.contextSuggestCompactAt, undefined);
  const meta = agentStatusMeta(agent.status);
  const branch = agent.branch?.split('/').pop() ?? agent.id;
  return (
    <Card as="article" tone={meta.tone} className="flex flex-col">
      <div className="flex items-center gap-2 px-3 pt-2.5">
        <span className="font-mono text-[11px] text-ink-3 truncate">
          {project} · {branch}
        </span>
        <div className="flex-1" />
        <StatusLabel status={agent.status} detail={agent.status === 'running' ? formatDuration(Date.now() - agent.createdAt) : undefined} />
        <ContextRingButton used={contextFraction(agent.contextUsed, agent.contextWindow)} subject={agent.title} warnAt={warnAt} dangerAt={dangerAt} />
      </div>
      <h2 className="mx-3 mt-1 mb-2 text-[14px] font-semibold">{agent.title}</h2>
      <div className="mx-3 px-2.5 py-2 bg-chrome rounded-md font-mono text-[11.5px] leading-[1.6] text-ink-code h-[92px] overflow-hidden">
        {agent.lastMessage ? <div className="font-sans text-[12px] text-ink-2">{agent.lastMessage}</div> : agent.activity.map((l, i) => <div key={i}>{l}</div>)}
      </div>
      <div className="flex items-center gap-[5px] px-3 pt-2 flex-wrap" role="group" aria-label={`Subagents of ${agent.title}`}>
        {agent.subagents.length === 0 ? (
          <span className="text-[11px] text-ink-4">No subagents</span>
        ) : (
          agent.subagents.map((s) => (
            <ModelLetterChip
              key={s.id}
              name={s.name}
              model={s.model}
              status={s.status}
              detailText={`${modelFamily(s.model)}${s.effort ? `, ${s.effort} effort` : ''}${s.tier ? ` · routed as ${s.tier}` : ''} · ${s.status.replace('-', ' ')}`}
              onClick={() => navigate('focus', { agentId: agent.id, subagentId: s.id })}
            />
          ))
        )}
      </div>
      <div className="flex items-center gap-2.5 px-3 py-2.5 mt-auto text-ink-3 text-[12px]">
        {agent.diff ? <DiffStat files={agent.diff.files} additions={agent.diff.additions} deletions={agent.diff.deletions} /> : <span />}
        <div className="flex-1" />
        <LinkButton
          href={`#focus/${agent.id}`}
          onClick={(e) => {
            e.preventDefault();
            navigate('focus', { agentId: agent.id });
          }}
        >
          Open
        </LinkButton>
      </div>
    </Card>
  );
}
