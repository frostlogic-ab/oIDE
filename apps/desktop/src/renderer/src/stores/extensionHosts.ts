import { create } from 'zustand';
import type { EventPayload } from '@oide/protocol';
import { oide } from '../lib/bridge';
import { toast } from './ui';

/**
 * Extension host process state from main (`extensions.hostState`). When a host crashes, main
 * restarts it with backoff and sends `reloading`; panels of that extension read
 * `usePanelReloading(panelId)` to show "Reloading…" instead of a dead iframe. The user hears about
 * a crash once (and when it is back, or when main gives up after repeated crashes).
 */
export type HostState = EventPayload<'extensions.hostState'>['state'];

interface HostsState {
  byName: Record<string, { state: HostState; panelIds: string[]; error?: string }>;
  apply(e: EventPayload<'extensions.hostState'>): void;
}

export const useExtensionHosts = create<HostsState>()((set, get) => ({
  byName: {},
  apply: (e) => {
    const prev = get().byName[e.name]?.state;
    set({ byName: { ...get().byName, [e.name]: { state: e.state, panelIds: e.panelIds, ...(e.error ? { error: e.error } : {}) } } });
    if (e.state === 'reloading' && prev !== 'reloading') toast(`Extension ${e.name} stopped unexpectedly; restarting it. Agents are not affected.`, 'warning');
    else if (e.state === 'running' && prev === 'reloading') toast(`Extension ${e.name} is running again.`, 'success');
    else if (e.state === 'failed' && prev !== 'failed') toast(`Extension ${e.name} keeps crashing and was turned off until oIDE restarts${e.error ? ` (${e.error})` : ''}.`, 'error');
  },
}));

/** Pure: is this panel's extension restarting? */
export function panelReloading(byName: HostsState['byName'], panelId: string): boolean {
  return Object.values(byName).some((h) => (h.state === 'reloading' || h.state === 'starting') && h.panelIds.includes(panelId));
}

export function usePanelReloading(panelId: string): boolean {
  return useExtensionHosts((s) => panelReloading(s.byName, panelId));
}

export function connectExtensionHosts(): () => void {
  return oide.on('extensions.hostState', (e) => useExtensionHosts.getState().apply(e));
}
