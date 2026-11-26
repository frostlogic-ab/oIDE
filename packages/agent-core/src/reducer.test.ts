import { describe, expect, it } from 'vitest';
import type { AgentEvent, AgentEventDraft } from '@oide/protocol';
import { fixtureEvents, stamp } from '../test/helpers.js';
import { AgentReducer, asksUser, createSummary, describeToolUse } from './reducer.js';

const fresh = (model = 'haiku') => ({ ...createSummary({ id: 'agent-1', projectId: 'p1', title: 'T', mode: 'auto', model, status: 'starting', now: 0 }), worktreePath: 'C:\\work\\repo' });

function run(events: AgentEvent[], model?: string) {
  const r = new AgentReducer(fresh(model));
  const statuses: string[] = [];
  for (const e of events) {
    r.apply(e);
    if (statuses.at(-1) !== r.summary.status) statuses.push(r.summary.status);
  }
  return { r, s: r.summary, statuses };
}

let seq = 1000;
const ev = (d: AgentEventDraft): AgentEvent => ({ ...d, agentId: 'agent-1', seq: seq++, ts: seq }) as AgentEvent;

describe('AgentReducer', () => {
  it('real basic session: running → has-question, context ring from the result window, mode, compaction', () => {
    const { s, statuses } = run([ev({ type: 'status', status: 'running' }), ...fixtureEvents('real-basic-multiturn.jsonl')]);
    expect(statuses[0]).toBe('running');
    expect(s.status).toBe('has-question');
    expect(s.sessionId).toBe('11111111-2222-4333-8444-555555555555');
    expect(s.model).toBe('claude-haiku-5-5');
    expect(s.mode).toBe('plan');
    expect(s.contextWindow).toBe(1_000_000);
    expect(s.contextUsed).toBe(21864); // post-compaction tokens
    expect(s.planUsage).toMatchObject({ status: 'allowed', window: 'seven_day', utilization: 0.65 });
    expect(s.activity).toContain('Read README.txt');
    expect(s.activity.at(-1)).toBe('Compacted context');
    expect(s.lastMessage).toBe('1\n2\n3\n4');
    expect(s.usage.cacheCreation).toBeGreaterThan(0);
  });

  it('context ring = input + cacheRead + cacheCreation of the latest lead assistant usage', () => {
    const { s } = run([
      ev({ type: 'usage', messageId: 'm1', usage: { input: 2, output: 4, cacheRead: 100, cacheCreation: 900 } }),
      ev({ type: 'usage', messageId: 'm1', usage: { input: 2, output: 4, cacheRead: 100, cacheCreation: 900 } }),
      ev({ type: 'usage', messageId: 's1', parentToolUseId: 'toolu_x', usage: { input: 5, output: 5, cacheRead: 50_000, cacheCreation: 0 } }),
    ]);
    expect(s.contextUsed).toBe(1002);
    expect(s.contextWindow).toBe(1_000_000); // haiku → claude-haiku-5-5, 1M per the CLI
    expect(s.usage).toEqual({ input: 7, output: 9, cacheRead: 50_100, cacheCreation: 900 }); // m1 counted once
  });

  it('activity lines from tool use and partials', () => {
    const { s } = run([
      ev({ type: 'partial', kind: 'thinking', delta: 'x' }),
      ev({ type: 'partial', kind: 'thinking', delta: 'y' }),
      ev({ type: 'tool-use', toolUseId: 't1', name: 'Bash', input: { command: 'npm test' } }),
      ev({ type: 'tool-use', toolUseId: 't2', name: 'Edit', input: { file_path: '/w/src/x.ts' } }),
      ev({ type: 'partial', kind: 'text', delta: 'Done' }),
    ]);
    expect(s.activity).toEqual(['Run npm test', 'Edit /w/src/x.ts', 'Writing…']);
    expect(describeToolUse('Read', { file_path: 'C:\\w\\src\\a.ts' }, 'C:\\w')).toBe('Read src/a.ts');
    expect(describeToolUse('mcp__github__create_pr', {})).toBe('github: create_pr');
  });

  it('todos from TodoWrite input and plan text from ExitPlanMode', () => {
    const { s } = run([
      ev({ type: 'tool-use', toolUseId: 't1', name: 'TodoWrite', input: { todos: [{ content: 'A', status: 'completed' }, { content: 'B', status: 'in_progress', activeForm: 'Doing B' }] } }),
      ev({ type: 'tool-use', toolUseId: 't2', name: 'ExitPlanMode', input: { plan: '1. Do it' } }),
    ]);
    expect(s.todos.map((t) => t.status)).toEqual(['completed', 'in_progress']);
    expect(s.planText).toBe('1. Do it');
  });

  it('needs-permission while a prompt is pending; ready-for-review after submit_for_review', () => {
    const req = { requestId: 'r1', agentId: 'agent-1', toolName: 'Bash', input: { command: 'npm test' }, summary: 'Run npm test', createdAt: 1 };
    const { s, statuses } = run([
      ev({ type: 'status', status: 'running' }),
      ev({ type: 'permission-request', request: req }),
      ev({ type: 'permission-resolved', requestId: 'other', behavior: 'allow' }),
      ev({ type: 'permission-resolved', requestId: 'r1', behavior: 'allow' }),
      ev({ type: 'review-submitted', review: { agentId: 'agent-1', summary: 'Did it', checks: [{ name: 'npm test', status: 'passed' }], submittedAt: 5 } }),
      ev({ type: 'result', subtype: 'success', isError: false, text: 'Submitted.' }),
    ]);
    expect(statuses).toEqual(['running', 'needs-permission', 'running', 'ready-for-review']);
    expect(s.review?.summary).toBe('Did it');
    expect(s.pendingPermission).toBeUndefined();
  });

  it('a prompt denied at quit is remembered until the user sends a message', () => {
    const req = { requestId: 'r1', agentId: 'agent-1', toolName: 'Bash', input: { command: 'npm i' }, summary: 'Run npm i', createdAt: 1 };
    const quit = run([
      ev({ type: 'status', status: 'running' }),
      ev({ type: 'permission-request', request: req }),
      ev({ type: 'permission-resolved', requestId: 'r1', behavior: 'deny', reason: 'quit' }),
      ev({ type: 'status', status: 'stopped' }),
    ]);
    expect(quit.s.pendingPermission).toBeUndefined();
    expect(quit.s.interruptedPermission).toMatchObject({ toolName: 'Bash', summary: 'Run npm i' });
    // A user's own deny is not a quit.
    const denied = run([ev({ type: 'permission-request', request: { ...req, requestId: 'r2' } }), ev({ type: 'permission-resolved', requestId: 'r2', behavior: 'deny' })]);
    expect(denied.s.interruptedPermission).toBeUndefined();
    // A subagent's text does not clear it; the user's message does.
    const r = new AgentReducer(quit.s);
    r.apply(ev({ type: 'user-text', text: 'sub', parentToolUseId: 'task-1' }));
    expect(r.summary.interruptedPermission).toBeDefined();
    r.apply(ev({ type: 'user-text', text: 'go on' }));
    expect(r.summary.interruptedPermission).toBeUndefined();
  });

  it('title-changed renames the lead; a subagent event does not', () => {
    const r = new AgentReducer(fresh());
    r.apply(ev({ type: 'title-changed', title: 'Sub name', parentToolUseId: 'task-1' }));
    expect(r.summary.title).not.toBe('Sub name');
    expect(r.apply(ev({ type: 'title-changed', title: 'Fix flaky invoice test' })).changed).toBe(true);
    expect(r.summary.title).toBe('Fix flaky invoice test');
  });

  it('merge conflicts from oIDE: activity says so; the next submit_for_review clears "Resolving merge conflicts"', () => {
    const r = new AgentReducer({ ...fresh(), mergeConflict: { target: 'main', targetSha: 'abc1234', files: ['a.ts'], sentAt: 1 } });
    r.apply(ev({ type: 'user-text', text: '[Sent by oIDE] Merge conflicts: …', origin: 'oide' }));
    expect(r.summary.activity.at(-1)).toBe('Resolving merge conflicts');
    // A subagent's review does not count; the lead's does.
    r.apply(ev({ type: 'review-submitted', review: { agentId: 'agent-1', summary: 'sub', checks: [], submittedAt: 1 }, parentToolUseId: 'task-1' }));
    expect(r.summary.mergeConflict).toBeDefined();
    r.apply(ev({ type: 'review-submitted', review: { agentId: 'agent-1', summary: 'Merged main', checks: [], submittedAt: 2 } }));
    expect(r.summary.mergeConflict).toBeUndefined();
    expect(r.summary.status).toBe('ready-for-review');
  });

  it('a new user message resets ready-for-review; a follow-up that asks something = has-question', () => {
    const { s, statuses } = run([
      ev({ type: 'review-submitted', review: { agentId: 'agent-1', summary: 'x', checks: [], submittedAt: 1 } }),
      ev({ type: 'result', subtype: 'success', isError: false }),
      ev({ type: 'status', status: 'running' }),
      ev({ type: 'result', subtype: 'success', isError: false, text: 'Should I push the branch, or will you?' }),
    ]);
    expect(statuses).toEqual(['ready-for-review', 'running', 'has-question']);
    expect(s.status).toBe('has-question');
  });

  it('a follow-up after an earlier review that only reports status goes back to ready-for-review', () => {
    const { s, statuses } = run([
      ev({ type: 'review-submitted', review: { agentId: 'agent-1', summary: 'x', checks: [], submittedAt: 1 } }),
      ev({ type: 'result', subtype: 'success', isError: false }),
      ev({ type: 'status', status: 'running' }),
      ev({ type: 'assistant-text', text: "PR #10's CI is green: typecheck, lint and E2E on Ubuntu." }),
      ev({ type: 'result', subtype: 'success', isError: false, text: "PR #10's CI is green: typecheck, lint and E2E on Ubuntu." }),
    ]);
    expect(statuses).toEqual(['ready-for-review', 'running', 'ready-for-review']);
    expect(s.review?.summary).toBe('x');
  });

  it('without an earlier review, a turn that ends without submitting is still has-question', () => {
    const { s } = run([ev({ type: 'status', status: 'running' }), ev({ type: 'result', subtype: 'success', isError: false, text: 'All done.' })]);
    expect(s.status).toBe('has-question');
  });

  it('background subagents keep the agent running after the lead result', () => {
    const { s, statuses } = run([ev({ type: 'status', status: 'running' }), ...fixtureEvents('real-subagent.jsonl')]);
    expect(statuses).toEqual(['running', 'has-question']);
    expect(s.backgroundTasks).toBe(0);
    expect(s.subagents).toHaveLength(1);
    expect(s.subagents[0]!.status).toBe('done');
  });

  it('rate limit: rate-limited with reset time, never flips back on the result', () => {
    const { s } = run([
      ev({ type: 'status', status: 'running' }),
      ev({ type: 'rate-limit', message: 'limit', resetAt: 1234 }),
      ev({ type: 'result', subtype: 'success', isError: true, apiErrorStatus: 429 }),
    ]);
    expect(s.status).toBe('rate-limited');
    expect(s.rateLimitResetAt).toBe(1234);
  });

  it('crash: non-zero exit → error with exit code and stderr', () => {
    const { s } = run([ev({ type: 'status', status: 'running' }), ev({ type: 'stderr', text: 'Error: boom' }), ev({ type: 'exit', code: 3, signal: null })]);
    expect(s.status).toBe('error');
    expect(s.exitCode).toBe(3);
    expect(s.error).toMatch(/code 3: Error: boom/);
  });

  it('stopped stays stopped on exit; auth errors become error', () => {
    expect(run([ev({ type: 'status', status: 'stopped' }), ev({ type: 'exit', code: null, signal: 'SIGTERM' })]).s.status).toBe('stopped');
    const auth = run([ev({ type: 'status', status: 'running' }), ev({ type: 'error', message: 'Not logged in', code: 'auth' }), ev({ type: 'result', subtype: 'success', isError: true, apiErrorStatus: 401 })]);
    expect(auth.s.status).toBe('error');
    expect(auth.s.error).toBe('Not logged in');
  });

  it('model error fixture ends in error', () => {
    const { s } = run([ev({ type: 'status', status: 'running' }), ...stamp([], 'agent-1'), ...fixtureEvents('real-model-error.jsonl')]);
    expect(s.status).toBe('error');
  });
});

describe('asksUser', () => {
  it('sees questions and plain requests for an answer', () => {
    expect(asksUser('Should I push the branch to re-run CI, or will you?')).toBe(true);
    expect(asksUser('Which option do you want?\n\n1. A\n2. B')).toBe(true);
    expect(asksUser('Two ways to do it. Let me know which you prefer.')).toBe(true);
    expect(asksUser('I need your decision on the schema before I go on.')).toBe(true);
    expect(asksUser('Want me to open the PR too? (It is ready.)')).toBe(true);
  });

  it('ignores status reports, code, and query strings in links', () => {
    expect(asksUser(undefined)).toBe(false);
    expect(asksUser('   ')).toBe(false);
    expect(asksUser("PR #10's CI is green: typecheck, lint, wiki and E2E on Ubuntu.\n\n- **Linux E2E:** passes now.")).toBe(false);
    expect(asksUser('See https://github.com/o/r/actions/runs/1/job/2?pr=10 for the run.')).toBe(false);
    expect(asksUser('Fixed the regex `/a?b/` and `x ?? y`.')).toBe(false);
    expect(asksUser('Done:\n```ts\nconst v = a ? b : c;\n```')).toBe(false);
    expect(asksUser('Details are in [the run](https://x.dev/run?id=3).')).toBe(false);
  });
});
