import { Fragment, useState } from 'react';
import { Button } from '@oide/ui';
import type { AgentSummary, OverlapWarning, Project } from '@oide/protocol';
import { freshnessText, useMergePrediction } from '../../stores/mergePrediction';
import { navigate } from '../../stores/router';
import { reconcile, runSync } from './actions';
import type { ProjectGit } from './gitStore';
import { ResizableAside } from '../../components/ResizableAside';
import { PANELS } from '../../lib/panels';

const SECTION_LABEL = 'text-[11px] font-semibold tracking-[0.08em] uppercase text-ink-3';

/** Right column of Source control: Ready to review, Heads-up (overlaps, unpushed commits). */
export function SidePanel({
  projects,
  git,
  agents,
}: {
  projects: Project[];
  git: Record<string, ProjectGit>;
  agents: AgentSummary[];
}) {
  const byId = Object.fromEntries(agents.map((a) => [a.id, a]));
  const names = Object.fromEntries(projects.map((p) => [p.id, p.name]));
  const ready = agents.filter((a) => a.status === 'ready-for-review');
  const overlaps = projects.flatMap((p) => git[p.id]?.overlaps ?? []);
  const unpushed = projects.filter((p) => (git[p.id]?.sync?.ahead ?? 0) > 0);

  return (
    <ResizableAside
      panel={PANELS.sourceControlSide}
      aria-label="Needs you"
      className="flex flex-col gap-3 px-4 py-[18px] bg-panel border-l border-line box-border overflow-auto"
    >
      <h2 className={`m-0 ${SECTION_LABEL}`}>Ready to review</h2>
      {ready.length === 0 && <span className="text-[12px] text-ink-3">Nothing is waiting for your review.</span>}
      {ready.map((a) => {
        const w = git[a.projectId]?.worktrees.find((x) => x.agentId === a.id);
        const files = w?.diff?.files ?? a.diff?.files;
        const failed = a.review?.checks.filter((c) => c.status === 'failed').length ?? 0;
        const checks = !a.review?.checks.length ? 'no checks reported' : failed ? `${failed} ${failed === 1 ? 'check' : 'checks'} failed` : 'checks passed';
        return (
          <a
            key={a.id}
            href={`#review/${a.id}`}
            onClick={(e) => {
              e.preventDefault();
              navigate('review', { agentId: a.id });
            }}
            className="flex flex-col gap-[3px] p-2.5 rounded-lg border border-review-line bg-review-bg no-underline text-ink hover:text-ink hover:border-review"
          >
            <span className="font-semibold">{a.title}</span>
            <span className="text-[11.5px] text-ink-3">
              {[names[a.projectId] ?? a.projectId, files !== undefined ? `${files} ${files === 1 ? 'file' : 'files'}` : undefined, checks].filter(Boolean).join(' · ')}
            </span>
            <ReadyFreshness agent={a} />
          </a>
        );
      })}

      {(overlaps.length > 0 || unpushed.length > 0) && <h2 className={`m-0 mt-1.5 ${SECTION_LABEL}`}>Heads-up</h2>}
      {overlaps.map((o) => (
        <OverlapCard key={`${o.projectId}:${o.agentIds.join('+')}`} o={o} projectName={names[o.projectId] ?? o.projectId} byId={byId} />
      ))}
      {unpushed.map((p) => {
        const n = git[p.id]?.sync?.ahead ?? 0;
        const branch = git[p.id]?.sync?.branch ?? 'main';
        return (
          <div key={p.id} className="flex flex-col gap-1.5 p-2.5 rounded-lg border border-line-2 text-[12.5px] leading-normal text-ink-2">
            <span className="font-semibold text-ink">
              {p.name} has {n} unpushed {n === 1 ? 'commit' : 'commits'}
            </span>
            <span>
              {n === 1 ? `Your commit on ${branch} isn't on the remote yet.` : `Your ${n} commits on ${branch} aren't on the remote yet.`}
            </span>
            <Button variant="secondary" size={28} className="self-start" onClick={() => void runSync(p.id, 'Push')} aria-label={`Push ${p.name}`}>
              Push
            </Button>
          </div>
        );
      })}

      <div className="flex-1" />
      <span className="text-[12px] text-ink-3 leading-normal">Project scope is shared: picking a project here also scopes the agent wall and Files.</span>
    </ResizableAside>
  );
}

/** "Up to date with main" / "Behind main by 2 commits, would conflict in 1 file", or "Resolving merge conflicts". */
function ReadyFreshness({ agent }: { agent: AgentSummary }) {
  const { prediction } = useMergePrediction(agent.id, agent.projectId, Boolean(agent.branch));
  if (agent.mergeConflict) return <span className="text-[11.5px] text-warn">Resolving merge conflicts</span>;
  const text = freshnessText(prediction);
  if (!text) return null;
  return <span className={`text-[11.5px] ${prediction?.status === 'conflicts' ? 'text-warn' : 'text-ink-3'}`}>{text}</span>;
}

function OverlapCard({ o, projectName, byId }: { o: OverlapWarning; projectName: string; byId: Record<string, AgentSummary> }) {
  const [state, setState] = useState<'idle' | 'busy' | 'done'>('idle');
  const [a, b] = o.agentIds.map((id) => byId[id]?.title ?? id);
  const first = o.files.slice(0, 2);
  const more = o.files.length - first.length;
  const outcome =
    o.conflicts === false
      ? 'git can merge them cleanly today, but check the result after the second merge.'
      : o.conflicts === true
        ? 'Merging the second one will need a fix: git finds a conflict.'
        : 'Merging the second one may need a fix.';
  return (
    <div className="flex flex-col gap-1.5 p-2.5 rounded-lg border border-warn-line bg-warn-bg text-[12.5px] leading-normal text-ink">
      <span className="text-warn font-semibold">Two worktrees change the same file{o.files.length > 1 ? 's' : ''}</span>
      <span>
        In <b>{projectName}</b>, {a} and {b} both edit{' '}
        {first.map((f, i) => (
          <Fragment key={f}>
            {i > 0 && ' and '}
            <span className="font-mono text-[11.5px]">{f}</span>
          </Fragment>
        ))}
        {more > 0 && ` and ${more} more`}. {outcome}
      </span>
      <Button
        variant="secondary"
        size={28}
        className="self-start border-warn-line!"
        disabled={state !== 'idle'}
        onClick={async () => {
          setState('busy');
          setState((await reconcile(o)) ? 'done' : 'idle');
        }}
      >
        {state === 'done' ? 'Reconcile agent started' : state === 'busy' ? 'Starting…' : 'Ask an agent to reconcile'}
      </Button>
    </div>
  );
}
