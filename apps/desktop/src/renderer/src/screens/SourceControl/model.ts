/**
 * Pure helpers for Source control (and shared with Review and Files): labels for sync state,
 * worktree base/behind, PR state, commit attribution and relative times. Copy follows
 * docs/wiki/raw/design/SourceControl.dc.html.
 */
import type { AgentStatus, CommitInfo, SyncState, WorktreeInfo } from '@oide/protocol';
import { NEEDS_YOU } from '@oide/protocol';

export const C = {
  ok: '#7FC8A9',
  warn: '#F2C078',
  review: '#9DBBFA',
  bad: '#F08A8A',
  ink3: '#9AA3AE',
  ink: '#E6E8EB',
};

export type SyncAction = 'Pull' | 'Push' | 'Fetch';

export interface SyncView {
  label: string;
  color: string;
  action: SyncAction;
}

/** "2 behind origin" + Pull, "1 to push" + Push, "Up to date" + Fetch. */
export function syncView(s: SyncState): SyncView {
  const remote = s.upstream?.split('/')[0] ?? 'origin';
  if (!s.upstream) return { label: 'Not on a remote yet', color: C.ink3, action: 'Push' };
  if (s.behind > 0 && s.ahead > 0) return { label: `${s.behind} behind ${remote} · ${s.ahead} to push`, color: C.warn, action: 'Pull' };
  if (s.behind > 0) return { label: `${s.behind} behind ${remote}`, color: C.warn, action: 'Pull' };
  if (s.ahead > 0) return { label: `${s.ahead} to push`, color: C.warn, action: 'Push' };
  return { label: 'Up to date', color: C.ok, action: 'Fetch' };
}

/** "1 uncommitted file (CLAUDE.md)", "3 uncommitted files (a.ts, b.ts, …)". */
export function localChangesLabel(files: string[]): string {
  const n = files.length;
  const names = files.map((f) => f.split(/[\\/]/).pop() ?? f);
  const shown = names.slice(0, 2).join(', ') + (n > 2 ? ', …' : '');
  return `${n} uncommitted ${n === 1 ? 'file' : 'files'} (${shown})`;
}

/** Last path segment of a branch: "billing-api/webhook-retry" → "webhook-retry". */
export function shortBranch(branch: string): string {
  return branch.split('/').pop() || branch;
}

/** "from main · up to date", "from main · 2 behind". */
export function baseLabel(w: Pick<WorktreeInfo, 'baseRef' | 'behind'>): string {
  const base = w.baseRef.replace(/^origin\//, '');
  return `from ${base} · ${w.behind > 0 ? `${w.behind} behind` : 'up to date'}`;
}

/** Status column: the canvas collapses permission/question/error into "Needs you". */
export function statusView(status: AgentStatus | undefined, orphaned = false): { label: string; color: string } {
  if (orphaned) return { label: 'Folder missing', color: C.bad };
  if (!status) return { label: 'No agent', color: C.ink3 };
  if (NEEDS_YOU.has(status)) return { label: 'Needs you', color: C.warn };
  if (status === 'ready-for-review') return { label: 'Ready for review', color: C.review };
  if (status === 'running' || status === 'starting') return { label: 'Running', color: C.ok };
  if (status === 'queued') return { label: 'Queued', color: C.ink3 };
  if (status === 'paused') return { label: 'Paused', color: C.ink3 };
  if (status === 'done') return { label: 'Done', color: C.ok };
  return { label: 'Stopped', color: C.ink3 };
}

/** "No PR", "Ready to open", "Draft PR #18", "PR #42 open". */
export function prView(pr: WorktreeInfo['pr'], status: AgentStatus | undefined): { label: string; color: string } {
  if (!pr) return status === 'ready-for-review' ? { label: 'Ready to open', color: C.review } : { label: 'No PR', color: C.ink3 };
  const n = pr.number !== undefined ? ` #${pr.number}` : '';
  switch (pr.state.toLowerCase()) {
    case 'draft':
      return { label: `Draft PR${n}`, color: C.review };
    case 'merged':
      return { label: `Merged${n}`, color: C.ok };
    case 'closed':
      return { label: `Closed${n}`, color: C.ink3 };
    default:
      return { label: `PR${n} open`, color: C.review };
  }
}

/** Display name for an `Oide-Agent:` trailer value: "Scaffold" → "Scaffold agent". */
export function agentDisplayName(name: string): string {
  return /\bagent$/i.test(name.trim()) ? name.trim() : `${name.trim()} agent`;
}

/**
 * Who made a commit: the agent from its `Oide-Agent:` trailer, "You, from an agent" for a merge of
 * an agent branch made from oIDE, otherwise "You".
 */
export function commitAuthor(c: Pick<CommitInfo, 'agent' | 'message'>): string {
  if (c.agent) return agentDisplayName(c.agent);
  if (/^Merge (branch )?'?[\w.-]+\/[\w./-]+/.test(c.message)) return 'You, from an agent';
  return 'You';
}

/** "just now", "5 min ago", "2 h ago", "yesterday", "3 days ago", "last week", "2 weeks ago". */
export function timeAgo(ts: number, now = Date.now()): string {
  const s = Math.max(0, now - ts) / 1000;
  const m = s / 60;
  const h = m / 60;
  const d = h / 24;
  if (m < 1) return 'just now';
  if (h < 1) return `${Math.floor(m)} min ago`;
  if (d < 1) return `${Math.floor(h)} h ago`;
  if (d < 2) return 'yesterday';
  if (d < 7) return `${Math.floor(d)} days ago`;
  if (d < 14) return 'last week';
  if (d < 31) return `${Math.floor(d / 7)} weeks ago`;
  return new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

/** "~/code/oide" for paths under the user's home folder. */
export function displayPath(path: string): string {
  return path.replace(/^(\/Users\/[^/]+|\/home\/[^/]+|[A-Za-z]:[\\/]Users[\\/][^\\/]+)(?=$|[\\/])/, '~');
}

/** Minus sign used by the canvas (U+2212). */
export const MINUS = '−';
