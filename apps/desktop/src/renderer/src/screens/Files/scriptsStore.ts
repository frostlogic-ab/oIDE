import { create } from 'zustand';
import type { ProjectScript } from '@oide/protocol';
import { invokeOr } from '../../lib/bridge';

/**
 * Files › Run: the run scripts main finds in each shown checkout (`scripts.list`). Loaded when a
 * project's tree shows, and again when the window regains focus or the Run button is pointed at
 * (at most every few seconds), so a script added to package.json shows up without a reload.
 */
const FRESH_MS = 4000;

interface ScriptsState {
  byRoot: Record<string, ProjectScript[]>;
  loadedAt: Record<string, number>;
  load(root: string, force?: boolean): Promise<void>;
}

const inflight = new Map<string, Promise<void>>();

export const useScripts = create<ScriptsState>((set, get) => ({
  byRoot: {},
  loadedAt: {},
  load: (root, force = false) => {
    const at = get().loadedAt[root];
    if (!force && at !== undefined && Date.now() - at < FRESH_MS) return Promise.resolve();
    const running = inflight.get(root);
    if (running) return running;
    const p = invokeOr('scripts.list', { root }, [] as ProjectScript[])
      .catch(() => [] as ProjectScript[])
      .then((list) => {
        const prev = get().byRoot[root];
        const same = prev && prev.length === list.length && prev.every((s, i) => s.id === list[i]?.id && s.command === list[i]?.command);
        set((st) => ({ byRoot: same ? st.byRoot : { ...st.byRoot, [root]: list }, loadedAt: { ...st.loadedAt, [root]: Date.now() } }));
      })
      .finally(() => inflight.delete(root));
    inflight.set(root, p);
    return p;
  },
}));
