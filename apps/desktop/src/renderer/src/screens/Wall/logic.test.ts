import { describe, expect, it } from 'vitest';
import { AgentSummary, type SubagentInfo } from '@oide/protocol';
import { agents } from '../../lib/mock/fixtures';
import { branchLabel, filterCounts, matchesFilter, modeBadge, parseActivity, permissionView, subagentDetail, subagentSummary, tileBodyKind } from './logic';

const byId = Object.fromEntries(agents.map((a) => [a.id, a]));
const sub = (status: SubagentInfo['status'], extra: Partial<SubagentInfo> = {}): SubagentInfo => ({ id: `s-${Math.random()}`, agentId: 'a', name: 'S', task: '', status, ...extra });

describe('subagentSummary', () => {
  it('matches the canvas wording', () => {
    expect(subagentSummary(byId['a-shell']!.subagents)).toBe('2 of 3 running');
    expect(subagentSummary(byId['a-bridge']!.subagents)).toBe('1 needs you');
    expect(subagentSummary(byId['a-manifest']!.subagents)).toBe('1 done');
    expect(subagentSummary(byId['a-webhook']!.subagents)).toBe('3 done');
    expect(subagentSummary(byId['a-docs']!.subagents)).toBe('1 running, 1 queued');
    expect(subagentSummary([])).toBe('No subagents');
    expect(subagentSummary([sub('done'), sub('error')])).toBe('1 done, 1 failed');
    expect(subagentSummary([sub('needs-permission'), sub('needs-permission')])).toBe('2 need you');
  });

  it('describes a chip like the canvas tooltip', () => {
    const bridge = byId['a-bridge']!;
    const deps = bridge.subagents.find((s) => s.id === 'sa-deps')!;
    expect(subagentDetail(deps, bridge.pendingPermission, Date.now())).toBe('Sonnet, medium effort · routed as standard · needs permission · asking to run npm install node-pty');
    const explore = byId['a-shell']!.subagents[0]!;
    expect(subagentDetail(explore, undefined, Date.now())).toBe('Haiku, low effort · routed as simple · done · 2m');
  });
});

describe('filters', () => {
  it('counts All / Needs you / Running / Review', () => {
    expect(filterCounts(agents)).toEqual({ all: 6, needs: 2, running: 3, review: 1 });
    expect(agents.filter((a) => matchesFilter(a, 'needs')).map((a) => a.id).sort()).toEqual(['a-bridge', 'a-invoice']);
  });
});

describe('parseActivity', () => {
  it('splits diff counts, results, subagent lines and in-progress markers', () => {
    const a = byId['a-shell']!;
    const lines = parseActivity(a.activity, a.subagents, true);
    expect(lines[0]).toEqual({ kind: 'step', text: 'Edit src/shell/Layout.tsx', active: false, additions: 38, deletions: 12 });
    expect(lines[2]).toEqual({ kind: 'result', text: '0 errors' });
    expect(lines[3]).toMatchObject({ kind: 'step', active: true });
    expect(lines[4]).toEqual({ kind: 'sub', subagent: 'Grid tests', text: 'Write SessionGrid.test.tsx', active: true });
  });
});

describe('permissionView', () => {
  it('names the subagent and shows the command', () => {
    const a = byId['a-bridge']!;
    expect(permissionView(a.pendingPermission!, a.subagents)).toEqual({
      subagent: 'Dependency setup',
      verb: 'wants to run:',
      target: 'npm install node-pty',
      note: 'Needed to host each CLI session in a real terminal.',
    });
  });
  it('handles edits by the lead', () => {
    const v = permissionView({ requestId: 'r', agentId: 'a', toolName: 'Edit', input: { file_path: 'src/a.ts' }, summary: 'Edit src/a.ts', createdAt: 0 }, []);
    expect(v).toEqual({ subagent: undefined, verb: 'wants to edit:', target: 'src/a.ts', note: undefined });
  });
});

describe('tile helpers', () => {
  it('picks the body for each status', () => {
    expect(agents.map((a) => tileBodyKind(a))).toEqual(['activity', 'permission', 'activity', 'review', 'question', 'activity']);
    const base = AgentSummary.parse({ id: 'x', projectId: 'p', title: 't', status: 'rate-limited', mode: 'auto', model: 'opus', createdAt: 0, updatedAt: 0 });
    expect(tileBodyKind(base)).toBe('rate-limited');
    expect(tileBodyKind({ ...base, status: 'error' })).toBe('error');
    expect(tileBodyKind({ ...base, status: 'queued' })).toBe('queued');
    expect(tileBodyKind({ ...base, status: 'needs-permission' })).toBe('activity'); // no request yet
  });
  it('mode badge: Bypass always warns, others only when not the default', () => {
    expect(modeBadge('bypassPermissions', 'auto')).toEqual({ label: 'Bypass', warn: true });
    expect(modeBadge('auto', 'auto')).toBeNull();
    expect(modeBadge('plan', 'auto')).toEqual({ label: 'Plan', warn: false });
  });
  it('branch label', () => {
    expect(branchLabel({ branch: 'oide/shell-layout' })).toBe('shell-layout');
    expect(branchLabel({})).toBe('project folder');
  });
});
