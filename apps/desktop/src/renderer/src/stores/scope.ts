import { create } from 'zustand';
import type { Scope } from '@oide/protocol';
import { invokeOr, isNotImplemented, oide } from '../lib/bridge';

/**
 * This window's project scope ("All projects" or one project id). Scopes the Wall, Files and Source
 * control together. Each window has its own (docs/wiki/pages/windows.md); main saves the last choice
 * (`scope.get` / `scope.set`) so new windows and the next launch start on it.
 */
interface ScopeState {
  scope: Scope;
  load(): Promise<void>;
  setScope(scope: Scope): Promise<void>;
  /** Apply a value from main without calling back. */
  apply(scope: Scope): void;
}

export const useScope = create<ScopeState>()((set) => ({
  scope: 'all',
  load: async () => {
    set({ scope: await invokeOr('scope.get', undefined, 'all') });
  },
  setScope: async (scope) => {
    set({ scope }); // optimistic
    try {
      set({ scope: await oide.invoke('scope.set', { scope }) });
    } catch (err) {
      if (!isNotImplemented(err)) throw err;
    }
  },
  apply: (scope) => set({ scope }),
}));

/** A window scoped to a project that was removed (here or in another window) shows all projects again. */
export function connectScope(): () => void {
  return oide.on('projects.changed', (list) => {
    const { scope, apply } = useScope.getState();
    if (scope !== 'all' && !list.some((p) => p.id === scope)) apply('all');
  });
}
