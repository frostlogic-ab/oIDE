import { useAgents } from '../../stores/agents';

/**
 * Unsent composer text per agent. The Composer remounts when the user switches agents or leaves
 * Focus, so what they typed would be lost; keeping it here (in memory, renderer lifetime) lets it
 * come back. Empty text is never stored.
 */
const drafts = new Map<string, string>();
/** Composers showing an agent's draft, told when it changes from outside (a send that finished after a remount). */
const listeners = new Set<(agentId: string, text: string) => void>();

export function onDraftChange(fn: (agentId: string, text: string) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getDraft(agentId: string): string {
  return drafts.get(agentId) ?? '';
}

export function setDraft(agentId: string, text: string, notify = false): void {
  if (text === '') drafts.delete(agentId);
  else drafts.set(agentId, text);
  if (notify) for (const fn of listeners) fn(agentId, text);
}

export function clearDraft(agentId: string, notify = false): void {
  setDraft(agentId, '', notify);
}

/** Forget every draft (tests: the map is module-level and outlives each render). */
export function resetDrafts(): void {
  drafts.clear();
  listeners.clear();
}

// An agent that is removed or archived leaves the store; its draft goes with it.
useAgents.subscribe((state, prev) => {
  if (drafts.size === 0 || state.byId === prev.byId) return;
  for (const id of Object.keys(prev.byId)) if (!state.byId[id]) drafts.delete(id);
});
