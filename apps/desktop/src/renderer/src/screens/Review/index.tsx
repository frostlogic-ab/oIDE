/**
 * Review changes (docs/wiki/raw/design/Review.dc.html), reached from Source control and the Wall
 * tiles with `{ agentId }`. Changed files with Viewed state, a custom unified diff with inline
 * comments (or Monaco's diff editor for Split), and the summary/decision panel.
 * Keys: J / K next / previous file, ] / [ next / previous hunk. Wiki: screen-review.md.
 */
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EmptyState, Spinner } from '@oide/ui';
import { HeaderSlot } from '../../components/frame/HeaderSlot';
import { keymap } from '../../lib/keymap';
import { useKeymapScope } from '../../lib/useKeymap';
import { useAgent } from '../../stores/agents';
import { projectName, useProjects } from '../../stores/projects';
import { navigate, useRouter } from '../../stores/router';
import { toast } from '../../stores/ui';
import { findWorktree, useGit, useGitData, useProjectGit } from '../SourceControl/gitStore';
import { MINUS } from '../SourceControl/model';
import { listName } from './diff';
import { SummaryPanel } from './SummaryPanel';
import { UnifiedDiff, type Composer, type UnifiedDiffHandle } from './UnifiedDiff';
import { useReview } from './useReview';

const SplitDiff = lazy(() => import('./SplitDiff'));

keymap.define('review.nextFile', ['J']);
keymap.define('review.prevFile', ['K']);
keymap.define('review.nextHunk', [']']);
keymap.define('review.prevHunk', ['[']);

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
  const diffRef = useRef<UnifiedDiffHandle>(null);
  const pendingLine = useRef<number | undefined>(undefined);

  const file = files[Math.min(selected, Math.max(0, files.length - 1))];
  const totals = useMemo(() => files.reduce((t, f) => ({ add: t.add + f.additions, del: t.del + f.deletions }), { add: 0, del: 0 }), [files]);
  const fileComments = useMemo(() => comments.filter((c) => c.path === file?.path), [comments, file?.path]);

  useEffect(() => {
    setSelected(0);
    setComposer(null);
  }, [agentId]);

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
    const line = pendingLine.current;
    pendingLine.current = undefined;
    requestAnimationFrame(() => diffRef.current?.scrollToLine(line));
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
        <main className="flex-1 flex">
          <EmptyState icon="source-control" title="This agent is gone" description="It may have been removed. Pick another worktree from Source control." className="flex-1" />
        </main>
      </>
    );
  }

  return (
    <>
      {breadcrumb}
      <aside aria-label="Changed files" className="flex-[0_0_260px] w-[260px] flex flex-col gap-0.5 px-2.5 py-3.5 bg-panel border-r border-line box-border min-h-0">
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
      </aside>

      <main className="flex-[999_1_560px] min-w-0 min-h-0 flex flex-col">
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
                  className="text-[12px] text-link no-underline hover:text-link-hover"
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
                onCancelComposer={() => setComposer(null)}
                onHunkInView={setHunk}
                onAddComment={async (body) => {
                  if (!composer) return;
                  try {
                    await review.addComment(composer.path, composer.line, body);
                    setComposer(null);
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
          !review.loading && <EmptyState icon="source-control" title="No changes yet" description="This worktree has no changes against its base." className="flex-1" />
        )}
      </main>

      <SummaryPanel
        agent={agent}
        worktree={worktree}
        comments={comments}
        prAvailable={git.prAvailable}
        prReason={git.prReason}
        onSendFeedback={review.sendFeedback}
        onJump={(path, line) => {
          const i = files.findIndex((f) => f.path === path);
          if (i < 0) return;
          setView('unified');
          if (i === selected) {
            if (line !== undefined) diffRef.current?.scrollToLine(line);
          } else {
            pendingLine.current = line;
            selectFile(i);
          }
        }}
      />
    </>
  );
}
