import { useEffect } from 'react';
import { create } from 'zustand';
import type { MergePrediction } from '@oide/protocol';
import { ipcErrorMessage, isNotImplemented, oide } from '../lib/bridge';
import { plural } from '../lib/format';

/**
 * Merge predictions per agent (`git.predictMerge`): would merging its branch into the main checkout
 * conflict, and how far behind is it? Review's merge dialog, the Review summary, Wall tiles and
 * Source control read the same entry. Loaded on mount and refreshed (debounced) on `git.changed`
 * for the agent's project; main caches each answer per pair of commits, so a refresh is cheap.
 */
export interface MergePredictionEntry {
  prediction?: MergePrediction;
  loading: boolean;
  error?: string;
}

interface MergePredictionState {
  byAgent: Record<string, MergePredictionEntry>;
  load(agentId: string, opts?: { refresh?: boolean; withMainStatus?: boolean }): Promise<MergePrediction | undefined>;
}

const EMPTY: MergePredictionEntry = { loading: false };
const inflight = new Map<string, Promise<MergePrediction | undefined>>();

export const useMergePredictions = create<MergePredictionState>()((set, get) => ({
  byAgent: {},
  load: (agentId, opts = {}) => {
    const key = `${agentId}:${opts.refresh ? 1 : 0}:${opts.withMainStatus ? 1 : 0}`;
    const running = inflight.get(key);
    if (running) return running;
    const patch = (p: Partial<MergePredictionEntry>) => set({ byAgent: { ...get().byAgent, [agentId]: { ...(get().byAgent[agentId] ?? EMPTY), ...p } } });
    patch({ loading: true });
    const p = (async () => {
      try {
        const prediction = await oide.invoke('git.predictMerge', { agentId, refresh: opts.refresh ?? false, withMainStatus: opts.withMainStatus ?? false });
        // A plain refresh does not drop the main checkout's status a dialog asked for.
        const prev = get().byAgent[agentId]?.prediction;
        const keep = !opts.withMainStatus && prev?.mainDirty && prev.target?.sha === prediction.target?.sha ? { mainDirty: prev.mainDirty } : {};
        patch({ prediction: { ...prediction, ...keep }, loading: false, error: undefined });
        return prediction;
      } catch (err) {
        patch({ loading: false, error: isNotImplemented(err) ? undefined : ipcErrorMessage(err) });
        return undefined;
      }
    })().finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  },
}));

/** One agent's prediction, loaded while `enabled` and refreshed on `git.changed` for its project. */
export function useMergePrediction(agentId: string | undefined, projectId: string | undefined, enabled = true): MergePredictionEntry {
  useEffect(() => {
    if (!agentId || !enabled) return;
    void useMergePredictions.getState().load(agentId);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = oide.on('git.changed', (e) => {
      if (e.projectId !== projectId) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void useMergePredictions.getState().load(agentId), 400);
    });
    return () => {
      if (timer) clearTimeout(timer);
      off();
    };
  }, [agentId, projectId, enabled]);
  return useMergePredictions((s) => (agentId ? s.byAgent[agentId] : undefined) ?? EMPTY);
}


/** The branch name of the merge target, or its short commit on a detached HEAD. */
export function targetName(p: MergePrediction | undefined, fallback: string): string {
  if (!p?.target) return fallback;
  return p.target.branch ?? p.target.sha.slice(0, 7);
}

/**
 * "Up to date with main", "Behind main by 2 commits, would conflict", … (Review, Source control).
 * `short` is the tile's wording. Undefined when there is nothing to say (no branch, still loading).
 */
export function freshnessText(p: MergePrediction | undefined, opts: { short?: boolean } = {}): string | undefined {
  if (!p || p.status === 'unavailable') return undefined;
  const base = targetName(p, 'main');
  const behind = p.behind > 0 ? (opts.short ? `Behind ${base} by ${p.behind}` : `Behind ${base} by ${plural(p.behind, 'commit')}`) : undefined;
  if (p.status === 'conflicts') {
    const files = plural(p.files.length, 'file');
    if (opts.short) return behind ? `${behind} · would conflict` : `Would conflict with ${base}`;
    return behind ? `${behind}, would conflict in ${files}` : `Would conflict with ${base} in ${files}`;
  }
  if (!behind) return `Up to date with ${base}`;
  if (p.status === 'clean') return opts.short ? `${behind} · merges cleanly` : `${behind}, merges cleanly`;
  return behind;
}

/** "a.ts, b.ts, c.ts and 2 more". */
export function fileList(files: readonly string[], max = 3): string {
  if (files.length <= max) return files.join(', ');
  return `${files.slice(0, max).join(', ')} and ${files.length - max} more`;
}
