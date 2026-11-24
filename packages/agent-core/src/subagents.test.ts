import { describe, expect, it } from 'vitest';
import type { AgentEvent, AgentEventDraft } from '@oide/protocol';
import { fixtureEvents } from '../test/helpers.js';
import { SubagentTracker } from './subagents.js';

let seq = 0;
const ev = (d: AgentEventDraft): AgentEvent => ({ ...d, agentId: 'a1', seq: seq++, ts: 100 + seq }) as AgentEvent;

describe('SubagentTracker', () => {
  it('real async subagent: queued → running → done, transcript, usage, report from task_notification', () => {
    const t = new SubagentTracker('agent-1', { tiers: { 'simple-task': { tier: 'simple', model: 'haiku', effort: 'low' } } });
    const statuses: string[] = [];
    for (const e of fixtureEvents('real-subagent.jsonl')) for (const s of t.onEvent(e)) if (statuses.at(-1) !== s.status) statuses.push(s.status);
    expect(statuses).toEqual(['queued', 'running', 'done']);
    const [sub] = t.list();
    expect(sub!.subagentType).toBe('simple-task');
    expect(sub!.tier).toBe('simple');
    expect(sub!.model).toBe('haiku');
    expect(sub!.effort).toBe('low');
    expect(sub!.name).toBe('Read README first line and mkdir');
    expect(sub!.report).toContain('oide-fixture first line');
    expect(sub!.usage!.cacheCreation).toBeGreaterThan(0);
    expect(sub!.contextUsed).toBeGreaterThan(0);
    expect(sub!.startedAt).toBeDefined();
    expect(sub!.endedAt).toBeDefined();
    const transcript = t.transcript(sub!.id);
    expect(transcript.filter((e) => e.type === 'tool-use').map((e) => (e as { name: string }).name)).toEqual(['Read', 'Bash']);
    // The denied Bash call inside the subagent is attributed to it (permission prompt carries this tool_use_id).
    const bash = transcript.find((e) => e.type === 'tool-use' && e.name === 'Bash') as { toolUseId: string };
    expect(t.ownerOfToolUse(bash.toolUseId)).toBe(sub!.id);
    expect(t.ownerOfToolUse('toolu_unknown')).toBeUndefined();
  });

  it('foreground subagent: report is the Task tool_result; permission and stop', () => {
    const t = new SubagentTracker('a1');
    t.onEvent(ev({ type: 'tool-use', toolUseId: 'task1', name: 'Task', input: { subagent_type: 'general-purpose', description: 'Explore', prompt: 'Look around' } }));
    expect(t.get('task1')!.status).toBe('queued');
    expect(t.get('task1')!.tier).toBe('custom');
    t.onEvent(ev({ type: 'tool-use', toolUseId: 'r1', name: 'Read', input: {}, parentToolUseId: 'task1' }));
    expect(t.get('task1')!.status).toBe('running');
    expect(t.setNeedsPermission('task1', true)!.status).toBe('needs-permission');
    expect(t.counts()).toEqual({ total: 1, running: 0, needsYou: 1, done: 0 });
    expect(t.setNeedsPermission('task1', false)!.status).toBe('running');
    t.onEvent(ev({ type: 'usage', messageId: 'm1', usage: { input: 10, output: 10, cacheRead: 0, cacheCreation: 0 }, parentToolUseId: 'task1' }));
    t.onEvent(ev({ type: 'usage', messageId: 'm1', usage: { input: 10, output: 10, cacheRead: 0, cacheCreation: 0 }, parentToolUseId: 'task1' }));
    expect(t.tokenShare({ input: 40, output: 20, cacheRead: 0, cacheCreation: 0 })).toBeCloseTo(0.25);
    expect(t.requestStop('task1')).toBe(true);
    expect(t.isStopRequested('task1')).toBe(true);
    t.onEvent(ev({ type: 'tool-result', toolUseId: 'task1', isError: false, content: 'Found 3 files' }));
    expect(t.get('task1')).toMatchObject({ status: 'stopped', report: 'Found 3 files' });
  });

  it('exit stops anything still running', () => {
    const t = new SubagentTracker('a1');
    t.onEvent(ev({ type: 'tool-use', toolUseId: 'x', name: 'Agent', input: { description: 'd' } }));
    t.onEvent(ev({ type: 'exit', code: 1, signal: null }));
    expect(t.get('x')!.status).toBe('stopped');
  });
});
