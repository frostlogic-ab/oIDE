import { create } from 'zustand';
import type { Scope } from '@oide/protocol';
import { invokeOr, isNotImplemented, oide } from '../lib/bridge';

/**
 * The shared project scope ("All projects" or one project id). Scopes the Wall, Files and Source
 * control together. Persisted by main (`scope.get` / `scope.set`, broadcast as `scope.changed`).
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

export function connectScope(): () => void {
  return oide.on('scope.changed', (scope) => useScope.getState().apply(scope));
}
