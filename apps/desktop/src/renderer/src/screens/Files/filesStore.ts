import { create } from 'zustand';
import type { FileChange, FileNode } from '@oide/protocol';
import { ipcErrorMessage, oide } from '../../lib/bridge';
import { useChanges } from './changesStore';
import { loadDiffLayout, saveDiffLayout, type DiffLayout, type DiffView } from './diffView';
import type { MarkdownView } from './markdownLinks';
import { isUnder, joinRel, parentDir, remapPath } from './treeOps';

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

/** The inline name field in the tree: a new entry in `dir`, or renaming `path`. */
export type TreeEdit =
  | { root: string; projectId: string; mode: 'create'; kind: 'file' | 'dir'; dir: string; error?: string }
  | { root: string; projectId: string; mode: 'rename'; kind: 'file' | 'dir'; path: string; error?: string };

/** Copy or Cut in the tree: what Paste copies (or moves). Any checkout can paste it. */
export interface TreeClipboard {
  root: string;
  path: string;
  kind: 'file' | 'dir';
  cut: boolean;
}

/** Tabs moved by a rename or a move: the editor keeps their models (and unsaved edits) under the new ids. */
type TabMoveListener = (moves: ReadonlyArray<{ from: string; to: string }>) => void;
const tabMoveListeners = new Set<TabMoveListener>();
export function onTabsMoved(fn: TabMoveListener): () => void {
  tabMoveListeners.add(fn);
  return () => tabMoveListeners.delete(fn);
}

/** Tabs whose file changed on disk under them (Discard changes): the editor reads them again. */
type TabReloadListener = (ids: readonly string[]) => void;
const tabReloadListeners = new Set<TabReloadListener>();
export function onTabsReloaded(fn: TabReloadListener): () => void {
  tabReloadListeners.add(fn);
  return () => tabReloadListeners.delete(fn);
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
  /**
   * Tab id → has unsaved edits. Lives here (not in the screen) so the dot, the Save button and the
   * close warning survive leaving Files and coming back: the editor models outlive the screen too.
   */
  dirty: Record<string, boolean>;
  /**
   * Markdown tab id → how it shows, once the user switched it. Missing = the preview (the default
   * for Markdown files); closing the tab forgets it, so a file always reopens in the preview.
   */
  mdView: Record<string, MarkdownView>;
  /**
   * Changed-file tab id → how it shows, once the user switched it: its changes (unified or side by
   * side) or the plain editor. Missing = `diffLayout` (a changed file opens on its changes).
   */
  diffView: Record<string, DiffView>;
  /** The changes layout last picked (remembered across launches). */
  diffLayout: DiffLayout;
  /** Projects whose agent-touched folders were auto-expanded once. */
  revealed: Record<string, boolean>;
  /** Recently opened files, most recent first (quick open ranks them first). */
  recent: RecentFile[];
  /** Waiting to be opened by the Files screen. */
  pending?: OpenRequest;
  /** Row the tree should scroll to and focus once it is visible. */
  revealTarget?: { root: string; path: string; nonce: number };
  /** The tree's inline name field (New file, New folder, Rename). */
  edit?: TreeEdit;
  clipboard?: TreeClipboard;

  setProjectOpen(projectId: string, open: boolean): void;
  setCheckout(projectId: string, root: string): void;
  loadDir(root: string, dir: string, force?: boolean): Promise<FileNode[] | undefined>;
  /** `load: false` for a deleted folder (git colours): its rows come from the changes, not the disk. */
  setExpanded(root: string, dir: string, open: boolean, load?: boolean): Promise<void>;
  expandMany(root: string, dirs: string[]): void;
  openFile(projectId: string, root: string, path: string): void;
  closeTab(id: string): void;
  /** Close several tabs at once. The active tab stays if it is kept, else the kept tab nearest its place. */
  closeTabs(ids: string[]): void;
  setDirty(id: string, dirty: boolean): void;
  setMdView(id: string, view: MarkdownView): void;
  /** Picking a layout also makes it the default for the next changed file. */
  setDiffView(id: string, view: DiffView): void;
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

  /** Open the inline name field for a new file or folder in `dir`, expanding the folder row `expandKey` (default `dir`). */
  startCreate(projectId: string, root: string, dir: string, kind: 'file' | 'dir', expandKey?: string): void;
  startRename(projectId: string, root: string, path: string, kind: 'file' | 'dir'): void;
  cancelEdit(): void;
  /** Commit the name field; on failure the field stays open showing the error. */
  commitEdit(name: string): Promise<boolean>;
  setClipboard(clip: TreeClipboard | undefined): void;
  /** Paste the clipboard into `dir` of `root` (a project or worktree); resolves the new path or an error. */
  paste(projectId: string, root: string, dir: string): Promise<{ path?: string; error?: string }>;
  /** Move to the trash, close its tabs (their unsaved edits are dropped) and refresh the tree. */
  deleteEntry(root: string, path: string): Promise<{ error?: string }>;
  /**
   * Git colours › Discard changes: the files go back to the version they are compared against (new
   * ones are deleted, deleted ones come back). Open tabs reload (new files' tabs close), the tree
   * and the colours refresh.
   */
  discardChanges(root: string, changes: FileChange[]): Promise<{ error?: string }>;
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
  dirty: {},
  mdView: {},
  diffView: {},
  diffLayout: loadDiffLayout(),
  revealed: {},
  recent: loadRecent(),
  pending: undefined,
  revealTarget: undefined,
  edit: undefined,
  clipboard: undefined,

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

  setExpanded: async (root, dir, open, load = true) => {
    set({ expanded: put(get().expanded, root, dir, open ? true : undefined) });
    if (open && load) await get().loadDir(root, dir);
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
  closeTab: (id) => get().closeTabs([id]),
  closeTabs: (ids) => {
    const gone = new Set(ids);
    const tabs = get().tabs;
    const next = tabs.filter((t) => !gone.has(t.id));
    let active = get().active;
    if (active !== undefined && gone.has(active)) {
      const i = tabs.findIndex((t) => t.id === active);
      const kept = tabs.slice(0, i).filter((t) => !gone.has(t.id)).length;
      active = next[Math.min(kept, next.length - 1)]?.id;
    }
    // Per-tab state goes with the tab: the unsaved flag and the Markdown and changes view choices.
    const dirty = Object.fromEntries(Object.entries(get().dirty).filter(([id]) => !gone.has(id)));
    const mdView = Object.fromEntries(Object.entries(get().mdView).filter(([id]) => !gone.has(id)));
    const diffView = Object.fromEntries(Object.entries(get().diffView).filter(([id]) => !gone.has(id)));
    set({ tabs: next, active, dirty, mdView, diffView });
  },
  setDirty: (id, d) => {
    if (Boolean(get().dirty[id]) === d) return;
    const { [id]: _prev, ...rest } = get().dirty;
    set({ dirty: d ? { ...rest, [id]: true } : rest });
  },
  setMdView: (id, view) => {
    if (get().mdView[id] !== view) set({ mdView: { ...get().mdView, [id]: view } });
  },
  setDiffView: (id, view) => {
    const layout = view === 'off' ? get().diffLayout : view;
    if (layout !== get().diffLayout) saveDiffLayout(layout);
    if (get().diffView[id] !== view || layout !== get().diffLayout) set({ diffView: { ...get().diffView, [id]: view }, diffLayout: layout });
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

  startCreate: (projectId, root, dir, kind, expandKey) => {
    if (dir) void get().setExpanded(root, expandKey ?? dir, true);
    set({ edit: { root, projectId, mode: 'create', kind, dir } });
  },
  startRename: (projectId, root, path, kind) => set({ edit: { root, projectId, mode: 'rename', kind, path } }),
  cancelEdit: () => set({ edit: undefined }),
  commitEdit: async (input) => {
    const e = get().edit;
    if (!e) return false;
    const name = input.split('\\').join('/');
    try {
      if (e.mode === 'create') {
        const path = joinRel(e.dir, name);
        await oide.invoke('files.create', { root: e.root, path, kind: e.kind });
        set({ edit: undefined });
        await refreshChain(e.root, e.dir, parentDir(path));
        if (e.kind === 'file') get().openFile(e.projectId, e.root, path);
        get().revealPath(e.root, path);
      } else {
        const from = e.path;
        const to = joinRel(parentDir(from), name);
        if (to !== from) {
          await oide.invoke('files.rename', { root: e.root, from, to });
          moved(e.root, from, e.root, to, e.projectId);
          await refreshChain(e.root, parentDir(from), parentDir(to));
          get().revealPath(e.root, to);
        }
        set({ edit: undefined });
      }
      return true;
    } catch (err) {
      if (get().edit === e) set({ edit: { ...e, error: ipcErrorMessage(err) } });
      return false;
    }
  },
  setClipboard: (clipboard) => set({ clipboard }),
  paste: async (projectId, root, dir) => {
    const c = get().clipboard;
    if (!c) return {};
    try {
      const { path } = await oide.invoke('files.copy', { fromRoot: c.root, from: c.path, toRoot: root, toDir: dir, move: c.cut });
      if (c.cut) {
        set({ clipboard: undefined });
        if (c.root !== root || c.path !== path) {
          moved(c.root, c.path, root, path, projectId);
          await refreshChain(c.root, parentDir(c.path), parentDir(c.path));
        }
      }
      await refreshChain(root, dir, dir);
      get().revealPath(root, path);
      return { path };
    } catch (err) {
      return { error: ipcErrorMessage(err) };
    }
  },
  deleteEntry: async (root, path) => {
    try {
      await oide.invoke('files.delete', { root, path });
    } catch (err) {
      return { error: ipcErrorMessage(err) };
    }
    for (const t of get().tabs.filter((x) => x.root === root && isUnder(x.path, path))) get().closeTab(t.id);
    const c = get().clipboard;
    set({ ...dropUnder(root, path), clipboard: c && c.root === root && isUnder(c.path, path) ? undefined : c });
    await refreshChain(root, parentDir(path), parentDir(path));
    return {};
  },
  discardChanges: async (root, changes) => {
    if (!changes.length) return {};
    try {
      await oide.invoke('files.discardChanges', { root, paths: changes.map((c) => c.path) });
    } catch (err) {
      void useChanges.getState().load(root);
      return { error: ipcErrorMessage(err) };
    }
    const all = new Set(changes.map((c) => c.path));
    const gone = new Set(changes.filter((c) => c.status === 'added' || c.status === 'untracked').map((c) => c.path));
    for (const t of get().tabs.filter((x) => x.root === root && gone.has(x.path))) get().closeTab(t.id);
    const reload = get()
      .tabs.filter((x) => x.root === root && all.has(x.path))
      .map((t) => t.id);
    if (reload.length) for (const fn of tabReloadListeners) fn(reload);
    // Folders that gained (restored) or lost (deleted) entries list again: the loaded ones, and
    // deleted folders that were open and are real again.
    const st = get();
    const dirs = new Set(['', ...ancestorDirs([...all])]);
    await Promise.all([
      ...[...dirs].filter((d) => d === '' || st.nodes[root]?.[d] || st.expanded[root]?.[d]).map((d) => st.loadDir(root, d, true)),
      useChanges.getState().load(root),
    ]);
    return {};
  },
}));

/** Reload `from` and the loaded folders between it and `to` (a folder under `from`), so new entries show. */
async function refreshChain(root: string, from: string, to: string): Promise<void> {
  const s = useFiles.getState();
  const dirs = [from];
  if (to !== from && (from === '' || to.startsWith(`${from}/`))) {
    const rest = (from ? to.slice(from.length + 1) : to).split('/');
    for (let i = 1; i <= rest.length; i++) dirs.push(joinRel(from, rest.slice(0, i).join('/')));
  }
  await Promise.all(dirs.filter((d, i) => i === 0 || s.nodes[root]?.[d]).map((d) => s.loadDir(root, d, true)));
}

/** Tree state (listings, open folders, errors) of `path` and everything under it, dropped. */
function dropUnder(root: string, path: string) {
  const s = useFiles.getState();
  const prune = <T,>(map: PerRoot<T>): PerRoot<T> => ({ ...map, [root]: Object.fromEntries(Object.entries(map[root] ?? {}).filter(([k]) => !isUnder(k, path))) });
  return { nodes: prune(s.nodes), expanded: prune(s.expanded), errors: prune(s.errors) };
}

/**
 * `from` (in `fromRoot`) is now `to` (in `toRoot`): its tabs, unsaved-edit dots, recents and open
 * folders follow it. Listings under the old path are dropped; open folders reload under the new one.
 */
function moved(fromRoot: string, from: string, toRoot: string, to: string, toProject: string): void {
  const s = useFiles.getState();
  const moves: Array<{ from: string; to: string }> = [];
  const tabs = s.tabs.map((t) => {
    if (t.root !== fromRoot || !isUnder(t.path, from)) return t;
    const path = remapPath(t.path, from, to);
    const id = tabId(toRoot, path);
    moves.push({ from: t.id, to: id });
    return { id, projectId: toProject, root: toRoot, path };
  });
  const ids = new Map(moves.map((m) => [m.from, m.to]));
  const dirty = Object.fromEntries(Object.entries(s.dirty).map(([k, v]) => [ids.get(k) ?? k, v]));
  const mdView = Object.fromEntries(Object.entries(s.mdView).map(([k, v]) => [ids.get(k) ?? k, v]));
  const diffView = Object.fromEntries(Object.entries(s.diffView).map(([k, v]) => [ids.get(k) ?? k, v]));
  const recent = s.recent.map((r) => (r.root === fromRoot && isUnder(r.path, from) ? { root: toRoot, path: remapPath(r.path, from, to) } : r));
  saveRecent(recent);
  const reopen = Object.keys(s.expanded[fromRoot] ?? {})
    .filter((k) => isUnder(k, from))
    .map((k) => remapPath(k, from, to));
  const dropped = dropUnder(fromRoot, from);
  let expanded = dropped.expanded;
  for (const d of reopen) expanded = put(expanded, toRoot, d, true);
  // Listeners first: the editor re-keys its models before it renders the renamed tabs.
  if (moves.length) for (const fn of tabMoveListeners) fn(moves);
  useFiles.setState({ ...dropped, expanded, tabs, dirty, mdView, diffView, recent, active: s.active ? (ids.get(s.active) ?? s.active) : s.active });
  for (const d of reopen) void useFiles.getState().loadDir(toRoot, d);
}

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
  /** The inline name field: a new entry's row, or the row being renamed. */
  draft?: 'create' | 'rename';
  /** Deleted (git colours): not on disk, shown struck through; only Discard changes brings it back. */
  ghost?: boolean;
  /** Excluded by the checkout's ignore rules (or inside an ignored folder): shown greyed out. */
  ignored?: boolean;
}

/** Key of the new-entry row (no real path holds a NUL). */
export const DRAFT_KEY = '\u0000new';

/**
 * Visible rows of one checkout, depth-first, with single-child folder chains compacted. A New file /
 * New folder field is a row at the top of its folder; the row being renamed is marked.
 */
export function visibleRows(
  root: string,
  s: Pick<FilesState, 'nodes' | 'expanded' | 'loading' | 'errors'> & { edit?: TreeEdit },
  /** Deleted entries per folder (git colours): shown struck through where the listing lacks them. */
  ghosts?: ReadonlyMap<string, FileNode[]>,
): TreeRow[] {
  const out: TreeRow[] = [];
  const nodes = s.nodes[root] ?? {};
  const edit = s.edit?.root === root ? s.edit : undefined;
  // A folder's entries: its listing plus the deleted ones it lacks (a deleted folder has no listing).
  const ghostPaths = new Set<string>();
  const childrenOf = (dir: string): FileNode[] | undefined => {
    const listed = nodes[dir];
    const extra = ghosts?.get(dir);
    if (!extra?.length || (!listed && !ghostPaths.has(dir))) return listed;
    const names = new Set((listed ?? []).map((n) => n.name));
    const add = extra.filter((g) => !names.has(g.name));
    if (!add.length) return listed;
    for (const g of add) ghostPaths.add(g.path);
    return [...(listed ?? []), ...add].sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1));
  };
  const walk = (dir: string, depth: number, parent?: string, inIgnored = false) => {
    if (edit?.mode === 'create' && edit.dir === dir) {
      out.push({ key: DRAFT_KEY, path: dir, contentPath: dir, label: '', kind: edit.kind, depth, expanded: false, loading: false, parent, draft: 'create' });
    }
    for (const n of childrenOf(dir) ?? []) {
      const ghost = ghostPaths.has(n.path) ? { ghost: true as const } : {};
      const ignored = inIgnored || n.ignored === true;
      const ign = ignored ? { ignored: true as const } : {};
      if (n.kind === 'file') {
        const draft = edit?.mode === 'rename' && edit.path === n.path ? { draft: 'rename' as const } : {};
        out.push({ key: n.path, path: n.path, contentPath: n.path, label: n.name, kind: 'file', depth, expanded: false, loading: false, parent, ...draft, ...ghost, ...ign });
        continue;
      }
      let label = n.name;
      let cur = n.path;
      for (;;) {
        const kids = childrenOf(cur);
        // A deleted folder is never merged into a chain with a real one (its rows act differently),
        // nor an ignored folder with one that is not (the chain would be greyed out as a whole).
        const kid = kids?.length === 1 ? kids[0]! : undefined;
        if (kid?.kind === 'dir' && ghostPaths.has(kid.path) === ghostPaths.has(n.path) && (ignored || kid.ignored === true) === ignored) {
          label += `/${kid.name}`;
          cur = kid.path;
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
        // A deleted folder is never listed from disk: no spinner, no "failed to load".
        loading: ghost.ghost ? false : Boolean(s.loading[root]?.[cur]),
        error: ghost.ghost ? undefined : s.errors[root]?.[cur],
        parent,
        ...(edit?.mode === 'rename' && edit.path === cur ? { draft: 'rename' as const } : {}),
        ...ghost,
        ...ign,
      });
      if (expanded) walk(cur, depth + 1, n.path, ignored);
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
