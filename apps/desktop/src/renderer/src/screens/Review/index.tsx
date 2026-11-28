/**
 * Review changes (docs/wiki/raw/design/Review.dc.html), reached from Source control and the Wall
 * tiles with `{ agentId }`. Changed files with Viewed state, a custom unified diff with inline
 * comments (or Monaco's diff editor for Split), and the summary/decision panel.
 * Keys: J / K next / previous file, ] / [ next / previous hunk. Wiki: screen-review.md.
 */
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ArchiveReason } from '@oide/protocol';
import { Button, EmptyState, Spinner } from '@oide/ui';
import { HeaderSlot } from '../../components/frame/HeaderSlot';
import { keymap } from '../../lib/keymap';
import { useKeymapScope } from '../../lib/useKeymap';
import { useAgent } from '../../stores/agents';
import { useArchive } from '../../stores/archive';
import { projectName, useProjects } from '../../stores/projects';
import { navigate, useRouter } from '../../stores/router';
import { toast } from '../../stores/ui';
import { findWorktree, useGit, useGitData, useProjectGit } from '../SourceControl/gitStore';
import { MINUS } from '../SourceControl/model';
import { listName } from './diff';
import { SummaryPanel } from './SummaryPanel';
import { draftKey, UnifiedDiff, type Composer, type UnifiedDiffHandle } from './UnifiedDiff';
import { useReview } from './useReview';
import { ResizableAside } from '../../components/ResizableAside';
import { PANELS } from '../../lib/panels';

const SplitDiff = lazy(() => import('./SplitDiff'));

keymap.define('review.nextFile', ['J']);
keymap.define('review.prevFile', ['K']);
keymap.define('review.nextHunk', [']']);
keymap.define('review.prevHunk', ['[']);

const ARCHIVED_AS: Record<ArchiveReason, string> = {
  merged: 'merged and archived',
  discarded: 'discarded and archived',
  completed: 'completed and archived',
  'archived-by-user': 'archived',
};

function Gone() {
  return <EmptyState icon="source-control" title="This agent is gone" description="It may have been removed. Pick another worktree from Source control." className="flex-1" />;
}

/**
 * The agent is not on the Wall. A merge (or a merged PR) archives it, so look it up in the archive
 * before claiming it is gone, and offer to open it read-only in Focus.
 */
function NotLive({ agentId }: { agentId: string }) {
  const archived = useArchive((s) => s.byId[agentId]);
  const [lookedUp, setLookedUp] = useState<string | null>(null);
  useEffect(() => {
    if (archived) return;
    let cancelled = false;
    void useArchive
      .getState()
      .fetchOne(agentId)
      .finally(() => !cancelled && setLookedUp(agentId));
    return () => {
      cancelled = true;
    };
  }, [agentId, archived]);
  if (archived?.archived) {
    return (
      <EmptyState
        icon="archive"
        title={`${archived.title} was ${ARCHIVED_AS[archived.archived.reason]}`}
        description="There is nothing left to review here. Its transcript stays available, read-only."
        className="flex-1"
        action={
          <Button icon="agents" onClick={() => navigate('focus', { agentId })}>
            Open in Focus
          </Button>
        }
      />
    );
  }
  if (lookedUp !== agentId) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Spinner label="Looking for this agent" />
      </div>
    );
  }
  return <Gone />;
}

export default function ReviewScreen() {
  const route = useRouter((s) => s.route);
  const agentId = route.screen === 'review' ? route.params.agentId : undefined;
  const agent = useAgent(agentId);
  const projects = useProjects((s) => s.list);
  useGitData(agent ? [agent.projectId] : []);
  const git = useProjectGit(agent?.projectId);
  const byProject = useGit((s) => s.byProject);
  const worktree = agentId ? findWorktree(byProject, agentId) : undefined;
  const root = worktree?.path ?? agent?.worktreePath;

  const review = useReview(agentId);
  const { files, comments, viewed } = review;
  const [selected, setSelected] = useState(0);
  const [view, setView] = useState<'unified' | 'split'>('unified');
  const [composer, setComposer] = useState<Composer | null>(null);
  const [hunk, setHunk] = useState(0);
  // Unsent comment text per location (path + side + line). Kept in a ref so typing doesn't re-render
  // the whole diff; `draftKeys` mirrors which locations hold text, for the line markers.
  const drafts = useRef(new Map<string, string>());
  const [draftKeys, setDraftKeys] = useState<ReadonlySet<string>>(() => new Set());
  const setDraft = useCallback((key: string, body: string) => {
    if (body.trim()) drafts.current.set(key, body);
    else drafts.current.delete(key);
    const has = drafts.current.has(key);
    setDraftKeys((prev) => {
      if (prev.has(key) === has) return prev;
      const next = new Set(prev);
      if (has) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);
  const getDraft = useCallback((key: string) => drafts.current.get(key) ?? '', []);
  const diffRef = useRef<UnifiedDiffHandle>(null);
  const pendingLine = useRef<{ line: number; side: 'old' | 'new' } | undefined>(undefined);

  const file = files[Math.min(selected, Math.max(0, files.length - 1))];
  const totals = useMemo(() => files.reduce((t, f) => ({ add: t.add + f.additions, del: t.del + f.deletions }), { add: 0, del: 0 }), [files]);
  const fileComments = useMemo(() => comments.filter((c) => c.path === file?.path), [comments, file?.path]);

  useEffect(() => {
    setSelected(0);
    setComposer(null);
    drafts.current.clear();
    setDraftKeys(new Set());
  }, [agentId]);

  // Open on the file the route names (Focus > Inspector rows), once per navigation: once this
  // route has been applied, the user's own picks and reloads never snap back to it, and a later
  // navigation without a path keeps whatever is selected. A path not in the diff is ignored.
  const routePath = route.screen === 'review' ? route.params.path : undefined;
  const appliedRoute = useRef<unknown>(null);
  useEffect(() => {
    if (!routePath || appliedRoute.current === route) return;
    if (review.loading || review.loadedFor !== agentId) return;
    appliedRoute.current = route;
    const i = files.findIndex((f) => f.path === routePath);
    if (i >= 0) {
      setSelected(i);
      setHunk(0);
      setComposer(null);
    }
  }, [route, routePath, agentId, files, review.loading, review.loadedFor]);

  const selectFile = useCallback(
    (i: number) => {
      if (!files.length) return;
      setSelected((i + files.length) % files.length);
      setHunk(0);
      setComposer(null);
    },
    [files.length],
  );

  // After switching file to jump to a comment, scroll to its line once the diff is rendered.
  useEffect(() => {
    if (pendingLine.current === undefined) return;
    const { line, side } = pendingLine.current;
    pendingLine.current = undefined;
    requestAnimationFrame(() => diffRef.current?.scrollToLine(line, side));
  }, [file?.path]);

  const hunkCount = file ? (file.patch.match(/^@@ /gm)?.length ?? 0) : 0;
  const stepHunk = (dir: 1 | -1) => {
    if (view !== 'unified' || !hunkCount) return;
    const next = hunk + dir;
    if (next < 0 || next >= hunkCount) {
      // past the last hunk: move to the next file (and its first hunk)
      if (dir === 1 && selected < files.length - 1) selectFile(selected + 1);
      return;
    }
    setHunk(next);
    diffRef.current?.scrollToHunk(next);
  };

  useKeymapScope('review', {
    'review.nextFile': () => selectFile(selected + 1),
    'review.prevFile': () => selectFile(selected - 1),
    'review.nextHunk': () => stepHunk(1),
    'review.prevHunk': () => stepHunk(-1),
  });

  const breadcrumb = (
    <HeaderSlot name="title">
      <nav aria-label="Breadcrumb" className="text-ink-3 text-[12.5px] flex gap-1.5 items-center whitespace-nowrap min-w-0">
        <a
          href="#source-control"
          className="text-link no-underline hover:text-link-hover"
          onClick={(e) => {
            e.preventDefault();
            navigate('source-control');
          }}
        >
          Source control
        </a>
        {agent && (
          <>
            <span aria-hidden="true">/</span>
            <span>{projectName(projects, agent.projectId)}</span>
          </>
        )}
        <span aria-hidden="true">/</span>
        <span className="text-ink truncate" aria-current="page">
          Review{agent ? `: ${agent.title}` : ''}
        </span>
      </nav>
    </HeaderSlot>
  );

  if (!agent) {
    return (
      <>
        {breadcrumb}
        <main className="flex-1 flex">{agentId ? <NotLive agentId={agentId} /> : <Gone />}</main>
      </>
    );
  }

  return (
    <>
      {breadcrumb}
      <ResizableAside panel={PANELS.reviewFiles} aria-label="Changed files" className="flex flex-col gap-0.5 px-2.5 py-3.5 bg-panel border-r border-line box-border min-h-0">
        <div className="flex items-center justify-between px-1.5 pb-2">
          <h2 className="m-0 text-[11px] font-semibold tracking-[0.08em] uppercase text-ink-3">
            {files.length} {files.length === 1 ? 'file' : 'files'} changed
          </h2>
          <span className="font-mono text-[11px]">
            <span className="text-ok">+{totals.add}</span>{' '}
            <span className="text-bad">
              {MINUS}
              {totals.del}
            </span>
          </span>
        </div>
        <ul className="list-none m-0 p-0 font-mono flex flex-col gap-px text-[11.5px] overflow-auto min-h-0" aria-label="Files">
          {review.loading && !files.length && (
            <li className="px-2 py-1.5">
              <Spinner size={12} label="Loading the diff" />
            </li>
          )}
          {review.error && <li className="px-2 py-1.5 font-sans text-[12px] text-bad">{review.error}</li>}
          {files.map((f, i) => {
            const current = f === file;
            const seen = viewed.has(f.path);
            return (
              <li key={f.path}>
                <button
                  type="button"
                  aria-current={current ? 'true' : undefined}
                  title={f.path}
                  onClick={() => selectFile(i)}
                  className={`w-full flex gap-2 items-center px-2 py-1.5 border-0 rounded-sm text-left font-mono text-[11.5px] cursor-pointer ${
                    current ? 'bg-selected text-ink' : `bg-transparent hover:bg-raised ${seen ? 'text-ink-3' : 'text-ink-2'}`
                  }`}
                >
                  {current ? (
                    <span aria-hidden="true" className="w-1.5 h-1.5 rounded-full bg-accent shrink-0" />
                  ) : seen ? (
                    <span className="w-1.5 shrink-0 flex justify-center text-ink-3">
                      <svg viewBox="0 0 24 24" width="10" height="10" className="ico" style={{ width: 10, height: 10 }} role="img" aria-label="Viewed">
                        <path d="M5 12l5 5 9-10" />
                      </svg>
                    </span>
                  ) : (
                    <span aria-hidden="true" className="w-1.5 h-1.5 shrink-0" />
                  )}
                  <span className="flex-1 truncate">{listName(f.path)}</span>
                  {f.additions > 0 && <span className="text-ok">+{f.additions}</span>}
                  {f.deletions > 0 && (
                    <span className="text-bad">
                      {MINUS}
                      {f.deletions}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
        <div className="flex-1" />
        <div role="group" aria-label="Diff view" className="flex gap-1 p-1 rounded-md bg-card mt-2">
          {(['unified', 'split'] as const).map((v) => (
            <button
              key={v}
              type="button"
              aria-pressed={view === v}
              onClick={() => setView(v)}
              className={`flex-1 h-7 border-0 rounded-sm text-[12px] cursor-pointer ${view === v ? 'bg-selected text-ink' : 'bg-transparent text-ink-3 hover:text-ink'}`}
            >
              {v === 'unified' ? 'Unified' : 'Split'}
            </button>
          ))}
        </div>
      </ResizableAside>

      <main className="flex-1 min-w-[360px] min-h-0 flex flex-col">
        {file ? (
          <>
            <div className="flex items-center gap-2.5 px-5 py-3 border-b border-line flex-wrap">
              <h2 className="m-0 font-mono font-normal text-[12.5px] flex-1 min-w-0 truncate">
                {file.status === 'renamed' && file.oldPath ? `${file.oldPath} → ` : ''}
                {file.path}
                {file.status === 'added' && <span className="sr-only"> (new file)</span>}
                {file.status === 'deleted' && <span className="sr-only"> (deleted)</span>}
              </h2>
              <label className="flex items-center gap-1.5 text-[12px] text-ink-2 cursor-pointer">
                <input type="checkbox" className="accent-accent" checked={viewed.has(file.path)} onChange={(e) => void review.toggleViewed(file.path, e.target.checked)} />
                Viewed
              </label>
              {root && file.status !== 'deleted' && (
                <a
                  href="#files"
                  className="text-[12px] text-link underline underline-offset-2 hover:text-link-hover"
                  onClick={(e) => {
                    e.preventDefault();
                    navigate('files', { root, path: file.path });
                  }}
                >
                  Open in editor
                </a>
              )}
            </div>
            {view === 'unified' ? (
              <UnifiedDiff
                ref={diffRef}
                file={file}
                comments={fileComments}
                composer={composer}
                onOpenComposer={setComposer}
                getDraft={getDraft}
                onDraftChange={setDraft}
                draftKeys={draftKeys}
                // Esc only closes the box: the typed comment stays as a draft, so a reflexive Esc loses nothing.
                onCloseComposer={() => setComposer(null)}
                onCancelComposer={() => {
                  // Cancel is an explicit discard.
                  if (composer) setDraft(draftKey(composer.path, composer.removed, composer.line), '');
                  setComposer(null);
                }}
                onHunkInView={setHunk}
                onAddComment={async (body) => {
                  if (!composer) return;
                  try {
                    await review.addComment(composer.path, composer.line, body, composer.removed ? 'old' : 'new');
                    const key = draftKey(composer.path, composer.removed, composer.line);
                    setDraft(key, '');
                    // The user may have opened another line while this was saving; leave that one open.
                    setComposer((c) => (c && draftKey(c.path, c.removed, c.line) === key ? null : c));
                  } catch (err) {
                    toast(`Couldn't add the comment: ${err instanceof Error ? err.message : String(err)}`, 'error');
                  }
                }}
                onDeleteComment={(id) => void review.deleteComment(id).catch(() => toast("Couldn't delete the comment", 'error'))}
              />
            ) : (
              <Suspense
                fallback={
                  <div className="flex-1 flex items-center justify-center">
                    <Spinner label="Loading the split view" />
                  </div>
                }
              >
                <SplitDiff file={file} root={root} />
              </Suspense>
            )}
          </>
        ) : (
          // The error state stays mounted while retrying, so focus stays on "Try again".
          (review.error ? (
            <EmptyState
              role="alert"
              icon="alert-circle"
              title="Couldn't load the changes"
              description={review.error}
              className="flex-1"
              action={
                <Button icon="refresh" aria-busy={review.loading} onClick={() => !review.loading && void review.reload()}>
                  {review.loading ? 'Trying again…' : 'Try again'}
                </Button>
              }
            />
          ) : (
            !review.loading && <EmptyState icon="source-control" title="No changes yet" description="This worktree has no changes against its base." className="flex-1" />
          ))
        )}
      </main>

      <SummaryPanel
        agent={agent}
        worktree={worktree}
        comments={comments}
        prAvailable={git.prAvailable}
        prReason={git.prReason}
        nothingToPush={!review.loading && !review.error && files.length === 0 && worktree !== undefined && worktree.ahead === 0 && !(agent.pr ?? worktree.pr)}
        onSendFeedback={review.sendFeedback}
        sensitiveFiles={files.flatMap((f) => (f.sensitive ? [{ path: f.path, reason: f.sensitive }] : []))}
        onJump={(path, line, side = 'new') => {
          const i = files.findIndex((f) => f.path === path);
          if (i < 0) return;
          setView('unified');
          if (i === selected) {
            if (line !== undefined) diffRef.current?.scrollToLine(line, side);
          } else {
            pendingLine.current = line !== undefined ? { line, side } : undefined;
            selectFile(i);
          }
        }}
      />
    </>
  );
}
