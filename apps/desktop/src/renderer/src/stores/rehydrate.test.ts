import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentSummary, OideBridge } from '@oide/protocol';
import { installFallbackBridge } from '../lib/bridge';
import { agents as fixtures } from '../lib/mock/fixtures';
import { connectAgents, useAgents } from './agents';
import { connectArchive, useArchive } from './archive';

/**
 * Wall rehydration (2026-11-25: a live agent vanished from the Wall after the renderer reloaded):
 * agents.list retries with backoff and reports the failure; summaries for unknown ids add tiles;
 * an archived summary never adds a tile; live summaries that beat the list are kept.
 */

const handlers = new Map<string, Set<(p: unknown) => void>>();
let listImpl: () => Promise<unknown> = async () => [];
const invoke = vi.fn(async (command: string) => {
  if (command === 'agents.list') return listImpl();
  if (command === 'agents.listArchived') return { items: [], total: 0 };
  throw new Error(`[not_implemented] ${command}`);
});
const bridge: OideBridge = {
  invoke: invoke as unknown as OideBridge['invoke'],
  on: ((event: string, fn: (p: unknown) => void) => {
    const set = handlers.get(event) ?? new Set();
    set.add(fn);
    handlers.set(event, set);
    return () => set.delete(fn);
  }) as OideBridge['on'],
  platform: 'win32',
};
const emit = (event: string, payload: unknown) => handlers.get(event)?.forEach((fn) => fn(payload));

const a1 = (patch: Partial<AgentSummary> = {}): AgentSummary => ({ ...structuredClone(fixtures[0]!), ...patch });

let offs: Array<() => void> = [];
beforeEach(() => {
  handlers.clear();
  invoke.mockClear();
  installFallbackBridge(bridge);
  useAgents.setState({ byId: {}, order: [], events: {}, limits: {}, loaded: false, loadError: null, loading: false });
  useArchive.setState({ items: [], total: 0, byId: {}, count: 0, countScope: 'all', scope: 'all', query: '', loaded: false, error: null });
  offs = [connectAgents(), connectArchive()];
});
afterEach(() => {
  offs.forEach((o) => o());
  vi.restoreAllMocks();
});

describe('agents.load', () => {
  it('retries a failing agents.list with backoff, shows the error meanwhile, then rehydrates', async () => {
    let calls = 0;
    listImpl = async () => {
      calls++;
      if (calls < 3) throw new Error('[invalid_output] Handler for agents.list returned invalid output');
      return [a1()];
    };
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const p = useAgents.getState().load({ delays: [150, 150, 150] });
    await vi.waitFor(() => expect(String(useAgents.getState().loadError)).toMatch(/invalid output/));
    expect(useAgents.getState().loading).toBe(true);
    await p;
    expect(calls).toBe(3);
    expect(useAgents.getState()).toMatchObject({ loaded: true, loadError: null, loading: false });
    expect(Object.keys(useAgents.getState().byId)).toEqual([fixtures[0]!.id]);
  });

  it('gives up after the last delay and keeps the error for the Wall (Retry calls load again)', async () => {
    listImpl = async () => {
      throw new Error('[internal] boom');
    };
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await useAgents.getState().load({ delays: [1, 1] });
    expect(invoke.mock.calls.filter(([c]) => c === 'agents.list')).toHaveLength(3);
    expect(useAgents.getState()).toMatchObject({ loadError: 'boom', loading: false, loaded: false });
    listImpl = async () => [a1()];
    await useAgents.getState().load({ delays: [] });
    expect(useAgents.getState().loadError).toBeNull();
  });

  it('keeps summaries that arrived while the list was in flight, and drops agents archived meanwhile', async () => {
    let release!: (v: unknown) => void;
    listImpl = () => new Promise((r) => (release = r));
    const p = useAgents.getState().load();
    const newer = a1({ status: 'needs-permission', updatedAt: Date.now() + 1000 });
    emit('agents.summary', newer);
    const other = { ...a1(), id: 'gone', title: 'Gone' };
    emit('agents.summary', other);
    emit('agents.archived', { ...other, archived: { at: 1, reason: 'archived-by-user', worktreeRemoved: false } });
    release([a1({ status: 'running', updatedAt: 1 }), { ...other, updatedAt: 1 }]);
    await p;
    expect(useAgents.getState().byId[newer.id]!.status).toBe('needs-permission');
    expect(useAgents.getState().byId.gone).toBeUndefined();
  });
});

describe('live events', () => {
  it('an agents.summary for an unknown id adds its tile; an archived one never does', () => {
    emit('agents.summary', a1());
    expect(useAgents.getState().order).toEqual([fixtures[0]!.id]);
    emit('agents.summary', { ...a1(), id: 'x', archived: { at: 1, reason: 'merged', worktreeRemoved: true } });
    expect(useAgents.getState().byId.x).toBeUndefined();
  });

  it('agents.archived moves an agent from the Wall to the archive; a summary after unarchive moves it back', () => {
    emit('agents.summary', a1());
    const archived = { ...a1(), archived: { at: 5, reason: 'archived-by-user' as const, worktreeRemoved: false } };
    emit('agents.archived', archived);
    expect(useAgents.getState().byId[archived.id]).toBeUndefined();
    expect(useArchive.getState().items.map((a) => a.id)).toEqual([archived.id]);
    expect(useArchive.getState()).toMatchObject({ total: 1, count: 1 });
    emit('agents.summary', a1({ status: 'stopped' }));
    expect(useArchive.getState().items).toEqual([]);
    expect(useArchive.getState().count).toBe(0);
    expect(useAgents.getState().byId[archived.id]!.status).toBe('stopped');
    emit('agents.archived', archived);
    emit('agents.removed', { agentId: archived.id });
    expect(useArchive.getState()).toMatchObject({ items: [], total: 0, count: 0 });
  });
});
