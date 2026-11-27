import { useEffect } from 'react';
import { create } from 'zustand';
import type { CommitInfo, OverlapWarning, SyncState, WorktreeInfo } from '@oide/protocol';
import { invokeOr, ipcErrorMessage, isNotImplemented, oide } from '../../lib/bridge';

/**
 * Per-project git state for Source control, Review and Files: sync (git.sync), agent worktrees
 * (git.worktrees), recent commits on the main checkout (git.log), overlap warnings (git.overlaps)
 * and whether PRs can be opened (git.prAvailable). Refreshed on `git.changed`.
 */
export interface ProjectGit {
  sync?: SyncState;
  worktrees: WorktreeInfo[];
  log: CommitInfo[];
  overlaps: OverlapWarning[];
  /** undefined = unknown (main has no answer yet): treat as available. */
  prAvailable?: boolean;
  prReason?: string;
  loading: boolean;
  error?: string;
  loadedAt?: number;
}

const EMPTY: ProjectGit = { worktrees: [], log: [], overlaps: [], loading: false };

interface GitState {
  byProject: Record<string, ProjectGit>;
  load(projectId: string): Promise<void>;
  patch(projectId: string, patch: Partial<ProjectGit>): void;
}

async function safe<T>(p: Promise<T>, fallback: T, errors: string[]): Promise<T> {
  try {
    return await p;
  } catch (err) {
    if (!isNotImplemented(err)) errors.push(ipcErrorMessage(err));
    return fallback;
  }
}

const inflight = new Map<string, Promise<void>>();

export const useGit = create<GitState>()((set, get) => ({
  byProject: {},
  patch: (projectId, patch) => set({ byProject: { ...get().byProject, [projectId]: { ...(get().byProject[projectId] ?? EMPTY), ...patch } } }),
  load: (projectId) => {
    const running = inflight.get(projectId);
    if (running) return running;
    const p = (async () => {
      get().patch(projectId, { loading: true });
      const errors: string[] = [];
      const [sync, worktrees, log, overlaps, pr] = await Promise.all([
        safe(oide.invoke('git.sync', { projectId }), undefined, errors),
        safe(oide.invoke('git.worktrees', { projectId }), [], errors),
        safe(oide.invoke('git.log', { projectId, ref: 'HEAD', limit: 20 }), [], errors),
        safe(oide.invoke('git.overlaps', { projectId }), [], errors),
        invokeOr('git.prAvailable', { projectId }, undefined).catch(() => undefined),
      ]);
      get().patch(projectId, {
        sync,
        worktrees,
        log,
        overlaps,
        prAvailable: pr?.available,
        prReason: pr?.reason,
        loading: false,
        error: errors[0],
        loadedAt: Date.now(),
      });
    })().finally(() => inflight.delete(projectId));
    inflight.set(projectId, p);
    return p;
  },
}));

export function useProjectGit(projectId: string | undefined): ProjectGit {
  return useGit((s) => (projectId ? s.byProject[projectId] : undefined) ?? EMPTY);
}

/** Load the given projects and keep them fresh on `git.changed` while mounted. */
export function useGitData(projectIds: string[]): void {
  const key = projectIds.join('|');
  useEffect(() => {
    const ids = key ? key.split('|') : [];
    for (const id of ids) void useGit.getState().load(id);
    const off = oide.on('git.changed', ({ projectId }) => {
      if (ids.includes(projectId)) void useGit.getState().load(projectId);
    });
    return off;
  }, [key]);
}

const syncing = new Map<string, { again: boolean }>();

/** Refresh only a project's sync state (`git.sync`: one `git status`). Calls during a refresh coalesce into one more. */
export async function loadSync(projectId: string): Promise<void> {
  const running = syncing.get(projectId);
  if (running) {
    running.again = true;
    return;
  }
  const state = { again: false };
  syncing.set(projectId, state);
  try {
    do {
      state.again = false;
      try {
        useGit.getState().patch(projectId, { sync: await oide.invoke('git.sync', { projectId }) });
      } catch {
        // Not a git repo, or the project went away: no Pull offer.
      }
    } while (state.again);
  } finally {
    syncing.delete(projectId);
  }
}

/**
 * Keep the sync state (ahead/behind after the background fetch) of the given projects fresh while
 * mounted. Lighter than useGitData: the Projects sidebar only needs `behind` for its Pull button.
 */
export function useSyncStates(projectIds: string[]): void {
  const key = projectIds.join('|');
  useEffect(() => {
    const ids = key ? key.split('|') : [];
    for (const id of ids) void loadSync(id);
    return oide.on('git.changed', ({ projectId }) => {
      if (ids.includes(projectId)) void loadSync(projectId);
    });
  }, [key]);
}

/** The worktree record for an agent, across loaded projects. */
export function findWorktree(byProject: Record<string, ProjectGit>, agentId: string): WorktreeInfo | undefined {
  for (const p of Object.values(byProject)) {
    const w = p.worktrees.find((x) => x.agentId === agentId);
    if (w) return w;
  }
  return undefined;
}

/**
 * Whether Push to PR has anything to send: commits the PR head lacks, or uncommitted files. Unknown
 * (worktree not loaded yet, or the branch's remote branch is not known locally) counts as nothing, so
 * Review and the Wall never offer a push that would send nothing.
 */
export function hasPendingForPr(worktree: Pick<WorktreeInfo, 'unpushed' | 'uncommitted'> | undefined): boolean {
  return (worktree?.unpushed ?? 0) > 0 || (worktree?.uncommitted ?? 0) > 0;
}
