import { create } from 'zustand';
import type { AgentSummary, ArchiveReason, Scope } from '@oide/protocol';
import { invokeOr, ipcErrorMessage, oide } from '../lib/bridge';
import { toast } from './ui';

/**
 * Archived agents (Wall › Archived, docs/wiki/pages/screen-wall.md#archived-agents): finished,
 * merged, discarded or archived by hand. They are not Wall agents, so they never reach
 * stores/agents.ts and no counter sees them. Main pages them (`agents.listArchived`, newest first);
 * this store holds the pages loaded for one scope and query, plus `count` for the "Archived (N)" tab.
 *
 * Live updates: `agents.archived` adds or updates one, an `agents.summary` for an id held here means
 * it was unarchived (back on the Wall), `agents.removed` means deleted permanently.
 */
export const ARCHIVE_PAGE_SIZE = 50;

export const ARCHIVE_REASON_LABEL: Record<ArchiveReason, string> = {
  merged: 'Merged',
  discarded: 'Discarded',
  completed: 'Completed',
  'archived-by-user': 'Archived',
};

type Cursor = { at: number; id: string };
type Page = { items: AgentSummary[]; total: number; nextCursor?: Cursor };
const EMPTY_PAGE: Page = { items: [], total: 0 };

interface ArchiveState {
  scope: Scope;
  query: string;
  items: AgentSummary[];
  /** Matches for scope + query in all pages. */
  total: number;
  nextCursor?: Cursor;
  loading: boolean;
  loaded: boolean;
  error: string | null;
  /** Archived agents in `countScope` (the toggle's N), whatever the query. */
  count: number;
  countScope: Scope | null;
  /** Archived agents fetched by id (Focus opens one read-only). */
  byId: Record<string, AgentSummary>;
  /** First page for a scope and query (replaces what is held). */
  load(scope: Scope, query?: string): Promise<void>;
  /** The next page, if any. */
  loadMore(): Promise<void>;
  refreshCount(scope: Scope): Promise<void>;
  /** One archived agent (from the list, or `agents.getArchived`). Undefined when it is not archived. */
  fetchOne(agentId: string): Promise<AgentSummary | undefined>;
  upsert(summary: AgentSummary): void;
  drop(agentId: string): void;
}

let generation = 0;

const inScope = (a: AgentSummary, scope: Scope | null) => scope === 'all' || a.projectId === scope;
const matches = (a: AgentSummary, query: string) => !query.trim() || a.title.toLowerCase().includes(query.trim().toLowerCase());
const newestFirst = (a: AgentSummary, b: AgentSummary) => (b.archived?.at ?? 0) - (a.archived?.at ?? 0) || (b.id < a.id ? -1 : b.id > a.id ? 1 : 0);

export const useArchive = create<ArchiveState>()((set, get) => ({
  scope: 'all',
  query: '',
  items: [],
  total: 0,
  loading: false,
  loaded: false,
  error: null,
  count: 0,
  countScope: null,
  byId: {},
  load: async (scope, query = '') => {
    const gen = ++generation;
    set({ scope, query, loading: true, error: null });
    try {
      const page = await invokeOr('agents.listArchived', { ...(scope === 'all' ? {} : { projectId: scope }), ...(query.trim() ? { query: query.trim() } : {}), limit: ARCHIVE_PAGE_SIZE }, EMPTY_PAGE);
      if (gen !== generation) return;
      const byId = { ...get().byId };
      for (const a of page.items) byId[a.id] = a;
      set({ items: page.items, total: page.total, nextCursor: page.nextCursor, loading: false, loaded: true, byId, ...(query.trim() ? {} : { count: page.total, countScope: scope }) });
    } catch (err) {
      if (gen !== generation) return;
      set({ loading: false, loaded: true, error: ipcErrorMessage(err) });
    }
  },
  loadMore: async () => {
    const { nextCursor, loading, scope, query } = get();
    if (!nextCursor || loading) return;
    const gen = generation;
    set({ loading: true });
    try {
      const page = await invokeOr('agents.listArchived', { ...(scope === 'all' ? {} : { projectId: scope }), ...(query.trim() ? { query: query.trim() } : {}), limit: ARCHIVE_PAGE_SIZE, cursor: nextCursor }, EMPTY_PAGE);
      if (gen !== generation) return;
      const have = new Set(get().items.map((a) => a.id));
      const byId = { ...get().byId };
      for (const a of page.items) byId[a.id] = a;
      set({ items: [...get().items, ...page.items.filter((a) => !have.has(a.id))], total: page.total, nextCursor: page.nextCursor, loading: false, byId });
    } catch (err) {
      if (gen !== generation) return;
      set({ loading: false, error: ipcErrorMessage(err) });
    }
  },
  refreshCount: async (scope) => {
    try {
      const page = await invokeOr('agents.listArchived', { ...(scope === 'all' ? {} : { projectId: scope }), limit: 1 }, EMPTY_PAGE);
      set({ count: page.total, countScope: scope });
    } catch {
      /* the tab keeps its last count */
    }
  },
  fetchOne: async (agentId) => {
    const held = get().byId[agentId];
    if (held) return held;
    try {
      const a = await oide.invoke('agents.getArchived', { agentId });
      set({ byId: { ...get().byId, [a.id]: a } });
      return a;
    } catch {
      return undefined;
    }
  },
  upsert: (summary) => {
    if (!summary.archived) return;
    const s = get();
    const known = s.items.some((a) => a.id === summary.id);
    const byId = { ...s.byId, [summary.id]: summary };
    const fits = inScope(summary, s.scope) && matches(summary, s.query);
    let items = s.items;
    let total = s.total;
    if (known) items = fits ? s.items.map((a) => (a.id === summary.id ? summary : a)) : s.items.filter((a) => a.id !== summary.id);
    else if (fits) items = [...s.items, summary].sort(newestFirst);
    if (!known && fits) total++;
    if (known && !fits) total = Math.max(0, total - 1);
    const wasCounted = Boolean(s.byId[summary.id]) && inScope(s.byId[summary.id]!, s.countScope);
    const count = !wasCounted && inScope(summary, s.countScope) ? s.count + 1 : s.count;
    set({ items, total, byId, count });
  },
  drop: (agentId) => {
    const s = get();
    const held = s.byId[agentId];
    const listed = s.items.some((a) => a.id === agentId);
    if (!held && !listed) return;
    const byId = { ...s.byId };
    delete byId[agentId];
    set({
      byId,
      items: listed ? s.items.filter((a) => a.id !== agentId) : s.items,
      total: listed ? Math.max(0, s.total - 1) : s.total,
      count: held && inScope(held, s.countScope) ? Math.max(0, s.count - 1) : s.count,
    });
  },
}));

/** Subscribe to main's agent events. Returns an unsubscribe. */
export function connectArchive(): () => void {
  const offs = [
    oide.on('agents.archived', (s) => useArchive.getState().upsert(s)),
    // Unarchived: it is a Wall agent again.
    oide.on('agents.summary', (s) => {
      if (!s.archived && useArchive.getState().byId[s.id]) useArchive.getState().drop(s.id);
    }),
    oide.on('agents.removed', ({ agentId }) => useArchive.getState().drop(agentId)),
  ];
  return () => offs.forEach((off) => off());
}

// ---------- actions (toast on failure) ----------

export async function archiveAgent(agentId: string, title: string): Promise<boolean> {
  try {
    const s = await oide.invoke('agents.archive', { agentId });
    useArchive.getState().upsert(s);
    toast(`Archived "${title}"`, 'info');
    return true;
  } catch (err) {
    toast(`Could not archive: ${ipcErrorMessage(err)}`, 'error');
    return false;
  }
}

export async function unarchiveAgent(agentId: string, title: string): Promise<AgentSummary | undefined> {
  try {
    const s = await oide.invoke('agents.unarchive', { agentId });
    useArchive.getState().drop(agentId);
    toast(s.resumeBlocked ? `"${title}" is back on the Wall. It cannot be resumed: its worktree was deleted.` : `"${title}" is back on the Wall`, 'info', { agentId });
    return s;
  } catch (err) {
    toast(`Could not unarchive: ${ipcErrorMessage(err)}`, 'error');
    return undefined;
  }
}

/** Main asks for confirmation natively; false when the user cancelled or it failed. */
export async function deleteAgentPermanently(agentId: string): Promise<boolean> {
  try {
    const r = await oide.invoke('agents.deletePermanently', { agentId });
    if (r.deleted) useArchive.getState().drop(agentId);
    return r.deleted;
  } catch (err) {
    toast(`Could not delete: ${ipcErrorMessage(err)}`, 'error');
    return false;
  }
}

/** "4 Nov 2026, 3:12 PM" (today: "Today, 3:12 PM"). */
export function formatEnded(ts: number, now = Date.now()): string {
  const d = new Date(ts);
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const today = new Date(now);
  if (d.toDateString() === today.toDateString()) return `Today, ${time}`;
  const opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', ...(d.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}) };
  return `${d.toLocaleDateString(undefined, opts)}, ${time}`;
}

/** "$0.42", "<$0.01"; undefined when the CLI reported no cost. */
export function formatCost(usd: number | undefined): string | undefined {
  if (usd === undefined) return undefined;
  if (usd > 0 && usd < 0.01) return '<$0.01';
  return `$${usd.toFixed(2)}`;
}
