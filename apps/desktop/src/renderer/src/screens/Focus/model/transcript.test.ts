import { describe, expect, it } from 'vitest';
import { AgentEvent, type AgentEventDraft } from '@oide/protocol';
import { buildRows, eventsFor, groupByParent, lineDiff, reportedSlashCommands, subagentFiles, subagentSteps, toolLabel, toolMeta, type TranscriptRow } from './transcript';

const mk = (drafts: Array<AgentEventDraft>): AgentEvent[] => drafts.map((d, i) => AgentEvent.parse({ ...d, agentId: 'a1', seq: i, ts: 1000 + i }));
const kinds = (rows: TranscriptRow[]) => rows.map((r) => r.kind);

describe('buildRows: event → transcript row mapping', () => {
  it('maps user, assistant and thinking, and hides bookkeeping events', () => {
    const rows = buildRows(
      mk([
        { type: 'init', sessionId: 's', model: 'opus', cwd: '/w', tools: [], mcpServers: [] },
        { type: 'user-text', text: 'Do the thing' },
        { type: 'thinking', text: 'Plan A' },
        { type: 'thinking', text: 'Plan B' },
        { type: 'assistant-text', text: 'On it' },
        { type: 'usage', usage: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 } },
        { type: 'status', status: 'running' },
        { type: 'todos', todos: [] },
        { type: 'plan-usage', status: 'allowed' },
        { type: 'unknown', rawType: 'x' },
      ]),
    );
    expect(kinds(rows)).toEqual(['user', 'thinking', 'assistant']);
    expect(rows[1]).toMatchObject({ kind: 'thinking', text: 'Plan A\n\nPlan B' });
  });

  it('groups consecutive tool calls into one card, attaches results by id and merges adjacent Reads', () => {
    const rows = buildRows(
      mk([
        { type: 'tool-use', toolUseId: 'r1', name: 'Read', input: { file_path: 'a.ts' } },
        { type: 'tool-use', toolUseId: 'r2', name: 'Read', input: { file_path: 'b.ts' } },
        { type: 'tool-result', toolUseId: 'r1', isError: false, content: 'A' },
        { type: 'tool-use', toolUseId: 'e1', name: 'Edit', input: { file_path: 'a.ts', old_string: 'x', new_string: 'y\nz' } },
        { type: 'tool-use', toolUseId: 'b1', name: 'Bash', input: { command: 'npm test' } },
        { type: 'tool-result', toolUseId: 'b1', isError: true, content: '2 failed\nmore' },
        { type: 'assistant-text', text: 'done' },
        { type: 'tool-use', toolUseId: 'g1', name: 'Grep', input: { pattern: 'foo' } },
      ]),
    );
    expect(kinds(rows)).toEqual(['tools', 'assistant', 'tools']);
    const card = rows[0] as Extract<TranscriptRow, { kind: 'tools' }>;
    expect(card.lines.map((l) => l.calls.map((c) => c.id))).toEqual([['r1', 'r2'], ['e1'], ['b1']]);
    expect(card.lines[0]!.calls[0]!.result?.content).toBe('A');
    expect(card.lines[2]!.calls[0]!.result).toMatchObject({ isError: true });
    // The card's memo version moves with its latest result.
    expect(card.v).toBe(5);
    expect(toolMeta(card.lines[0]!)).toMatchObject({ text: 'a.ts, b.ts' });
    expect(toolMeta(card.lines[1]!)).toMatchObject({ tone: 'diff', additions: 2, deletions: 1 });
    expect(toolMeta(card.lines[2]!)).toMatchObject({ tone: 'bad', text: '2 failed' });
    expect(toolMeta((rows[2] as Extract<TranscriptRow, { kind: 'tools' }>).lines[0]!)).toMatchObject({ tone: 'running' });
  });

  it('turns Agent/Task calls into subagent cards and absorbs their report', () => {
    const rows = buildRows(
      mk([
        { type: 'tool-use', toolUseId: 'sa-1', name: 'Agent', input: { description: 'Parser tests', prompt: 'Write tests', subagent_type: 'standard-task' } },
        { type: 'tool-use', toolUseId: 'sa-2', name: 'Task', input: { description: 'Docs' } },
        { type: 'tool-result', toolUseId: 'sa-1', isError: false, content: 'All green' },
      ]),
    );
    expect(kinds(rows)).toEqual(['subagent', 'subagent']);
    expect(rows[0]).toMatchObject({ toolUseId: 'sa-1', description: 'Parser tests', prompt: 'Write tests', subagentType: 'standard-task', report: { content: 'All green', isError: false }, v: 2 });
    expect(rows[1]).toMatchObject({ toolUseId: 'sa-2', description: 'Docs' });
  });

  it('maps results, errors, rate limits, compaction, mode changes, review and CLI-replayed user lines', () => {
    const rows = buildRows(
      mk([
        { type: 'user-text', text: '[Request interrupted by user]' },
        { type: 'user-text', text: '<local-command-stdout>Compacted </local-command-stdout>' },
        { type: 'user-text', text: '<command-name>/compact</command-name>' },
        { type: 'compact', phase: 'done', preTokens: 168_000, postTokens: 21_000 },
        { type: 'mode-changed', mode: 'plan' },
        { type: 'result', subtype: 'success', isError: false, numTurns: 3, durationMs: 1000 },
        { type: 'error', message: 'Not signed in', code: 'auth' },
        { type: 'rate-limit', message: 'Plan limit reached', resetAt: 5 },
        { type: 'review-submitted', review: { agentId: 'a1', summary: 'Done', checks: [], submittedAt: 1 } },
        { type: 'exit', code: 0, signal: null },
        { type: 'exit', code: 1, signal: null },
      ]),
    );
    expect(kinds(rows)).toEqual(['notice', 'notice', 'notice', 'notice', 'result', 'error', 'rate-limit', 'review', 'notice']);
    expect(rows.map((r) => (r.kind === 'notice' ? r.text : null)).filter(Boolean)).toEqual([
      'Interrupted by you',
      'Compacted',
      'Compacted · 168k → 21k tokens',
      'Mode changed to Plan',
      'The CLI process exited with code 1',
    ]);
  });
});

describe('subagent filtering by parentToolUseId', () => {
  const events = mk([
    { type: 'user-text', text: 'lead' },
    { type: 'tool-use', toolUseId: 'sa-1', name: 'Agent', input: { description: 'One' } },
    { type: 'tool-use', toolUseId: 'x1', name: 'Read', input: { file_path: 'a.ts' }, parentToolUseId: 'sa-1' },
    { type: 'tool-use', toolUseId: 'y1', name: 'Write', input: { file_path: 'b.ts', content: '1\n2' }, parentToolUseId: 'sa-2' },
    { type: 'tool-result', toolUseId: 'x1', isError: false, content: 'ok', parentToolUseId: 'sa-1' },
    { type: 'assistant-text', text: 'lead again' },
  ]);

  it('keeps the lead transcript free of subagent events', () => {
    const lead = eventsFor(events);
    expect(lead.map((e) => e.seq)).toEqual([0, 1, 5]);
    expect(kinds(buildRows(lead))).toEqual(['user', 'subagent', 'assistant']);
  });

  it("gives each subagent exactly its own tagged events", () => {
    expect(eventsFor(events, 'sa-1').map((e) => e.seq)).toEqual([2, 4]);
    const groups = groupByParent(events);
    expect([...groups.keys()]).toEqual(['sa-1', 'sa-2']);
    expect(groups.get('sa-2')!.map((e) => e.seq)).toEqual([3]);
    expect(subagentFiles(groups.get('sa-1')!)).toBe('read 1 file');
    expect(subagentFiles(groups.get('sa-2')!)).toBe('b.ts');
  });

  it('builds card steps: done, waiting on the pending prompt, live text and the report', () => {
    const sub = mk([
      { type: 'tool-use', toolUseId: 's1', name: 'Bash', input: { command: 'npx vitest' }, parentToolUseId: 'p' },
      { type: 'tool-result', toolUseId: 's1', isError: false, content: '7 passed, 1 failed', parentToolUseId: 'p' },
      { type: 'tool-use', toolUseId: 's2', name: 'Bash', input: { command: 'npm install node-pty' }, parentToolUseId: 'p' },
      { type: 'assistant-text', text: 'Fixing the split-chunk case…', parentToolUseId: 'p' },
    ]);
    expect(subagentSteps(sub, { status: 'needs-permission', pendingToolUseId: 's2' }).map((s) => [s.state, s.text, s.meta])).toEqual([
      ['done', 'Bash npx vitest', '7 passed, 1 failed'],
      ['need', 'Bash npm install node-pty', 'waiting for you'],
    ]);
    expect(subagentSteps(sub, { status: 'running' }).map((s) => s.state)).toEqual(['done', 'run', 'run']);
    expect(subagentSteps(sub, { status: 'running' }).at(-1)!.text).toBe('Fixing the split-chunk case…');
    expect(subagentSteps(sub, { status: 'done', report: 'Reported 9 flags\nmore' }).map((s) => [s.state, s.text])).toEqual([
      ['done', 'Bash npx vitest'],
      ['done', 'Bash npm install node-pty'],
      ['done', 'Reported 9 flags'],
    ]);
  });
});

describe('helpers', () => {
  it('labels tools as on the canvas', () => {
    expect(toolLabel('Bash', { command: 'npm run typecheck' })).toBe('Bash npm run typecheck');
    expect(toolLabel('Edit', { file_path: 'src/x.ts' })).toBe('Edit src/x.ts');
    expect(toolLabel('mcp__oide__submit_for_review', {})).toBe('Submit for review');
    expect(toolLabel('mcp__github__create_pr', {})).toBe('github: create pr');
  });

  it('diffs lines with context', () => {
    expect(lineDiff('a\nb\nc', 'a\nB\nc\nd')).toEqual([
      { t: ' ', s: 'a' },
      { t: '-', s: 'b' },
      { t: '+', s: 'B' },
      { t: ' ', s: 'c' },
      { t: '+', s: 'd' },
    ]);
  });

  it('reads the slash commands the CLI reported in its latest init', () => {
    const ev = mk([
      { type: 'init', sessionId: 's', model: 'm', cwd: '/', tools: [], mcpServers: [], slashCommands: ['compact'] },
      { type: 'init', sessionId: 's', model: 'm', cwd: '/', tools: [], mcpServers: [], slashCommands: ['compact', 'context', 'init'] },
    ]);
    expect(reportedSlashCommands(ev)).toEqual(['compact', 'context', 'init']);
    expect(reportedSlashCommands([])).toBeUndefined();
  });

  it('maps 5,000 events quickly', () => {
    const drafts: AgentEventDraft[] = [];
    for (let i = 0; i < 1250; i++) {
      drafts.push({ type: 'tool-use', toolUseId: `t${i}`, name: 'Read', input: { file_path: `f${i}.ts` } });
      drafts.push({ type: 'tool-result', toolUseId: `t${i}`, isError: false, content: 'x' });
      drafts.push({ type: 'assistant-text', text: `step ${i}` });
      drafts.push({ type: 'usage', usage: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 } });
    }
    const events = mk(drafts);
    const t = performance.now();
    const rows = buildRows(eventsFor(events));
    expect(rows).toHaveLength(2500);
    expect(performance.now() - t).toBeLessThan(200);
  });
});
