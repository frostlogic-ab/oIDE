import { useEffect } from 'react';
import { create } from 'zustand';
import type { FileChange, FileChangeStatus, FileNode } from '@oide/protocol';
import { ipcErrorMessage, oide } from '../../lib/bridge';
import { isUnder } from './treeOps';

/**
 * Git colours of the Files tree (VS Code explorer style): what each shown checkout changed, from
 * `files.changes` (main checkout: uncommitted, against HEAD; agent worktree: everything the branch
 * changed since its base). Refreshed on `git.changed` for the project and when the window gets focus.
 */
export interface CheckoutChanges {
  against: 'head' | 'branch';
  byPath: Map<string, FileChange>;
  /** Folder → strongest status of the changes under it (folders are tinted like VS Code's). */
  dirs: Map<string, FileChangeStatus>;
  /** Folder → deleted entries to show in it (deleted files, and folders that only hold deleted files). */
  ghosts: Map<string, FileNode[]>;
  truncated: boolean;
}

interface ChangesState {
  byRoot: Record<string, CheckoutChanges>;
  load(root: string): Promise<void>;
}

const inflight = new Map<string, Promise<void>>();
const again = new Set<string>();

export const useChanges = create<ChangesState>()((set, get) => ({
  byRoot: {},
  load: (root) => {
    // One request per root at a time; a refresh asked for meanwhile runs once after it.
    const running = inflight.get(root);
    if (running) {
      again.add(root);
      return running;
    }
    const p = oide
      .invoke('files.changes', { root })
      .then((r) => set({ byRoot: { ...get().byRoot, [root]: indexChanges(r.changes, r.against, r.truncated) } }))
      .catch((err: unknown) => console.warn('files.changes failed', ipcErrorMessage(err)))
      .finally(() => {
        inflight.delete(root);
        if (again.delete(root)) void get().load(root);
      });
    inflight.set(root, p);
    return p;
  },
}));

/** Strongest first: a folder holding a conflict shows it, then any edit, then only additions, then only deletions. */
const RANK: Record<FileChangeStatus, number> = { conflicted: 5, modified: 4, renamed: 3, added: 2, untracked: 2, deleted: 1 };

export function indexChanges(changes: FileChange[], against: 'head' | 'branch', truncated = false): CheckoutChanges {
  const byPath = new Map<string, FileChange>();
  const dirs = new Map<string, FileChangeStatus>();
  const ghosts = new Map<string, FileNode[]>();
  const ghostSeen = new Set<string>();
  const addGhost = (dir: string, node: FileNode) => {
    if (ghostSeen.has(node.path)) return;
    ghostSeen.add(node.path);
    ghosts.set(dir, [...(ghosts.get(dir) ?? []), node]);
  };
  for (const c of changes) {
    byPath.set(c.path, c);
    const parts = c.path.split('/');
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join('/');
      const had = dirs.get(dir);
      if (!had || RANK[c.status] > RANK[had]) dirs.set(dir, c.status);
      // A deleted file's folders may be gone too: list them as deleted folders (shown only where the
      // real listing lacks them).
      if (c.status === 'deleted') addGhost(parts.slice(0, i - 1).join('/'), { name: parts[i - 1]!, path: dir, kind: 'dir' });
    }
    if (c.status === 'deleted') addGhost(parts.slice(0, -1).join('/'), { name: parts[parts.length - 1]!, path: c.path, kind: 'file' });
  }
  return { against, byPath, dirs, ghosts, truncated };
}

/** Changed files at or under `path` (a file, or a folder of the tree). */
export function changesUnder(c: CheckoutChanges | undefined, path: string): FileChange[] {
  if (!c) return [];
  const exact = c.byPath.get(path);
  if (exact) return [exact];
  if (!c.dirs.has(path)) return [];
  return [...c.byPath.values()].filter((x) => isUnder(x.path, path));
}

/** VS Code's explorer letters. */
export const STATUS_LETTER: Record<FileChangeStatus, string> = { modified: 'M', added: 'A', untracked: 'U', deleted: 'D', renamed: 'R', conflicted: '!' };
export const STATUS_LABEL: Record<FileChangeStatus, string> = {
  modified: 'Modified',
  added: 'Added',
  untracked: 'Untracked',
  deleted: 'Deleted',
  renamed: 'Renamed',
  conflicted: 'Conflict',
};
/** Changed green, deleted red (struck through), conflicts amber. */
export const STATUS_TEXT: Record<FileChangeStatus, string> = {
  modified: 'text-ok',
  added: 'text-ok',
  untracked: 'text-ok',
  renamed: 'text-ok',
  deleted: 'text-bad',
  conflicted: 'text-warn',
};

/** Load the changes of these checkouts and keep them fresh while mounted. */
export function useCheckoutChanges(checkouts: Array<{ projectId: string; root: string }>): void {
  const key = JSON.stringify(checkouts.map((c) => [c.projectId, c.root]));
  useEffect(() => {
    const list = JSON.parse(key) as Array<[string, string]>;
    const load = (projectId?: string) => {
      for (const [p, root] of list) if (!projectId || p === projectId) void useChanges.getState().load(root);
    };
    load();
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const off = oide.on('git.changed', ({ projectId }) => {
      if (!list.some(([p]) => p === projectId)) return;
      clearTimeout(timers.get(projectId));
      timers.set(
        projectId,
        setTimeout(() => load(projectId), 250),
      );
    });
    const onFocus = () => load();
    window.addEventListener('focus', onFocus);
    return () => {
      off();
      window.removeEventListener('focus', onFocus);
      for (const t of timers.values()) clearTimeout(t);
    };
  }, [key]);
}
