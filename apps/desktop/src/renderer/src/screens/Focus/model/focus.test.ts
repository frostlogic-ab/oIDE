import { describe, expect, it } from 'vitest';
import { AgentEvent, AgentSummary, type AgentEventDraft } from '@oide/protocol';
import { agentListLine, composeMessage, nextMode, permissionCopy, sortAgentList, subagentStatusText, subagentSummary, subagentTokenShare, timeline } from './focus';
import { mergeOlder, mergeTail } from './history';

const agent = (over: Partial<AgentSummary> & { id: string }) =>
  AgentSummary.parse({ projectId: 'p', title: over.id, status: 'running', mode: 'auto', model: 'opus', createdAt: 0, updatedAt: 0, ...over });

describe('composer → UserMessage shapes', () => {
  it('sends plain text', () => {
    expect(composeMessage({ text: '  Use UTC  ' })).toEqual({ kind: 'send', message: { kind: 'text', text: 'Use UTC' } });
  });
  it('sends known slash commands as commands, with arguments', () => {
    expect(composeMessage({ text: '/context' })).toEqual({ kind: 'send', message: { kind: 'command', command: '/context' } });
    expect(composeMessage({ text: '/review src', commands: ['review'] })).toEqual({ kind: 'send', message: { kind: 'command', command: '/review src' } });
  });
  it('never sends /compact directly: it asks first', () => {
    expect(composeMessage({ text: '/compact' })).toEqual({ kind: 'compact' });
  });
  it('keeps unknown slash text as a message', () => {
    expect(composeMessage({ text: '/usr/bin is missing' })).toEqual({ kind: 'send', message: { kind: 'text', text: '/usr/bin is missing' } });
  });
  it('sends an attached artifact with the text as its note', () => {
    expect(composeMessage({ text: 'Follow this', artifactId: 'art-1' })).toEqual({ kind: 'send', message: { kind: 'artifact', artifactId: 'art-1', note: 'Follow this' } });
    expect(composeMessage({ text: '', artifactId: 'art-1' })).toEqual({ kind: 'send', message: { kind: 'artifact', artifactId: 'art-1' } });
  });
  it('addresses the lead about a subagent when viewing one', () => {
    expect(composeMessage({ text: 'skip Windows', subagentName: 'Dependency setup' })).toEqual({
      kind: 'send',
      message: { kind: 'text', text: 'About the subagent "Dependency setup": skip Windows' },
    });
  });
  it('does nothing for empty input', () => {
    expect(composeMessage({ text: '   ' })).toEqual({ kind: 'none' });
  });
  it('carries attachments on a text message, never as a command', () => {
    const img = { kind: 'image' as const, mediaType: 'image/png' as const, dataBase64: 'iVBORw0KGgo=', name: 'shot.png' };
    expect(composeMessage({ text: 'Fix this', attachments: [img] })).toEqual({ kind: 'send', message: { kind: 'text', text: 'Fix this', attachments: [img] } });
    expect(composeMessage({ text: '', attachments: [img] })).toEqual({ kind: 'send', message: { kind: 'text', text: 'See the attached image.', attachments: [img] } });
    expect(composeMessage({ text: '/context', attachments: [img] })).toMatchObject({ kind: 'send', message: { kind: 'text' } });
    expect(composeMessage({ text: 'Use it', artifactId: 'art-1', attachments: [img] })).toEqual({ kind: 'send', message: { kind: 'artifact', artifactId: 'art-1', note: 'Use it', attachments: [img] } });
  });
});

describe('mode cycling (Shift+Tab)', () => {
  it('cycles Auto → Manual → Edit automatically → Plan → Auto', () => {
    expect(nextMode('auto')).toBe('default');
    expect(nextMode('default')).toBe('acceptEdits');
    expect(nextMode('acceptEdits')).toBe('plan');
    expect(nextMode('plan')).toBe('auto');
  });
  it('adds Bypass only when allowed and in a worktree', () => {
    expect(nextMode('plan', { allowBypass: true, inWorktree: false })).toBe('auto');
    expect(nextMode('plan', { allowBypass: true, inWorktree: true })).toBe('bypassPermissions');
    expect(nextMode('bypassPermissions', { allowBypass: true, inWorktree: true })).toBe('auto');
  });
  it('skips Auto when the CLI lacks it', () => {
    expect(nextMode('plan', { hasAuto: false })).toBe('default');
    expect(nextMode('auto', { hasAuto: false })).toBe('default');
  });
});

describe('agent list', () => {
  it('puts permission prompts first, then other needs-you, review, running', () => {
    const list = sortAgentList([
      agent({ id: 'run' }),
      agent({ id: 'review', status: 'ready-for-review' }),
      agent({ id: 'question', status: 'has-question' }),
      agent({ id: 'perm', status: 'needs-permission' }),
      agent({ id: 'stopped', status: 'stopped' }),
    ]);
    expect(list.map((a) => a.id)).toEqual(['perm', 'question', 'review', 'run', 'stopped']);
  });
  it('describes each agent in one line', () => {
    expect(agentListLine(agent({ id: 'q', status: 'has-question' }))).toMatchObject({ text: 'Has a question', tone: 'warn' });
    const running = agent({ id: 'r', activity: ['Bash pnpm build', '⎿ built 48 pages'], subagents: [{ id: 's', agentId: 'r', name: 'x', task: 't', status: 'running' }] });
    expect(agentListLine(running)).toMatchObject({ text: 'Bash pnpm build · 1 sub', mono: true });
  });
});

describe('subagents', () => {
  const subs = [
    { id: 'a', agentId: 'x', name: 'A', task: '', status: 'done' as const, startedAt: 60_000, endedAt: 180_000, usage: { input: 30, output: 0, cacheRead: 0, cacheCreation: 0 } },
    { id: 'b', agentId: 'x', name: 'B', task: '', status: 'needs-permission' as const, startedAt: 300_000, usage: { input: 10, output: 0, cacheRead: 0, cacheCreation: 0 } },
    { id: 'c', agentId: 'x', name: 'C', task: '', status: 'running' as const, startedAt: 540_000 },
  ];
  it('shares tokens against the agent total', () => {
    expect(subagentTokenShare({ usage: { input: 80, output: 20, cacheRead: 0, cacheCreation: 0 }, subagents: subs })).toBeCloseTo(0.4);
    expect(subagentTokenShare({ usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, subagents: subs })).toBe(0);
  });
  it('places timeline bars over the run so far', () => {
    const { bars } = timeline(0, subs, 600_000);
    expect(bars).toEqual([
      { id: 'a', left: 10, width: 20 },
      { id: 'b', left: 50, width: 50 },
      { id: 'c', left: 90, width: 10 },
    ]);
  });
  it('words status and counts', () => {
    expect(subagentStatusText(subs[0]!, 600_000)).toBe('Done in 2m');
    expect(subagentStatusText(subs[1]!, 780_000)).toBe('Needs permission · 8m');
    expect(subagentSummary(subs)).toEqual({ total: '3 subagents', parts: [{ text: '1 needs you', warn: true }, { text: '1 running' }, { text: '1 done' }] });
  });
  it('words permission prompts', () => {
    const req = { requestId: 'r', agentId: 'a', toolName: 'Bash', input: { command: 'npm install node-pty' }, summary: 'Run npm install', createdAt: 0 };
    expect(permissionCopy(req)).toEqual({ verb: 'wants to run a command', detail: 'npm install node-pty' });
    expect(permissionCopy({ ...req, toolName: 'Write', input: { file_path: 'a.ts' } })).toEqual({ verb: 'wants to write a file', detail: 'a.ts' });
  });
});

describe('transcript history merge', () => {
  const ev = (seqs: number[]) => seqs.map((seq) => AgentEvent.parse({ type: 'assistant-text', text: String(seq), agentId: 'a', seq, ts: seq } satisfies AgentEventDraft & { agentId: string; seq: number; ts: number }));
  it('prepends an older page without duplicates', () => {
    expect(mergeOlder(ev([1, 2, 3, 4]), ev([3, 4, 5])).map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
  });
  it('appends only tail events newer than what is held, and keeps identity when nothing is new', () => {
    const held = ev([1, 2, 3]);
    expect(mergeTail(held, ev([2, 3, 4, 5])).map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(mergeTail(held, ev([2, 3]))).toBe(held);
  });
});
