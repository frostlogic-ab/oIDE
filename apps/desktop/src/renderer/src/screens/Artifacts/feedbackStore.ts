import { create } from 'zustand';
import { nextPinNumber, type FeedbackPin } from './model';

/**
 * The open view's working state that outlives one Viewer (in memory only, like draftStore.ts):
 * - `pins`: preview comments not sent yet, per artifact id (point and comment). Leaving the screen
 *   or closing the Viewer keeps them; sending removes the sent ones.
 * - `panelOpen`: whether the Agent panel is shown or collapsed to its strip (all artifacts).
 * - `view`: Preview or Code, the content pane's last choice for docs and designs.
 */
export type ContentView = 'preview' | 'code';

interface FeedbackState {
  pins: Record<string, FeedbackPin[]>;
  panelOpen: boolean;
  view: ContentView;
  setPanelOpen: (open: boolean) => void;
  setView: (view: ContentView) => void;
  /** Adds a pin with the next marker number; returns it. */
  add: (artifactId: string, pin: Omit<FeedbackPin, 'id' | 'n' | 'checked'>) => FeedbackPin;
  update: (artifactId: string, id: string, patch: Partial<Pick<FeedbackPin, 'comment' | 'checked'>>) => void;
  remove: (artifactId: string, ids: readonly string[]) => void;
  reset: () => void;
}

const NONE: FeedbackPin[] = [];
let seq = 0;

export const useArtifactFeedback = create<FeedbackState>((set, get) => ({
  pins: {},
  panelOpen: true,
  view: 'preview',
  setPanelOpen: (panelOpen) => set({ panelOpen }),
  setView: (view) => set({ view }),
  add: (artifactId, pin) => {
    const list = get().pins[artifactId] ?? NONE;
    const next: FeedbackPin = { ...pin, id: `pin-${++seq}`, n: nextPinNumber(list), checked: true };
    set((s) => ({ pins: { ...s.pins, [artifactId]: [...list, next] } }));
    return next;
  },
  update: (artifactId, id, patch) =>
    set((s) => {
      const list = s.pins[artifactId];
      if (!list) return s;
      return { pins: { ...s.pins, [artifactId]: list.map((p) => (p.id === id ? { ...p, ...patch } : p)) } };
    }),
  remove: (artifactId, ids) =>
    set((s) => {
      const list = s.pins[artifactId];
      if (!list) return s;
      const rest = list.filter((p) => !ids.includes(p.id));
      if (rest.length) return { pins: { ...s.pins, [artifactId]: rest } };
      const { [artifactId]: _gone, ...others } = s.pins;
      return { pins: others };
    }),
  reset: () => set({ pins: {}, panelOpen: true, view: 'preview' }),
}));

/** An artifact's pins (a stable empty list when there are none). */
export function usePins(artifactId: string): FeedbackPin[] {
  return useArtifactFeedback((s) => s.pins[artifactId] ?? NONE);
}
