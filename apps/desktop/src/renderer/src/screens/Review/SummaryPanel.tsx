import { useState } from 'react';
import { Button, Dialog, Icon, agentStatusMeta } from '@oide/ui';
import type { AgentSummary, CheckResult, ReviewComment, WorktreeInfo } from '@oide/protocol';
import { ipcErrorMessage, oide } from '../../lib/bridge';
import { navigate } from '../../stores/router';
import { toast } from '../../stores/ui';
import { useGit } from '../SourceControl/gitStore';
import { shortBranch } from '../SourceControl/model';
import { baseName } from './diff';
import { DeployActions } from '../../extensions/DeployActions';

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
}

/** Right column of Review: status, title, worktree → base, agent's summary and checks, feedback, decisions. */
export function SummaryPanel({ agent, worktree, comments, prAvailable, prReason, onSendFeedback, onJump, sensitiveFiles = [] }: SummaryPanelProps) {
  const meta = agentStatusMeta(agent.status);
  const branch = worktree?.branch ?? agent.branch ?? '';
  const base = (worktree?.baseRef ?? agent.baseRef ?? 'main').replace(/^origin\//, '');
  const pending = comments.filter((c) => !c.sent);
  const [sendState, setSendState] = useState<'idle' | 'busy' | 'sent'>('idle');
  const [prBusy, setPrBusy] = useState(false);
  const [merge, setMerge] = useState<{ step: 'confirm' | 'busy' | 'conflicts'; conflicts: string[] } | null>(null);
  const pr = worktree?.pr;

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
      const body = [agent.review?.summary ?? '', checksMarkdown(agent.review?.checks ?? [])].filter(Boolean).join('\n\n');
      const { url } = await oide.invoke('git.openPr', { agentId: agent.id, title: agent.title, body });
      toast('Pull request opened', 'success', { action: { label: 'View', run: () => void oide.invoke('shell.openExternal', { url }).catch(() => {}) } });
      void oide.invoke('shell.openExternal', { url }).catch(() => {});
      void useGit.getState().load(agent.projectId);
    } catch (err) {
      toast(`Couldn't open a pull request: ${ipcErrorMessage(err)}`, 'error');
    } finally {
      setPrBusy(false);
    }
  };

  const doMerge = async () => {
    setMerge({ step: 'busy', conflicts: [] });
    try {
      const res = await oide.invoke('git.mergeLocal', { agentId: agent.id });
      if (res.ok) {
        setMerge(null);
        toast(`Merged ${branch} into ${base}`, 'success');
        void useGit.getState().load(agent.projectId);
      } else setMerge({ step: 'conflicts', conflicts: res.conflicts });
    } catch (err) {
      setMerge(null);
      toast(`Merge failed: ${ipcErrorMessage(err)}`, 'error');
    }
  };

  const handConflicts = (files: string[]) => {
    setMerge(null);
    navigate('spawn', {
      projectId: agent.projectId,
      goal: `Merge ${branch} into ${base} and resolve the conflicts in ${files.join(', ')}. Keep the intent of both sides; run the tests before submitting for review.`,
      context: files.map((path) => ({ kind: 'file' as const, path })),
    });
  };

  const sendLabel = sendState === 'sent' ? 'Feedback sent · agent is revising' : sendState === 'busy' ? 'Sending…' : 'Send feedback to agent';
  const prLabel = pr?.url ? `View pull request${pr.number ? ` #${pr.number}` : ''}` : prBusy ? 'Opening…' : 'Open pull request';

  return (
    <aside
      aria-label="Review summary"
      className="flex-[1_1_300px] max-w-[340px] min-w-[280px] flex flex-col gap-3.5 p-4 bg-panel border-l border-line box-border overflow-auto"
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
        <Button variant="secondary" size={36} className="rounded-md" disabled={sendState === 'busy' || (sendState !== 'sent' && pending.length === 0)} onClick={() => void send()}>
          {sendLabel}
        </Button>
        {prAvailable === false ? (
          <>
            <Button variant="primary" size={36} className="rounded-md" disabled aria-describedby="pr-unavailable">
              Open pull request
            </Button>
            <span id="pr-unavailable" className="text-[11.5px] text-ink-3 leading-[1.45]">
              {prReason ?? 'Pull requests need the GitHub CLI: install gh and run gh auth login, then come back.'}
            </span>
          </>
        ) : (
          <Button variant="primary" size={36} className="rounded-md" disabled={prBusy} onClick={() => void openPr()}>
            {prLabel}
          </Button>
        )}
        <Button variant="ghost" size={32} className="rounded-md text-[12.5px]!" onClick={() => setMerge({ step: 'confirm', conflicts: [] })}>
          Merge worktree into {base} locally
        </Button>
      </div>

      <Dialog
        open={merge !== null}
        onClose={() => merge?.step !== 'busy' && setMerge(null)}
        title={merge?.step === 'conflicts' ? 'The merge stopped on conflicts' : `Merge into ${base}?`}
        description={
          merge?.step === 'conflicts'
            ? `Nothing changed in ${base}: oIDE aborted the merge.`
            : `Runs git merge --no-ff ${branch} in the main checkout. It stops on conflicts and leaves ${base} as it was.`
        }
        width={460}
        footer={
          merge?.step === 'conflicts' ? (
            <>
              <Button variant="secondary" size={32} onClick={() => setMerge(null)}>
                Close
              </Button>
              <Button variant="primary" size={32} onClick={() => handConflicts(merge.conflicts)}>
                Hand them to a new agent
              </Button>
            </>
          ) : (
            <>
              <Button variant="secondary" size={32} disabled={merge?.step === 'busy'} onClick={() => setMerge(null)}>
                Cancel
              </Button>
              <Button variant="primary" size={32} disabled={merge?.step === 'busy'} onClick={() => void doMerge()}>
                {merge?.step === 'busy' ? 'Merging…' : 'Merge'}
              </Button>
            </>
          )
        }
      >
        {merge?.step === 'confirm' && sensitiveFiles.length > 0 && <SensitiveWarning files={sensitiveFiles} />}
        {merge?.step === 'conflicts' && (
          <ul className="list-none m-0 p-0 flex flex-col gap-1">
            {merge.conflicts.map((f) => (
              <li key={f} className="font-mono text-[12px] text-bad-bright">
                {f}
              </li>
            ))}
          </ul>
        )}
      </Dialog>
    </aside>
  );
}

/** SEC-12: the agent changed files that widen what agents, git or MCP servers may do. */
function SensitiveWarning({ files, onJump }: { files: Array<{ path: string; reason: string }>; onJump?: (path: string) => void }) {
  return (
    <div role="alert" className="flex flex-col gap-1.5 p-3 rounded-lg border border-warn text-[12.5px] leading-normal">
      <span className="flex gap-2 items-center font-semibold text-warn">
        <Icon name="alert-circle" size={16} />
        Changes oIDE, Claude Code or git configuration
      </span>
      <span className="text-ink-2">Merging these can change what agents may do without asking. Read them before you merge.</span>
      <ul className="list-none m-0 p-0 flex flex-col gap-1">
        {files.map((f) => (
          <li key={f.path} className="min-w-0">
            {onJump ? (
              <button type="button" onClick={() => onJump(f.path)} className="bg-transparent border-0 p-0 text-left font-mono text-[12px] text-ink cursor-pointer hover:underline" title={f.reason}>
                {f.path}
              </button>
            ) : (
              <span className="font-mono text-[12px] text-ink" title={f.reason}>
                {f.path}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
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

function checksMarkdown(checks: CheckResult[]): string {
  if (!checks.length) return '';
  const mark = { passed: '[x]', failed: '[ ] FAILED', warning: '[ ] warning', skipped: '[ ] skipped' } as const;
  return ['Checks the agent ran:', ...checks.map((c) => `- ${mark[c.status]} ${c.name}${c.detail ? `: ${c.detail}` : ''}`)].join('\n');
}
