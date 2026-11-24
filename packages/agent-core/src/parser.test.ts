import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AgentEvent } from '@oide/protocol';
import { FIXTURES, fixture } from '../test/helpers.js';
import { parseLine, parseTranscript } from './parser.js';

const byType = <T extends string>(events: Array<{ type: string }>, t: T) => events.filter((e) => e.type === t) as Array<Extract<ReturnType<typeof parseTranscript>[number], { type: T }>>;

describe('parser against real CLI 2.1.325 recordings', () => {
  it('parses every fixture line without throwing and every event is schema-valid', () => {
    for (const f of readdirSync(FIXTURES).filter((n) => n.startsWith('real-') && n.endsWith('.jsonl'))) {
      const drafts = parseTranscript(fixture(f));
      for (const [i, d] of drafts.entries()) {
        const r = AgentEvent.safeParse({ ...d, agentId: 'a', seq: i, ts: 0 });
        expect(r.success, `${f} event ${i} ${d.type}`).toBe(true);
      }
    }
  });

  it('basic multi-turn session: init, partials, text, tool use, usage, results, controls, compact', () => {
    const ev = parseTranscript(fixture('real-basic-multiturn.jsonl'));
    const init = byType(ev, 'init')[0]!;
    expect(init.sessionId).toBe('11111111-2222-4333-8444-555555555555');
    expect(init.model).toBe('claude-haiku-5-5');
    expect(init.permissionMode).toBe('auto');
    expect(init.cliVersion).toBe('2.1.325');
    expect(init.slashCommands).toEqual(['compact', 'context', 'init']);
    expect(byType(ev, 'partial').some((p) => p.kind === 'text' && p.delta === 'hello')).toBe(true);
    expect(byType(ev, 'partial').some((p) => p.kind === 'tool-input')).toBe(true);
    expect(byType(ev, 'assistant-text').map((t) => t.text)).toContain('hello');
    const read = byType(ev, 'tool-use').find((t) => t.name === 'Read')!;
    expect(read).toBeDefined();
    const res = byType(ev, 'tool-result').find((t) => t.toolUseId === read.toolUseId)!;
    expect(res.content).toContain('oide-fixture first line');
    const usage = byType(ev, 'usage')[0]!;
    expect(usage.usage.cacheCreation).toBe(37555);
    const results = byType(ev, 'result');
    expect(results).toHaveLength(4);
    expect(results[0]!.text).toBe('hello');
    expect(results[0]!.contextWindow).toBe(1_000_000);
    expect(results[2]!.subtype).toBe('error_during_execution'); // the interrupted turn
    expect(results[3]!.localCommand).toBe('compact');
    expect(byType(ev, 'mode-changed')[0]!.mode).toBe('plan');
    expect(byType(ev, 'compact').map((c) => c.phase)).toEqual(['started', 'done']);
    expect(byType(ev, 'compact')[1]!.postTokens).toBe(21864);
    const plan = byType(ev, 'plan-usage')[0]!;
    expect(plan.status).toBe('allowed');
    expect(plan.utilization).toBe(0.65);
    expect(plan.resetsAt).toBe(1795568400_000);
    expect(byType(ev, 'unknown')).toHaveLength(0);
  });

  it('init slash_commands: strings only, leading slash dropped, de-duplicated; a bad list is ignored', () => {
    const init = (extra: Record<string, unknown>) =>
      parseLine(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's', ...extra })).events[0] as Extract<ReturnType<typeof parseTranscript>[number], { type: 'init' }>;
    expect(init({ slash_commands: ['compact', '/review', 'compact', 3, ''] }).slashCommands).toEqual(['compact', 'review']);
    expect(init({ slash_commands: 'compact' }).type).toBe('init');
    expect(init({ slash_commands: 'compact' }).slashCommands).toBeUndefined();
    expect(init({}).slashCommands).toBeUndefined();
  });

  it('control responses are surfaced, not turned into events', () => {
    const lines = fixture('real-basic-multiturn.jsonl').split('\n').filter((l) => l.includes('"control_response"'));
    expect(lines).toHaveLength(2);
    const p = parseLine(lines[0]!);
    expect(p.events).toEqual([]);
    expect(p.control?.response.request_id).toBe('req-mode-1');
    expect(p.control?.response.subtype).toBe('success');
  });

  it('subagent session: parent_tool_use_id on subagent events, task lifecycle, deny result', () => {
    const ev = parseTranscript(fixture('real-subagent.jsonl'));
    const agent = byType(ev, 'tool-use').find((t) => t.name === 'Agent' && !t.parentToolUseId)!;
    expect((agent.input as { subagent_type: string }).subagent_type).toBe('simple-task');
    const tagged = ev.filter((e) => e.parentToolUseId === agent.toolUseId);
    expect(tagged.some((e) => e.type === 'tool-use' && e.name === 'Read')).toBe(true);
    expect(tagged.some((e) => e.type === 'usage')).toBe(true);
    const denied = byType(ev, 'tool-result').find((t) => t.isError)!;
    expect(denied.content).toBe('Denied by test server');
    expect(denied.parentToolUseId).toBe(agent.toolUseId);
    const tasks = byType(ev, 'subagent-task');
    expect(tasks.map((t) => t.phase)).toEqual(['started', 'progress', 'progress', 'updated', 'notification']);
    expect(tasks.at(-1)!.toolUseId).toBe(agent.toolUseId);
    expect(tasks.at(-1)!.summary).toContain('oide-fixture first line');
    expect(byType(ev, 'background-tasks').map((b) => b.count)).toEqual([1, 0]);
  });

  it('model error: synthetic assistant error and api_error_status', () => {
    const ev = parseTranscript(fixture('real-model-error.jsonl'));
    expect(byType(ev, 'error')[0]!.code).toBe('model_not_found');
    expect(byType(ev, 'usage')).toHaveLength(0); // <synthetic> usage is ignored
    const r = byType(ev, 'result')[0]!;
    expect(r.isError).toBe(true);
    expect(r.apiErrorStatus).toBe(404);
  });

  it('resume keeps the session id', () => {
    const ev = parseTranscript(fixture('real-resume.jsonl'));
    expect(byType(ev, 'init')[0]!.sessionId).toBe('11111111-2222-4333-8444-555555555555');
    expect(byType(ev, 'result')[0]!.text).toContain('hello');
  });

  it('never throws on garbage and logs unknown types', () => {
    const logs: string[] = [];
    expect(parseLine('not json').events[0]!.type).toBe('stderr');
    expect(parseLine('{"type":"brand_new_thing","x":1}', (m) => logs.push(m)).events[0]).toEqual({ type: 'unknown', rawType: 'brand_new_thing' });
    expect(parseLine('{"type":"assistant","message":"oops"}').events[0]!.type).toBe('unknown');
    expect(parseLine('{"type":"system","subtype":"hook_response","stdout":"x"}').events).toEqual([]);
    expect(parseLine('').events).toEqual([]);
    expect(logs.length).toBeGreaterThan(0);
  });

  it('rate limit rejection becomes a rate-limit event with the reset time', () => {
    const p = parseLine(JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1800000000, rateLimitType: 'five_hour' } }));
    expect(p.events.map((e) => e.type)).toEqual(['plan-usage', 'rate-limit']);
    expect((p.events[1] as { resetAt: number }).resetAt).toBe(1800000000_000);
    const r = parseLine(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'limit', api_error_status: 429 }));
    expect(r.events.map((e) => e.type)).toEqual(['result', 'rate-limit']);
  });
});
