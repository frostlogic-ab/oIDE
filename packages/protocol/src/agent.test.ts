import { describe, expect, it } from 'vitest';
import { AgentSummary, repairAgentSummary } from './agent.js';
import { Commands, Events } from './ipc.js';

const base = { id: 'a1', projectId: 'p1', title: 'T', status: 'running', mode: 'auto', model: 'opus', createdAt: 1, updatedAt: 2 };

describe('repairAgentSummary', () => {
  it('returns a valid summary unchanged', () => {
    const r = repairAgentSummary({ ...base, activity: ['Read x'] });
    expect(r).toEqual({ summary: AgentSummary.parse({ ...base, activity: ['Read x'] }), dropped: [], issues: [] });
  });

  it('drops invalid optional fields and bad list items, keeping the agent', () => {
    const r = repairAgentSummary({
      ...base,
      diff: { files: -2, additions: 1, deletions: 0 },
      contextWindow: 0,
      activity: ['a', null, 'b', 7],
      subagents: [{ id: 's1', agentId: 'a1', name: 'n', task: 't', status: 'running' }, { id: 's2' }],
      pendingPermission: { requestId: 'r' },
    });
    expect(r.summary).toBeDefined();
    expect(r.summary!.activity).toEqual(['a', 'b']);
    expect(r.summary!.subagents.map((s) => s.id)).toEqual(['s1']);
    expect(r.summary!.diff).toBeUndefined();
    expect(r.summary!.pendingPermission).toBeUndefined();
    expect(r.summary!.contextWindow).toBe(200_000);
    expect(r.dropped).toEqual(expect.arrayContaining(['diff', 'contextWindow', 'activity[1]', 'activity[3]', 'subagents[1]', 'pendingPermission']));
    expect(r.issues.length).toBeGreaterThan(0);
  });

  it('cannot invent required fields', () => {
    expect(repairAgentSummary({ ...base, status: 'exploded' }).summary).toBeUndefined();
    expect(repairAgentSummary({ ...base, id: undefined }).summary).toBeUndefined();
    expect(repairAgentSummary('nope').summary).toBeUndefined();
  });
});

describe('archive contract', () => {
  it('accepts archive info and the new commands and event', () => {
    const s = AgentSummary.parse({ ...base, status: 'stopped', archived: { at: 5, reason: 'merged', mergeCommit: 'abc' }, interrupted: { at: 4, reason: 'crash' }, costUsd: 1.5 });
    expect(s.archived).toEqual({ at: 5, reason: 'merged', mergeCommit: 'abc', worktreeRemoved: false });
    expect(() => AgentSummary.parse({ ...base, archived: { at: 5, reason: 'lost' } })).toThrow();
    expect(Commands['agents.listArchived'].input.parse({})).toEqual({ limit: 50 });
    expect(() => Commands['agents.listArchived'].input.parse({ limit: 1000 })).toThrow();
    expect(Commands['agents.deletePermanently'].output.parse({ deleted: true })).toEqual({ deleted: true });
    expect(Events['agents.archived'].parse(s).archived?.reason).toBe('merged');
  });
});
