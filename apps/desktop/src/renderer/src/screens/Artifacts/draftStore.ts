import { create } from 'zustand';

/**
 * Unsaved edits to an artifact's entry (docs, designs, whiteboards), kept outside the Viewer so
 * they survive leaving the Artifacts screen (left rail, Ctrl+K, a toast action: the screen
 * unmounts, and its local state with it). Mirrors how the Files screen keeps `dirty` in its store.
 *
 * The Viewer writes here on every change while it has unsaved edits, and clears it on save, "Use
 * theirs" and Discard. "Keep as draft" (back to the grid) leaves it here and the grid card shows
 * Unsaved. When the screen mounts again it reopens the Viewer on the artifact the route names, or
 * (the rail and Ctrl+K carry no artifact) on `lastOpenId`, the one whose Viewer was open when the
 * screen was left; closing the Viewer to the grid forgets it. Edits to another file of a multi-file
 * artifact are not kept (they live in the Files panel's own state).
 */
export interface ArtifactDraft {
  /** The saved version the draft was started from. */
  baseVersion: number;
  /** That version's entry content (what Compare and a later conflict start from). */
  baseContent: string;
  /** What "unchanged" looked like (whiteboards: Excalidraw's own serialisation of the base). */
  baseline: string;
  /** The entry file the draft text belongs to; a draft whose artifact now opens on another file is dropped. */
  entry: string;
  draft: string;
}

interface DraftState {
  drafts: Record<string, ArtifactDraft>;
  /** The artifact whose Viewer was open when the screen last unmounted (null once closed to the grid). */
  lastOpenId: string | null;
  setLastOpen: (id: string | null) => void;
  set: (id: string, d: ArtifactDraft) => void;
  clear: (id: string) => void;
  /** Drop drafts of artifacts that no longer exist. */
  prune: (existing: ReadonlySet<string>) => void;
  reset: () => void;
}

export const useArtifactDrafts = create<DraftState>((set) => ({
  drafts: {},
  lastOpenId: null,
  setLastOpen: (id) => set((s) => (s.lastOpenId === id ? s : { lastOpenId: id })),
  set: (id, d) =>
    set((s) => {
      const prev = s.drafts[id];
      if (prev && prev.draft === d.draft && prev.baseVersion === d.baseVersion && prev.baseline === d.baseline && prev.baseContent === d.baseContent && prev.entry === d.entry) return s;
      return { drafts: { ...s.drafts, [id]: d } };
    }),
  clear: (id) =>
    set((s) => {
      if (!(id in s.drafts)) return s;
      const { [id]: _gone, ...rest } = s.drafts;
      return { drafts: rest };
    }),
  prune: (existing) =>
    set((s) => {
      const keep = Object.entries(s.drafts).filter(([id]) => existing.has(id));
      return keep.length === Object.keys(s.drafts).length ? s : { drafts: Object.fromEntries(keep) };
    }),
  reset: () => set({ drafts: {}, lastOpenId: null }),
}));

/** The ids that have a draft, sorted: a stable string to subscribe to (no re-render per keystroke). */
export const draftIdsKey = (s: DraftState): string => Object.keys(s.drafts).sort().join(',');
