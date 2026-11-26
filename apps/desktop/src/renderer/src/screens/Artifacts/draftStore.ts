import { create } from 'zustand';

/**
 * Unsaved edits to an artifact's entry (docs, designs, whiteboards), kept outside the Viewer so
 * they survive leaving the Artifacts screen (left rail, Ctrl+K, a toast action: the screen
 * unmounts, and its local state with it). Mirrors how the Files screen keeps `dirty` in its store.
 *
 * The Viewer writes here on every change while it has unsaved edits, and clears it on save, "Use
 * theirs" and Discard. When the screen mounts again it reopens the artifact with the most recent
 * draft in the Viewer. Edits to another file of a multi-file artifact are not kept (they live in
 * the Files panel's own state).
 */
export interface ArtifactDraft {
  /** The saved version the draft was started from. */
  baseVersion: number;
  /** That version's entry content (what Compare and a later conflict start from). */
  baseContent: string;
  /** What "unchanged" looked like (whiteboards: Excalidraw's own serialisation of the base). */
  baseline: string;
  draft: string;
  /** When the draft last changed (the latest one is the one resumed). */
  at: number;
}

interface DraftState {
  drafts: Record<string, ArtifactDraft>;
  set: (id: string, d: Omit<ArtifactDraft, 'at'>) => void;
  clear: (id: string) => void;
  /** Drop drafts of artifacts that no longer exist. */
  prune: (existing: ReadonlySet<string>) => void;
  reset: () => void;
}

export const useArtifactDrafts = create<DraftState>((set) => ({
  drafts: {},
  set: (id, d) =>
    set((s) => {
      const prev = s.drafts[id];
      if (prev && prev.draft === d.draft && prev.baseVersion === d.baseVersion && prev.baseline === d.baseline && prev.baseContent === d.baseContent) return s;
      return { drafts: { ...s.drafts, [id]: { ...d, at: Date.now() } } };
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
  reset: () => set({ drafts: {} }),
}));

/** The artifact with the most recently edited draft, if any. */
export function latestDraftId(drafts: Record<string, ArtifactDraft>): string | undefined {
  let best: string | undefined;
  for (const [id, d] of Object.entries(drafts)) if (!best || d.at >= drafts[best]!.at) best = id;
  return best;
}
