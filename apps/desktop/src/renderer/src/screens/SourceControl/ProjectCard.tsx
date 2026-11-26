import { useState } from 'react';
import { Button, Dialog, Icon, LinkButton, Menu, Spinner, buttonClass, cn, type MenuItem } from '@oide/ui';
import type { AgentSummary, OverlapWarning, Project, WorktreeInfo } from '@oide/protocol';
import { oide } from '../../lib/bridge';
import { navigate } from '../../stores/router';
import { CommitDialog } from './CommitDialog';
import { RevertDialog } from './RevertDialog';
import { reconcile, removeWorktree, revealFolder, runSync } from './actions';
import type { ProjectGit } from './gitStore';
import { MINUS, baseLabel, commitAuthor, displayPath, localChangesLabel, prView, statusView, syncView, timeAgo } from './model';

const SECTION_LABEL = 'text-[11px] font-semibold tracking-[0.08em] uppercase text-ink-3';

export interface ProjectCardProps {
  project: Project;
  git: ProjectGit;
  agents: Record<string, AgentSummary>;
  open: boolean;
  onToggle: () => void;
  logOpen: boolean;
  onToggleLog: () => void;
}

/** One project on Source control (canvas: a 12px-radius panel per repository). */
export function ProjectCard({ project, git, agents, open, onToggle, logOpen, onToggleLog }: ProjectCardProps) {
  const [commitOpen, setCommitOpen] = useState(false);
  const [revertOpen, setRevertOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const sync = git.sync ? syncView(git.sync) : undefined;
  const dirty = git.sync?.dirtyFiles ?? [];
  const branch = git.sync?.branch ?? 'main';
  const bodyId = `scm-${project.id}-body`;
  const logId = `scm-${project.id}-log`;
  const showPr = git.prAvailable !== false;

  const doSync = async () => {
    if (!sync) return;
    setBusy(true);
    await runSync(project.id, sync.action);
    setBusy(false);
  };

  return (
    <section aria-label={project.name} className="flex flex-col border border-line-2 rounded-xl bg-panel overflow-hidden shrink-0">
      <div className="flex items-center gap-2.5 px-3.5 py-3 flex-wrap">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={onToggle}
          className="flex items-center gap-2 border-0 bg-transparent text-ink p-0 text-[14px] font-semibold cursor-pointer"
        >
          <span aria-hidden="true" className="text-ink-3 text-[11px] w-2.5">
            {open ? '▾' : '▸'}
          </span>
          <Icon name="folder" size={16} className="text-ink-3" />
          {project.name}
        </button>
        <span className="font-mono text-[11.5px] text-ink-3 truncate min-w-0" title={project.path}>
          {displayPath(project.path)}
        </span>
        <div className="flex-1" />
        {git.loading && !git.loadedAt && <Spinner size={12} label={`Loading ${project.name}`} />}
        <span className="font-mono text-[11.5px] px-2 py-0.5 rounded-sm bg-selected text-ink-2">{branch}</span>
        {sync ? (
          <>
            <span className="text-[12px]" style={{ color: sync.color }}>
              {sync.label}
            </span>
            <Button variant="secondary" size={28} disabled={busy} onClick={() => void doSync()} aria-label={`${sync.action} ${project.name}`}>
              {busy ? `${sync.action === 'Fetch' ? 'Fetching' : sync.action === 'Pull' ? 'Pulling' : 'Pushing'}…` : sync.action}
            </Button>
          </>
        ) : (
          git.loadedAt && <span className="text-[12px] text-ink-3">{git.error ? 'Git status unavailable' : 'No sync state yet'}</span>
        )}
        <LinkButton
          href="#files"
          variant="secondary"
          size={28}
          aria-label={`Files in ${project.name}`}
          onClick={(e) => {
            e.preventDefault();
            navigate('files', { root: project.path });
          }}
        >
          Files
        </LinkButton>
      </div>

      {open && (
        <div id={bodyId} className="flex flex-col">
          {git.error && (
            <div role="alert" className="px-3.5 py-2.5 border-t border-line-6 text-[12px] text-bad">
              {git.error}
            </div>
          )}
          {dirty.length > 0 && (
            <div className="flex items-center gap-2.5 px-3.5 py-2.5 border-t border-line-6 flex-wrap">
              <span aria-hidden="true" className="w-2 h-2 rounded-full border-[1.5px] border-ink-2 box-border shrink-0" />
              <span className="flex-1 min-w-[220px]">
                <b className="font-semibold">Your changes on {branch}</b> <span className="text-ink-3 text-[12px]">· {localChangesLabel(dirty)}</span>
              </span>
              <Button variant="secondary" size={28} onClick={() => setRevertOpen(true)} aria-haspopup="dialog" aria-label={`Revert changes on ${branch} in ${project.name}`}>
                Revert…
              </Button>
              <Button variant="secondary" size={28} onClick={() => setCommitOpen(true)} aria-haspopup="dialog">
                Commit…
              </Button>
            </div>
          )}

          {/* Until the first load answers, say so instead of "0" / "No commits yet" (m2). */}
          <div className={`px-3.5 pt-2 pb-1 border-t border-line-6 ${SECTION_LABEL}`}>Agent worktrees{git.loadedAt ? ` · ${git.worktrees.length}` : ''}</div>
          {!git.loadedAt && <div className="px-3.5 py-2.5 border-t border-[#1A1E24] text-[12px] text-ink-3">Loading agent worktrees…</div>}
          {git.worktrees.length === 0 && git.loadedAt && (
            <div className="px-3.5 py-2.5 border-t border-[#1A1E24] text-[12px] text-ink-3">No agents are working in this project.</div>
          )}
          <ul className="list-none m-0 p-0 flex flex-col">
            {git.worktrees.map((w) => (
              <WorktreeRow key={w.path} w={w} agent={w.agentId ? agents[w.agentId] : undefined} agents={agents} overlaps={git.overlaps} showPr={showPr} />
            ))}
          </ul>

          <button
            type="button"
            onClick={onToggleLog}
            aria-expanded={logOpen}
            aria-controls={logId}
            className="flex items-center gap-1.5 px-3.5 py-[9px] border-0 border-t border-solid border-line-6 bg-transparent text-ink-3 text-[12px] text-left cursor-pointer hover:text-ink"
          >
            <span aria-hidden="true" className="text-[11px] w-2.5">
              {logOpen ? '▾' : '▸'}
            </span>
            Recent commits on {branch}
          </button>
          {logOpen && (
            <ol id={logId} className="list-none m-0 flex flex-col pt-0 pr-3.5 pb-2.5 pl-[30px]">
              {git.log.length === 0 && <li className="py-[5px] text-[12px] text-ink-3">{git.loadedAt ? 'No commits yet.' : 'Loading commits…'}</li>}
              {git.log.map((c) => (
                <li key={c.sha} className="flex items-center gap-2.5 py-[5px] text-[12px] text-ink-2 flex-wrap">
                  <span className="font-mono text-ink-3 text-[11px]">{c.sha.slice(0, 7)}</span>
                  <span className="flex-1 min-w-[200px]">{c.message}</span>
                  <span className="text-ink-3">
                    {commitAuthor(c)} · <time dateTime={new Date(c.ts).toISOString()}>{timeAgo(c.ts)}</time>
                  </span>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}

      <CommitDialog
        open={commitOpen}
        onClose={() => setCommitOpen(false)}
        projectId={project.id}
        projectName={project.name}
        branch={branch}
        files={dirty}
      />
      <RevertDialog
        open={revertOpen}
        onClose={() => setRevertOpen(false)}
        projectId={project.id}
        projectName={project.name}
        branch={branch}
        files={dirty}
      />
    </section>
  );
}

function WorktreeRow({
  w,
  agent,
  agents,
  overlaps,
  showPr,
}: {
  w: WorktreeInfo;
  agent: AgentSummary | undefined;
  agents: Record<string, AgentSummary>;
  overlaps: OverlapWarning[];
  showPr: boolean;
}) {
  const [confirm, setConfirm] = useState(false);
  const status = statusView(agent?.status, w.orphaned);
  const pr = prView(w.pr, agent?.status);
  const ready = agent?.status === 'ready-for-review';
  const name = agent?.title ?? w.branch;
  const diff = w.diff ?? agent?.diff;
  const overlap = w.agentId ? overlaps.find((o) => o.agentIds.includes(w.agentId!)) : undefined;
  const otherId = overlap?.agentIds.find((id) => id !== w.agentId);

  const items: MenuItem[] = [
    { id: 'open', label: 'Open folder', icon: 'folder', onSelect: () => void revealFolder(w.path), disabled: w.orphaned },
    {
      id: 'reconcile',
      label: overlap ? `Reconcile with ${(otherId && agents[otherId]?.title) ?? 'the other worktree'}` : 'Reconcile (no overlap)',
      icon: 'branch',
      disabled: !overlap,
      onSelect: () => overlap && void reconcile(overlap),
    },
    { id: 'remove', label: 'Remove worktree…', icon: 'trash', danger: true, onSelect: () => setConfirm(true) },
  ];

  return (
    // A fixed grid (one row at any width): the name column takes what is left and truncates;
    // the status, diff and PR columns narrow below 1280px instead of pushing Review onto a new line.
    <li
      className={cn(
        'grid items-center gap-x-3 max-[1279px]:gap-x-2.5 px-3.5 py-[9px] border-t border-[#1A1E24]',
        showPr
          ? 'grid-cols-[8px_minmax(0,1fr)_120px_130px_110px_auto] max-[1279px]:grid-cols-[8px_minmax(0,1fr)_100px_118px_84px_auto]'
          : 'grid-cols-[8px_minmax(0,1fr)_120px_130px_auto] max-[1279px]:grid-cols-[8px_minmax(0,1fr)_100px_118px_auto]',
      )}
    >
      <span aria-hidden="true" className="w-2 h-2 rounded-full shrink-0" style={{ background: status.color }} />
      <div className="min-w-0 flex flex-col gap-0.5">
        {agent ? (
          <a
            href={`#focus/${agent.id}`}
            className="text-ink no-underline font-medium hover:text-link-hover truncate"
            onClick={(e) => {
              e.preventDefault();
              navigate('focus', { agentId: agent.id });
            }}
          >
            {name}
          </a>
        ) : (
          <span className="text-ink font-medium truncate">{name}</span>
        )}
        <span className="font-mono text-[11px] text-ink-3 truncate" title={`${w.branch} · ${baseLabel(w)}`}>
          {w.branch} · {baseLabel(w)}
        </span>
      </div>
      <span className="text-[12px] truncate" style={{ color: status.color }} title={status.label}>
        {status.label}
      </span>
      <span className="font-mono text-[11.5px] text-ink-3 whitespace-nowrap overflow-hidden">
        {diff ? (
          <>
            {diff.files} {diff.files === 1 ? 'file' : 'files'}
            {(diff.additions > 0 || diff.deletions > 0) && ' · '}
            {diff.additions > 0 && <span className="text-ok">+{diff.additions}</span>}{' '}
            {diff.deletions > 0 && (
              <span className="text-bad">
                {MINUS}
                {diff.deletions}
              </span>
            )}
          </>
        ) : (
          'no changes'
        )}
      </span>
      {showPr && (
        <span className="text-[12px] truncate" style={{ color: pr.color }}>
          {w.pr?.url ? (
            <a href={w.pr.url} style={{ color: pr.color }} className="no-underline hover:underline" onClick={(e) => (e.preventDefault(), void openUrl(w.pr!.url!))}>
              {pr.label}
            </a>
          ) : (
            pr.label
          )}
        </span>
      )}
      <div className="flex gap-1.5 justify-self-end">
        {w.agentId ? (
          <LinkButton
            href={`#review/${w.agentId}`}
            variant="secondary"
            size={28}
            aria-label={`Review ${name}`}
            className={ready ? 'border-review! text-review! hover:bg-review-bg' : undefined}
            onClick={(e) => {
              e.preventDefault();
              navigate('review', { agentId: w.agentId! });
            }}
          >
            Review
          </LinkButton>
        ) : (
          <button type="button" disabled className={buttonClass('secondary', 28)}>
            Review
          </button>
        )}
        <Menu label={`More actions for ${name}`} trigger={<span aria-hidden="true">···</span>} items={items} align="end" />
      </div>
      <Dialog
        open={confirm}
        onClose={() => setConfirm(false)}
        title="Remove this worktree?"
        description={
          <>
            Deletes <span className="font-mono">{w.branch}</span>'s folder{agent ? ` and stops "${agent.title}"` : ''}. Commits that were not merged stay on the
            branch only until it is cleaned up.
          </>
        }
        footer={
          <>
            <Button variant="secondary" size={32} onClick={() => setConfirm(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              size={32}
              onClick={() => {
                setConfirm(false);
                void removeWorktree(w.projectId, w.orphaned ? undefined : w.agentId);
              }}
            >
              Remove worktree
            </Button>
          </>
        }
      />
    </li>
  );
}

async function openUrl(url: string) {
  try {
    await oide.invoke('shell.openExternal', { url });
  } catch {
    /* the toast from main covers it */
  }
}
