import { beforeEach, describe, expect, it } from 'vitest';
import type { AgentEvent } from '@oide/protocol';
import { MAX_EVENTS_PER_AGENT, MAX_RETAINED_EVENTS, useAgents } from './agents';
import { panelReloading, useExtensionHosts } from './extensionHosts';
import { useUi } from './ui';

const ev = (seq: number, agentId = 'a1'): AgentEvent => ({ type: 'status', status: 'running', agentId, seq, ts: seq }) as unknown as AgentEvent;
const range = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => ev(from + i));

beforeEach(() => {
  useAgents.setState({ byId: {}, order: [], events: {}, limits: {}, loaded: true });
  useExtensionHosts.setState({ byName: {} });
  useUi.setState({ toasts: [] });
});

describe('bounded agent event buffers (renderer memory)', () => {
  it('keeps only the live tail per agent', () => {
    useAgents.getState().applyBatch(range(0, MAX_EVENTS_PER_AGENT + 500));
    const list = useAgents.getState().events.a1!;
    expect(list).toHaveLength(MAX_EVENTS_PER_AGENT);
    expect(list[0]!.seq).toBe(500);
  });

  it('paged-in history survives new live events, up to MAX_RETAINED_EVENTS, and is released on close', () => {
    const s = useAgents.getState();
    s.applyBatch(range(9000, 9100));
    s.prependHistory('a1', range(5000, 9000));
    expect(useAgents.getState().events.a1).toHaveLength(4100);
    useAgents.getState().applyBatch(range(9100, 9110)); // live events must not cut the history
    expect(useAgents.getState().events.a1).toHaveLength(4110);
    useAgents.getState().prependHistory('a1', range(-1000, 5000));
    expect(useAgents.getState().events.a1).toHaveLength(MAX_RETAINED_EVENTS);
    expect(useAgents.getState().events.a1!.at(-1)!.seq).toBe(9109); // newest kept
    useAgents.getState().releaseHistory('a1');
    expect(useAgents.getState().events.a1).toHaveLength(MAX_EVENTS_PER_AGENT);
    expect(useAgents.getState().limits.a1).toBeUndefined();
  });

  it('remove drops events and limits', () => {
    useAgents.getState().prependHistory('a1', range(0, 10));
    useAgents.getState().remove('a1');
    expect(useAgents.getState().events.a1).toBeUndefined();
    expect(useAgents.getState().limits.a1).toBeUndefined();
  });
});

describe('extension host crash handling (client side)', () => {
  it('marks panels reloading, toasts once, and clears when the host is back', () => {
    const apply = useExtensionHosts.getState().apply;
    apply({ name: 'git', state: 'running', panelIds: ['git.panel'] });
    apply({ name: 'git', state: 'reloading', panelIds: ['git.panel'], error: 'exit code 7' });
    apply({ name: 'git', state: 'reloading', panelIds: ['git.panel'], error: 'exit code 7' });
    expect(panelReloading(useExtensionHosts.getState().byName, 'git.panel')).toBe(true);
    expect(panelReloading(useExtensionHosts.getState().byName, 'other.panel')).toBe(false);
    apply({ name: 'git', state: 'running', panelIds: ['git.panel'] });
    expect(panelReloading(useExtensionHosts.getState().byName, 'git.panel')).toBe(false);
    const toasts = useUi.getState().toasts.map((t) => `${t.level}:${t.message}`);
    expect(toasts).toHaveLength(2);
    expect(toasts[0]).toMatch(/^warning:Extension git stopped unexpectedly; restarting/);
    expect(toasts[1]).toMatch(/^success:Extension git is running again/);
    apply({ name: 'git', state: 'failed', panelIds: ['git.panel'], error: 'crashed 6 times' });
    expect(useUi.getState().toasts.at(-1)!.level).toBe('error');
  });
});
