import { create } from 'zustand';

/**
 * Wall-only UI state: the filter chip, the focused tile (J / K / N, Y / D act on it), tiles to
 * highlight after a spawn, and the agent whose "Compact this session?" confirm is open.
 * Agent data itself lives in stores/agents; this store never copies it.
 */
export type WallFilter = 'all' | 'needs' | 'running' | 'review';

export const HIGHLIGHT_MS = 6000;

interface WallState {
  filter: WallFilter;
  focusedId: string | null;
  highlighted: Record<string, true>;
  compactFor: string | null;
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
  filter: 'all',
  focusedId: null,
  highlighted: {},
  compactFor: null,
  setFilter: (filter) => set({ filter }),
  setFocused: (focusedId) => set((s) => (s.focusedId === focusedId ? s : { focusedId })),
  highlight: (ids) => {
    if (highlightTimer) clearTimeout(highlightTimer);
    set({ highlighted: Object.fromEntries(ids.map((id) => [id, true as const])), focusedId: ids[0] ?? null, filter: 'all' });
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
