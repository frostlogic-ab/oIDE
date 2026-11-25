import { create } from 'zustand';

/**
 * Wall-only UI state: the filter chip, the focused tile (J / K / N, Y / D act on it), tiles to
 * highlight after a spawn, and the agent whose "Compact this session?" confirm is open.
 * Agent data itself lives in stores/agents; this store never copies it.
 */
export type WallFilter = 'all' | 'needs' | 'running' | 'review';
/** Active: the tile grid. Archived: finished, merged, discarded and hand-archived agents (a list). */
export type WallView = 'active' | 'archived';

export const HIGHLIGHT_MS = 6000;

interface WallState {
  view: WallView;
  /** Search text of the Archived view. */
  archiveQuery: string;
  filter: WallFilter;
  focusedId: string | null;
  highlighted: Record<string, true>;
  compactFor: string | null;
  setView(view: WallView): void;
  setArchiveQuery(query: string): void;
  setFilter(filter: WallFilter): void;
  setFocused(id: string | null): void;
  /** Highlight tiles (new agents from Spawn); the first one gets focus. Clears after HIGHLIGHT_MS. */
  highlight(ids: string[]): void;
  clearHighlight(): void;
  openCompact(agentId: string): void;
  closeCompact(): void;
}

let highlightTimer: ReturnType<typeof setTimeout> | undefined;

export const useWall = create<WallState>()((set) => ({
  view: 'active',
  archiveQuery: '',
  filter: 'all',
  focusedId: null,
  highlighted: {},
  compactFor: null,
  setView: (view) => set((s) => (s.view === view ? s : { view, focusedId: null })),
  setArchiveQuery: (archiveQuery) => set({ archiveQuery }),
  setFilter: (filter) => set({ filter }),
  setFocused: (focusedId) => set((s) => (s.focusedId === focusedId ? s : { focusedId })),
  highlight: (ids) => {
    if (highlightTimer) clearTimeout(highlightTimer);
    set({ highlighted: Object.fromEntries(ids.map((id) => [id, true as const])), focusedId: ids[0] ?? null, filter: 'all', view: 'active' });
    highlightTimer = setTimeout(() => set({ highlighted: {} }), HIGHLIGHT_MS);
  },
  clearHighlight: () => set({ highlighted: {} }),
  openCompact: (compactFor) => set({ compactFor }),
  closeCompact: () => set({ compactFor: null }),
}));

/** Non-hook helper for Spawn: highlight the new tiles on the Wall. */
export function highlightTiles(ids: string[]): void {
  useWall.getState().highlight(ids);
}
