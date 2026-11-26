import { useEffect, useRef, useState } from 'react';
import { Button, Icon, agentStatusMeta } from '@oide/ui';
import type { AgentSummary, CheckResult, ReviewComment, WorktreeInfo } from '@oide/protocol';
import { ipcErrorMessage, oide } from '../../lib/bridge';
import { targetName, useMergePrediction, useMergePredictions } from '../../stores/mergePrediction';
import { navigate, useRouter } from '../../stores/router';
import { toast } from '../../stores/ui';
import { hasPendingForPr, useGit } from '../SourceControl/gitStore';
import { shortBranch } from '../SourceControl/model';
import { baseName } from './diff';
import { DeployActions } from '../../extensions/DeployActions';
import { ResizableAside } from '../../components/ResizableAside';
import { PANELS } from '../../lib/panels';
import { MergeDialog, MergeStatus, SensitiveWarning } from './MergeDialog';
import { archiveAgent } from '../../stores/archive';
import { canArchive } from '../Wall/logic';
import { pushToPullRequest } from '../Wall/actions';

const SECTION_LABEL = 'text-[11px] font-semibold tracking-[0.08em] uppercase text-ink-3';

export interface SummaryPanelProps {
  agent: AgentSummary;
  worktree?: WorktreeInfo;
  comments: ReviewComment[];
  prAvailable?: boolean;
  prReason?: string;
  onSendFeedback(): Promise<void>;
  onJump(path: string, line?: number, side?: 'old' | 'new'): void;
  /** Changed files that configure agents, git or MCP (FileDiff.sensitive), shown before Merge. */
  sensitiveFiles?: Array<{ path: string; reason: string }>;
  /**
   * The worktree has no changes and no commits against its base, and no pull request: there is
   * nothing to push or merge, so the panel offers Archive instead of Open pull request / Merge.
   */
  nothingToPush?: boolean;
}

/** Right column of Review: status, title, worktree → base, agent's summary and checks, feedback, decisions. */
export function SummaryPanel({ agent, worktree, comments, prAvailable, prReason, onSendFeedback, onJump, sensitiveFiles = [], nothingToPush = false }: SummaryPanelProps) {
  const meta = agentStatusMeta(agent.status);
  const branch = worktree?.branch ?? agent.branch ?? '';
  const base = (worktree?.baseRef ?? agent.baseRef ?? 'main').replace(/^origin\//, '');
  const pending = comments.filter((c) => !c.sent);
  const [sendState, setSendState] = useState<'idle' | 'busy' | 'sent'>('idle');
  // New comments after a send are not delivered yet: leave the 'sent' state when the pending count grows.
  const prevPending = useRef(pending.length);
  useEffect(() => {
    if (pending.length > prevPending.current) setSendState((s) => (s === 'sent' ? 'idle' : s));
    prevPending.current = pending.length;
  }, [pending.length]);
  const [prBusy, setPrBusy] = useState(false);
  const [archiveBusy, setArchiveBusy] = useState(false);
  const [merge, setMerge] = useState<{ step: 'confirm' | 'busy' | 'conflicts' | 'asking'; conflicts: string[]; from?: 'prediction' | 'merge' } | null>(null);
  // The agent's own PR info (kept fresh by main's PR watcher) wins over Source control's cached lookup.
  const pr = agent.pr ?? worktree?.pr;
  // An open (or draft) PR with a number: follow-up work can be pushed to it.
  const openPrInfo = pr?.url && pr.number && (pr.state === 'open' || pr.state === 'draft') ? { url: pr.url, number: pr.number } : undefined;
  // Would Merge conflict? Predicted with git merge-tree (main caches it per pair of commits).
  const forecast = useMergePrediction(agent.id, agent.projectId, Boolean(branch));
  const prediction = forecast.prediction;
  const target = targetName(prediction, base);
  const who = agent.title.length > 28 ? `${agent.title.slice(0, 27)}…` : agent.title;

  const openMerge = () => {
    setMerge({ step: 'confirm', conflicts: [] });
    // Fresh, with the main checkout's uncommitted files, every time the dialog opens.
    void useMergePredictions.getState().load(agent.id, { refresh: true, withMainStatus: true });
  };

  const askToResolve = async (from: 'prediction' | 'merge') => {
    const back = merge;
    setMerge({ step: 'asking', conflicts: merge?.conflicts ?? [], from });
    try {
      const r = await oide.invoke('git.askToResolve', { agentId: agent.id, source: from });
      setMerge(null);
      const when = r.status === 'queued' ? ' It is queued until a slot is free (Settings › Agents › Max running).' : '';
      toast(`Sent the conflicts to ${agent.title}. Merge again once it submits for review.${when}`, 'success');
      void useMergePredictions.getState().load(agent.id, { refresh: true });
    } catch (err) {
      setMerge(back);
      toast(`Couldn't send the conflicts: ${ipcErrorMessage(err)}`, 'error');
    }
  };

  const send = async () => {
    setSendState('busy');
    try {
      await onSendFeedback();
      setSendState('sent');
    } catch (err) {
      setSendState('idle');
      toast(`Couldn't send the feedback: ${ipcErrorMessage(err)}`, 'error');
    }
  };

  const openPr = async () => {
    if (pr?.url) {
      void oide.invoke('shell.openExternal', { url: pr.url }).catch(() => {});
      return;
    }
    setPrBusy(true);
    try {
      // Main writes the title and body: the agent's draft, else the project's PR template and title rules.
      const { url } = await oide.invoke('git.openPr', { agentId: agent.id });
      toast('Pull request opened', 'success', { action: { label: 'View', run: () => void oide.invoke('shell.openExternal', { url }).catch(() => {}) } });
      void oide.invoke('shell.openExternal', { url }).catch(() => {});
      void useGit.getState().load(agent.projectId);
    } catch (err) {
      toast(`Couldn't open a pull request: ${ipcErrorMessage(err)}`, 'error');
    } finally {
      setPrBusy(false);
    }
  };

  const archive = async () => {
    setArchiveBusy(true);
    const ok = await archiveAgent(agent.id, agent.title);
    setArchiveBusy(false);
    // Archived agents leave the Wall (and this screen); go back to it.
    if (ok) navigate('wall');
  };

  const doMerge = async () => {
    setMerge({ step: 'busy', conflicts: [] });
    try {
      const res = await oide.invoke('git.mergeLocal', { agentId: agent.id });
      if (res.ok) {
        setMerge(null);
        const stash = res.autoStash;
        toast(`Merged ${branch} into ${target}.${stash ? ` ${stash.note}` : ''}`, stash && !stash.restored ? 'warning' : 'success');
        void useGit.getState().load(agent.projectId);
        // Main archives the merged agent, so there is nothing left to review here: go back to Source
        // control (the toast stays). Not when the user already left this review while it merged.
        const at = useRouter.getState().route;
        if (at.screen === 'review' && at.params.agentId === agent.id) navigate('source-control');
      } else {
        setMerge({ step: 'conflicts', conflicts: res.conflicts, from: 'merge' });
        // The merge saw conflicts the prediction did not (or could not): ask main again.
        void useMergePredictions.getState().load(agent.id, { refresh: true });
      }
    } catch (err) {
      setMerge(null);
      toast(`Merge failed: ${ipcErrorMessage(err)}`, 'error');
    }
  };

  const handConflicts = (files: string[]) => {
    setMerge(null);
    navigate('spawn', {
      projectId: agent.projectId,
      goal: `Merge ${branch} into ${target} and resolve the conflicts in ${files.join(', ')}. Keep the intent of both sides; run the tests before submitting for review.`,
      context: files.map((path) => ({ kind: 'file' as const, path })),
    });
  };

  const sendLabel =
    sendState === 'busy' ? 'Sending…' : pending.length > 0 ? `Send ${plural(pending.length, 'comment', 'comments')} to agent` : 'Send feedback to agent';
  // Nothing pending after a send: the agent has it and is working on it.
  const revising = sendState === 'sent' && pending.length === 0;
  const prLabel = pr?.url ? `View pull request${pr.number ? ` #${pr.number}` : ''}` : prBusy ? 'Opening…' : 'Open pull request';

  return (
    <ResizableAside
      panel={PANELS.reviewSummary}
      aria-label="Review summary"
      className="flex flex-col gap-3.5 p-4 bg-panel border-l border-line box-border overflow-auto"
    >
      <div className="flex flex-col gap-1.5">
        <span className="text-[11px] font-semibold flex items-center gap-1.5" style={{ color: meta.color }}>
          <span aria-hidden="true" className="w-[7px] h-[7px] rounded-full" style={{ background: meta.color }} />
          {meta.label}
        </span>
        <h1 className="m-0 text-[16px] font-semibold">{agent.title}</h1>
        {branch && (
          <span className="font-mono text-[11.5px] text-ink-3">
            worktree {shortBranch(branch)} → {base}
          </span>
        )}
      </div>

      <div className="flex flex-col gap-1.5 p-3 rounded-lg bg-card border border-line-2 leading-normal">
        <h2 className="m-0 text-[12px] font-semibold text-ink-2">Agent's summary</h2>
        <span className="text-ink-2">{agent.review?.summary ?? "The agent hasn't submitted this for review yet. You can still read the diff and leave feedback."}</span>
      </div>

      {agent.review && (
        <div className="flex flex-col gap-2">
          <h2 className={`m-0 ${SECTION_LABEL}`}>Checks the agent ran</h2>
          {agent.review.checks.length === 0 && <span className="text-[12.5px] text-ink-3">No checks reported.</span>}
          <ul className="list-none m-0 p-0 flex flex-col gap-2">
            {agent.review.checks.map((c, i) => (
              <CheckRow key={`${c.name}-${i}`} c={c} />
            ))}
          </ul>
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        <h2 className={`m-0 ${SECTION_LABEL}`}>
          Your feedback · {comments.length} {comments.length === 1 ? 'comment' : 'comments'}
        </h2>
        {comments.length === 0 && <span className="text-[12.5px] text-ink-3">Click a line in the diff to comment on it.</span>}
        <ul className="list-none m-0 p-0 flex flex-col gap-1">
          {comments.map((c) => (
            <li key={c.id} className="min-w-0">
              <button
                type="button"
                onClick={() => onJump(c.path, c.line, c.side)}
                className={`w-full text-left bg-transparent border-0 p-0 text-[12.5px] truncate cursor-pointer hover:text-ink ${c.sent ? 'text-ink-3' : 'text-ink-2'}`}
                title={c.body}
              >
                {baseName(c.path)}
                {c.line !== undefined ? (c.side === 'old' ? ` (removed line ${c.line})` : `:${c.line}`) : ''} · {c.body}
                {c.sent ? ' (sent)' : ''}
              </button>
            </li>
          ))}
        </ul>
      </div>

      <div className="flex-1" />
      <DeployActions agent={agent} />
      {sensitiveFiles.length > 0 && <SensitiveWarning files={sensitiveFiles} onJump={onJump} />}
      <div className="flex flex-col gap-2">
        <Button variant="secondary" size={36} className="rounded-md" disabled={sendState === 'busy' || pending.length === 0} onClick={() => void send()}>
          {sendLabel}
        </Button>
        <span role="status" aria-live="polite" className="text-[11.5px] text-ink-3 leading-[1.45] empty:hidden">
          {revising ? 'Feedback sent · agent is revising' : ''}
        </span>
        {nothingToPush ? (
          <NothingToPush agent={agent} base={base} busy={archiveBusy} onArchive={() => void archive()} />
        ) : (
          <>
            {prAvailable === false ? (
              <>
                <Button variant="primary" size={36} className="rounded-md" disabled aria-describedby="pr-unavailable">
                  Open pull request
                </Button>
                <span id="pr-unavailable" className="text-[11.5px] text-ink-3 leading-[1.45]">
                  {prReason ?? 'Pull requests need the GitHub CLI: install gh and run gh auth login, then come back.'}
                </span>
              </>
            ) : openPrInfo ? (
              <PushToPr agent={agent} pr={openPrInfo} worktree={worktree} onView={() => void openPr()} />
            ) : (
              <Button variant="primary" size={36} className="rounded-md" disabled={prBusy} onClick={() => void openPr()}>
                {prLabel}
              </Button>
            )}
            <MergeStatus agent={agent} prediction={prediction} />
            <Button variant="ghost" size={32} className="rounded-md text-[12.5px]!" onClick={openMerge}>
              Merge worktree into {target} locally
            </Button>
          </>
        )}
      </div>

      <MergeDialog
        state={merge}
        agentTitle={who}
        branch={branch}
        target={target}
        prediction={prediction}
        predicting={forecast.loading}
        resolving={Boolean(agent.mergeConflict)}
        sensitiveFiles={sensitiveFiles}
        onClose={() => setMerge(null)}
        onMerge={() => void doMerge()}
        onAsk={(from) => void askToResolve(from)}
        onHandOff={(files) => handConflicts(files)}
      />
    </ResizableAside>
  );
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** What the worktree has that the PR does not: "2 new commits and 1 uncommitted file". Empty when up to date (or unknown). */
export function pendingForPr(worktree: Pick<WorktreeInfo, 'unpushed' | 'uncommitted'> | undefined): string {
  if (!worktree) return '';
  const parts: string[] = [];
  if (worktree.unpushed) parts.push(plural(worktree.unpushed, 'new commit', 'new commits'));
  if (worktree.uncommitted) parts.push(plural(worktree.uncommitted, 'uncommitted file', 'uncommitted files'));
  return parts.join(' and ');
}

/**
 * The branch has an open PR: follow-up work (new commits, files the agent left uncommitted) goes up
 * to it with Push to PR; View pull request stays next to it. With nothing to send (or the push state
 * not known yet), only View pull request shows.
 */
function PushToPr({ agent, pr, worktree, onView }: { agent: AgentSummary; pr: { url: string; number: number }; worktree?: WorktreeInfo; onView(): void }) {
  const [busy, setBusy] = useState(false);
  const pending = pendingForPr(worktree);
  const working = agent.status === 'running' || agent.status === 'starting' || agent.status === 'needs-permission';
  const blocked = working && (worktree?.uncommitted ?? 0) > 0;
  const push = async () => {
    setBusy(true);
    await pushToPullRequest(agent.id);
    await useGit.getState().load(agent.projectId);
    setBusy(false);
  };
  const offerPush = busy || hasPendingForPr(worktree);
  const view = (
    <Button variant={offerPush ? 'secondary' : 'primary'} size={offerPush ? 32 : 36} className="rounded-md" icon="external-link" onClick={onView}>
      View pull request #{pr.number}
    </Button>
  );
  if (!offerPush)
    return (
      <>
        {view}
        {worktree?.unpushed !== undefined && (
          <span className="text-[11.5px] text-ink-3 leading-[1.45]">Pull request #{pr.number} has everything in this worktree.</span>
        )}
      </>
    );
  return (
    <>
      <Button variant="primary" size={36} className="rounded-md" icon="arrow-up" disabled={busy || blocked} aria-describedby="push-to-pr" onClick={() => void push()}>
        {busy ? 'Pushing…' : `Push to pull request #${pr.number}`}
      </Button>
      <span id="push-to-pr" className="text-[11.5px] text-ink-3 leading-[1.45]">
        {blocked
          ? `${agent.title} is still working. Push once it stops or submits for review.`
          : pending
            ? `Not on pull request #${pr.number} yet: ${pending}.${worktree?.uncommitted ? ' oIDE commits the files for the agent first.' : ''}`
            : `Sending to pull request #${pr.number}…`}
      </span>
      {view}
    </>
  );
}

/** Decisions when the branch has nothing to push: archive the session instead of opening an empty PR. */
function NothingToPush({ agent, base, busy, onArchive }: { agent: AgentSummary; base: string; busy: boolean; onArchive(): void }) {
  const archivable = canArchive(agent);
  return (
    <>
      <Button variant="primary" size={36} className="rounded-md" disabled={busy || !archivable} aria-describedby="nothing-to-push" onClick={onArchive}>
        {busy ? 'Archiving…' : 'Archive session'}
      </Button>
      <span id="nothing-to-push" className="text-[11.5px] text-ink-3 leading-[1.45]">
        {archivable
          ? `Nothing to push: this worktree has no changes or commits against ${base}. Archive the session to take it off the Wall; you can unarchive it from Wall › Archived.`
          : `Nothing to push yet: this worktree has no changes or commits against ${base}. You can archive the session once the agent stops working.`}
      </span>
    </>
  );
}

function CheckRow({ c }: { c: CheckResult }) {
  const text = c.detail ? `${c.name} · ${c.detail}` : c.name;
  if (c.status === 'passed')
    return (
      <li className="flex gap-2 items-center">
        <Icon name="check" size={16} className="text-ok" title="Passed" />
        {text}
      </li>
    );
  if (c.status === 'failed')
    return (
      <li className="flex gap-2 items-center text-bad">
        <Icon name="close" size={16} title="Failed" />
        {text}
      </li>
    );
  if (c.status === 'warning')
    return (
      <li className="flex gap-2 items-center text-warn">
        <Icon name="alert-circle" size={16} title="Warning" />
        {text}
      </li>
    );
  return (
    <li className="flex gap-2 items-center text-ink-3">
      <Icon name="info" size={16} title="Skipped" />
      {text} (skipped)
    </li>
  );
}
