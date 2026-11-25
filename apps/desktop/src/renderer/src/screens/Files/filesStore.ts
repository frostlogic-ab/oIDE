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

/** A file to open (quick open, a search result): the Files screen resolves the project and consumes it. */
export interface OpenRequest {
  root: string;
  path: string;
  line?: number;
  column?: number;
  /** Characters to select from `column` (a search match). */
  length?: number;
  nonce: number;
}

export interface RecentFile {
  root: string;
  path: string;
}

const RECENT_KEY = 'oide.files.recent';
const RECENT_MAX = 50;

function loadRecent(): RecentFile[] {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(RECENT_KEY) : null;
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(list) ? list.filter((r): r is RecentFile => typeof r?.root === 'string' && typeof r?.path === 'string').slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

function saveRecent(list: RecentFile[]): void {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    /* private window or blocked storage: recents stay in memory */
  }
}

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
  /** Recently opened files, most recent first (quick open ranks them first). */
  recent: RecentFile[];
  /** Waiting to be opened by the Files screen. */
  pending?: OpenRequest;
  /** Row the tree should scroll to and focus once it is visible. */
  revealTarget?: { root: string; path: string; nonce: number };

  setProjectOpen(projectId: string, open: boolean): void;
  setCheckout(projectId: string, root: string): void;
  loadDir(root: string, dir: string, force?: boolean): Promise<FileNode[] | undefined>;
  setExpanded(root: string, dir: string, open: boolean): Promise<void>;
  expandMany(root: string, dirs: string[]): void;
  openFile(projectId: string, root: string, path: string): void;
  closeTab(id: string): void;
  setActive(id: string): void;
  markRevealed(key: string): void;
  /** Open a file (and reveal it in the tree) from anywhere; switch to Files separately. */
  requestOpen(req: Omit<OpenRequest, 'nonce'>): void;
  clearPending(nonce: number): void;
  /** Expand the folders above `path` and scroll the tree to it. */
  revealPath(root: string, path: string): void;
  clearRevealTarget(nonce: number): void;
  collapseAll(root: string): void;
  /** Expand every folder whose contents are already loaded. */
  expandLoaded(root: string): void;
  /** Load and expand folders down to `depth` levels (1 = the top folders), at most `cap` folders. */
  expandToDepth(root: string, depth: number, cap?: number): Promise<void>;
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
  recent: loadRecent(),
  pending: undefined,
  revealTarget: undefined,

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
    const recent = [{ root, path }, ...get().recent.filter((r) => r.root !== root || r.path !== path)].slice(0, RECENT_MAX);
    saveRecent(recent);
    set({ tabs, active: id, recent });
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

  requestOpen: (req) => set({ pending: { ...req, nonce: Date.now() + Math.random() } }),
  clearPending: (nonce) => {
    if (get().pending?.nonce === nonce) set({ pending: undefined });
  },
  revealPath: (root, path) => {
    const dirs = ancestorDirs([path]);
    if (dirs.length) get().expandMany(root, dirs);
    set({ revealTarget: { root, path, nonce: Date.now() + Math.random() } });
  },
  clearRevealTarget: (nonce) => {
    if (get().revealTarget?.nonce === nonce) set({ revealTarget: undefined });
  },
  collapseAll: (root) => set({ expanded: { ...get().expanded, [root]: {} } }),
  expandLoaded: (root) => {
    const nodes = get().nodes[root] ?? {};
    const dirs: string[] = [];
    for (const list of Object.values(nodes)) for (const n of list) if (n.kind === 'dir' && nodes[n.path]) dirs.push(n.path);
    let expanded = get().expanded;
    for (const d of dirs) expanded = put(expanded, root, d, true);
    set({ expanded });
  },
  expandToDepth: async (root, depth, cap = 300) => {
    let level = [''];
    let opened = 0;
    for (let d = 0; d < depth && level.length && opened < cap; d++) {
      const lists = await Promise.all(level.map((dir) => get().loadDir(root, dir)));
      const next: string[] = [];
      for (const list of lists) for (const n of list ?? []) if (n.kind === 'dir' && opened + next.length < cap) next.push(n.path);
      let expanded = get().expanded;
      for (const dir of next) expanded = put(expanded, root, dir, true);
      set({ expanded });
      opened += next.length;
      // Compacted chains ("main/cli") count as one level: descend into their last folder.
      level = next;
    }
    await Promise.all(level.map((dir) => get().loadDir(root, dir)));
  },
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
