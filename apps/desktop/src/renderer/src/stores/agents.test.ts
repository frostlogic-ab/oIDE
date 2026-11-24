import { describe, expect, it } from 'vitest';
import { agents as fixtureAgents } from '../lib/mock/fixtures';
import { agentsInScope, countAgents, MAX_EVENTS_PER_AGENT, nextNeedsYou, stepAgent, useAgents } from './agents';

describe('agent selectors (design fixtures)', () => {
  const byId = Object.fromEntries(fixtureAgents.map((a) => [a.id, a]));
  const order = fixtureAgents.map((a) => a.id);

  it('scopes by project', () => {
    expect(agentsInScope(byId, order, 'all')).toHaveLength(6);
    expect(agentsInScope(byId, order, 'billing-api').map((a) => a.id)).toEqual(['a-webhook', 'a-invoice']);
  });

  it('counts like the canvas header (running, needs you, review)', () => {
    const c = countAgents(fixtureAgents);
    expect(c).toMatchObject({ total: 6, running: 3, needsYou: 2, review: 1 });
    expect(c.subagentsActive).toBeGreaterThan(0);
  });

  it('N jumps to the next agent that needs you, wrapping', () => {
    expect(nextNeedsYou(fixtureAgents)?.id).toBe('a-bridge');
    expect(nextNeedsYou(fixtureAgents, 'a-bridge')?.id).toBe('a-invoice');
    expect(nextNeedsYou(fixtureAgents, 'a-invoice')?.id).toBe('a-bridge');
  });

  it('J/K step with wrap-around', () => {
    expect(stepAgent(fixtureAgents, 'a-docs', 1)?.id).toBe('a-shell');
    expect(stepAgent(fixtureAgents, 'a-shell', -1)?.id).toBe('a-docs');
    expect(stepAgent([], undefined, 1)).toBeUndefined();
  });
});

describe('useAgents store', () => {
  it('applies summaries and batches, capping the live tail', () => {
    const s = useAgents.getState();
    s.applySummary(fixtureAgents[0]!);
    expect(useAgents.getState().order).toEqual([fixtureAgents[0]!.id]);
    const events = Array.from({ length: MAX_EVENTS_PER_AGENT + 10 }, (_, i) => ({ type: 'stderr' as const, agentId: 'a-shell', seq: i, ts: i, text: 'x' }));
    s.applyBatch([...events, { type: 'partial', agentId: 'a-shell', seq: 99999, ts: 0, kind: 'text', delta: 'h' }]);
    const tail = useAgents.getState().events['a-shell']!;
    expect(tail).toHaveLength(MAX_EVENTS_PER_AGENT);
    expect(tail[0]!.seq).toBe(10);
    s.prependHistory('a-shell', [{ type: 'stderr', agentId: 'a-shell', seq: 3, ts: 0, text: 'old' }]);
    expect(useAgents.getState().events['a-shell']![0]!.seq).toBe(3);
    s.remove('a-shell');
    expect(useAgents.getState().byId['a-shell']).toBeUndefined();
  });
});
