import { create } from 'zustand';
import type { FileNode } from '@oide/protocol';
import { ipcErrorMessage, oide } from '../../lib/bridge';

/**
 * Files screen state: which checkout each project shows (main or an agent worktree), which
 * project trees and folders are expanded, the lazily loaded tree (`files.tree` per folder), and the
 * open editor tabs. Paths are relative to the checkout root, with `/` separators.
 */
export interface FileTab {
  /** `${root}::${path}` */
  id: string;
  projectId: string;
  root: string;
  path: string;
}

type PerRoot<T> = Record<string, Record<string, T>>;

interface FilesState {
  openProjects: Record<string, boolean>;
  /** projectId → root shown (project.path or a worktree path). */
  checkout: Record<string, string>;
  expanded: PerRoot<boolean>;
  nodes: PerRoot<FileNode[]>;
  loading: PerRoot<boolean>;
  errors: PerRoot<string>;
  tabs: FileTab[];
  active?: string;
  /** Projects whose agent-touched folders were auto-expanded once. */
  revealed: Record<string, boolean>;

  setProjectOpen(projectId: string, open: boolean): void;
  setCheckout(projectId: string, root: string): void;
  loadDir(root: string, dir: string, force?: boolean): Promise<FileNode[] | undefined>;
  setExpanded(root: string, dir: string, open: boolean): Promise<void>;
  expandMany(root: string, dirs: string[]): void;
  openFile(projectId: string, root: string, path: string): void;
  closeTab(id: string): void;
  setActive(id: string): void;
  markRevealed(key: string): void;
}

export const tabId = (root: string, path: string) => `${root}::${path}`;

const put = <T>(map: PerRoot<T>, root: string, key: string, value: T | undefined): PerRoot<T> => {
  const inner = { ...(map[root] ?? {}) };
  if (value === undefined) delete inner[key];
  else inner[key] = value;
  return { ...map, [root]: inner };
};

const inflight = new Map<string, Promise<FileNode[] | undefined>>();

export const useFiles = create<FilesState>()((set, get) => ({
  openProjects: {},
  checkout: {},
  expanded: {},
  nodes: {},
  loading: {},
  errors: {},
  tabs: [],
  active: undefined,
  revealed: {},

  setProjectOpen: (projectId, open) => set({ openProjects: { ...get().openProjects, [projectId]: open } }),
  setCheckout: (projectId, root) => set({ checkout: { ...get().checkout, [projectId]: root } }),

  loadDir: (root, dir, force = false) => {
    const have = get().nodes[root]?.[dir];
    if (have && !force) return Promise.resolve(have);
    const key = `${root}\n${dir}`;
    const running = inflight.get(key);
    if (running) return running;
    set({ loading: put(get().loading, root, dir, true), errors: put(get().errors, root, dir, undefined) });
    const p = oide
      .invoke('files.tree', { root, dir })
      .then((list) => {
        const sorted = [...list].sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1));
        set({ nodes: put(get().nodes, root, dir, sorted), loading: put(get().loading, root, dir, undefined) });
        // Compact single-folder chains ("main/cli"): load the only child right away.
        const only = sorted.length === 1 && sorted[0]!.kind === 'dir' ? sorted[0]! : undefined;
        if (only) void get().loadDir(root, only.path);
        return sorted;
      })
      .catch((err: unknown) => {
        set({ loading: put(get().loading, root, dir, undefined), errors: put(get().errors, root, dir, ipcErrorMessage(err)) });
        return undefined;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  },

  setExpanded: async (root, dir, open) => {
    set({ expanded: put(get().expanded, root, dir, open ? true : undefined) });
    if (open) await get().loadDir(root, dir);
  },

  expandMany: (root, dirs) => {
    let expanded = get().expanded;
    for (const d of dirs) expanded = put(expanded, root, d, true);
    set({ expanded });
    for (const d of dirs) void get().loadDir(root, d);
  },

  openFile: (projectId, root, path) => {
    const id = tabId(root, path);
    const tabs = get().tabs.some((t) => t.id === id) ? get().tabs : [...get().tabs, { id, projectId, root, path }];
    set({ tabs, active: id });
  },
  closeTab: (id) => {
    const tabs = get().tabs;
    const i = tabs.findIndex((t) => t.id === id);
    const next = tabs.filter((t) => t.id !== id);
    const active = get().active === id ? (next[Math.min(i, next.length - 1)]?.id ?? undefined) : get().active;
    set({ tabs: next, active });
  },
  setActive: (id) => set({ active: id }),
  markRevealed: (key) => set({ revealed: { ...get().revealed, [key]: true } }),
}));

export interface TreeRow {
  key: string;
  /** Path of the row's node (for a compacted folder chain, the first folder). */
  path: string;
  /** Last folder of a compacted chain: whose children are shown. */
  contentPath: string;
  label: string;
  kind: 'file' | 'dir';
  depth: number;
  expanded: boolean;
  loading: boolean;
  error?: string;
  parent?: string;
}

/** Visible rows of one checkout, depth-first, with single-child folder chains compacted. */
export function visibleRows(root: string, s: Pick<FilesState, 'nodes' | 'expanded' | 'loading' | 'errors'>): TreeRow[] {
  const out: TreeRow[] = [];
  const nodes = s.nodes[root] ?? {};
  const walk = (dir: string, depth: number, parent?: string) => {
    for (const n of nodes[dir] ?? []) {
      if (n.kind === 'file') {
        out.push({ key: n.path, path: n.path, contentPath: n.path, label: n.name, kind: 'file', depth, expanded: false, loading: false, parent });
        continue;
      }
      let label = n.name;
      let cur = n.path;
      for (;;) {
        const kids = nodes[cur];
        if (kids && kids.length === 1 && kids[0]!.kind === 'dir') {
          label += `/${kids[0]!.name}`;
          cur = kids[0]!.path;
        } else break;
      }
      const expanded = Boolean(s.expanded[root]?.[n.path]);
      out.push({
        key: n.path,
        path: n.path,
        contentPath: cur,
        label,
        kind: 'dir',
        depth,
        expanded,
        loading: Boolean(s.loading[root]?.[cur]),
        error: s.errors[root]?.[cur],
        parent,
      });
      if (expanded) walk(cur, depth + 1, n.path);
    }
  };
  walk('', 0);
  return out;
}

/** Folders that contain any of `files` (for revealing agent activity). */
export function ancestorDirs(files: string[]): string[] {
  const dirs = new Set<string>();
  for (const f of files) {
    const parts = f.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }
  return [...dirs].sort((a, b) => a.split('/').length - b.split('/').length);
}

export function joinPath(root: string, rel: string): string {
  const sep = root.includes('\\') && !root.includes('/') ? '\\' : '/';
  return `${root.replace(/[\\/]+$/, '')}${sep}${sep === '\\' ? rel.replace(/\//g, '\\') : rel}`;
}
