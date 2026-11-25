import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OideMcpServer } from '@oide/mcp-server';
import type { AgentEvent, AgentSpecInput, AgentSummary } from '@oide/protocol';
import { fakeCli, stamp, tempDir, testSettings, waitFor } from '../test/helpers.js';
import type { EventSink, SettingsProvider, WorktreeProvider } from './ports.js';
import { AgentReducer, createSummary } from './reducer.js';
import { Supervisor, WORKTREE_GONE } from './supervisor.js';

/** Archive, unarchive and "Interrupted" on restore, against fake-claude and the real MCP server. */

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function harness(extraFlags: string, maxRunning = 3) {
  const settings = testSettings({ extraFlags, maxRunning });
  const mcp = new OideMcpServer({ appDataDir: tempDir('oide-app-') });
  await mcp.start();
  const events: AgentEvent[] = [];
  const saved = new Map<string, AgentSummary>();
  const removedWorktrees: string[] = [];
  const worktrees: WorktreeProvider = {
    create: async ({ slug }) => {
      const path = tempDir(`oide-wt-${slug}-`);
      writeFileSync(join(path, 'README.md'), '# fixture\n');
      return { path, branch: `oide/${slug}`, baseRef: 'main' };
    },
    remove: async ({ path }) => void removedWorktrees.push(path),
  };
  const sink: EventSink = { append: (e) => void events.push(e), saveSummary: (s) => void saved.set(s.id, structuredClone(s)) };
  const provider: SettingsProvider = { get: () => settings, cli: () => fakeCli, project: () => ({ path: '/repo', trusted: true, rules: { allow: [], deny: [] } }) };
  const sup = new Supervisor({ worktrees, sink, settings: provider, broker: mcp });
  cleanups.push(async () => {
    await sup.shutdown();
    await mcp.close();
  });
  const get = (id: string) => sup.get(id)!;
  const status = (id: string, s: string) => waitFor(() => sup.get(id)?.status === s && sup.get(id), 10_000, `${id} → ${s} (now ${sup.get(id)?.status})`);
  return { sup, mcp, events, saved, removedWorktrees, get, status };
}

const spec = (patch: Partial<AgentSpecInput> = {}): AgentSpecInput => ({
  projectId: 'p1',
  title: 'Fix tests',
  goal: 'Make the tests pass.',
  mode: 'default',
  strategy: { kind: 'single', lead: { model: 'sonnet' } },
  ...patch,
});

describe('Supervisor.archive / unarchive', () => {
  it('archives a finished agent: leaves the supervisor, keeps its saved summary, frees nothing it should not', async () => {
    const h = await harness('--fake-scenario basic');
    const [a] = await h.sup.spawn(spec());
    const idle = await h.status(a!.id, 'has-question');
    const archivedEvents: AgentSummary[] = [];
    h.sup.on('archived', (s) => archivedEvents.push(s));

    const s = await h.sup.archive(a!.id, { reason: 'merged', mergeCommit: 'abc1234', deleteWorktree: true });
    expect(s.archived).toMatchObject({ reason: 'merged', mergeCommit: 'abc1234', worktreeRemoved: true });
    expect(s.resumeBlocked).toBe(WORKTREE_GONE);
    expect(h.sup.get(a!.id)).toBeUndefined();
    expect(h.sup.list()).toEqual([]);
    expect(h.removedWorktrees).toEqual([idle.worktreePath]);
    expect(archivedEvents.map((x) => x.id)).toEqual([a!.id]);
    // The sink got the archived summary (the store keeps row, summary and events).
    expect(h.saved.get(a!.id)?.archived?.reason).toBe('merged');
    expect(h.saved.get(a!.id)?.sessionId).toBe(idle.sessionId);
  });

  it('archiving a working agent stops it, denies its prompt and frees its Max running slot', async () => {
    const h = await harness('--fake-scenario permission', 1);
    const [a, b] = await h.sup.spawn(spec({ attempts: 2 }));
    await h.status(a!.id, 'needs-permission');
    expect(h.get(b!.id).status).toBe('queued');
    expect(h.sup.runningCount()).toBe(1);
    await h.sup.archive(a!.id, { reason: 'archived-by-user' });
    expect(h.sup.get(a!.id)).toBeUndefined();
    expect(h.saved.get(a!.id)).toMatchObject({ status: 'stopped', archived: { reason: 'archived-by-user', worktreeRemoved: false } });
    expect(h.saved.get(a!.id)?.pendingPermission).toBeUndefined();
    // The queued attempt gets the slot.
    await h.status(b!.id, 'needs-permission');
  });

  it('unarchive brings it back stopped and resumable with --resume; a deleted worktree blocks Resume', async () => {
    const h = await harness('--fake-scenario basic');
    const [a] = await h.sup.spawn(spec());
    const first = await h.status(a!.id, 'has-question');
    const archived = await h.sup.archive(a!.id, { reason: 'archived-by-user' });
    const specA = { ...spec(), title: 'Fix tests' };

    const back = h.sup.unarchive({ spec: specA, summary: archived, lastSeq: 900 });
    expect(back.archived).toBeUndefined();
    expect(back.status).toBe('has-question');
    expect(h.sup.list().map((x) => x.id)).toEqual([a!.id]);
    expect(h.saved.get(a!.id)?.archived).toBeUndefined();
    h.sup.send(a!.id, { kind: 'text', text: 'carry on' });
    await waitFor(() => h.get(a!.id).lastMessage === `Resumed session ${first.sessionId}.`, 10_000, 'resumed after unarchive');
    expect(h.events.filter((e) => e.agentId === a!.id && e.seq > 900).length).toBeGreaterThan(0);

    // Archived with its worktree deleted: back on the Wall, but Resume and replies are refused.
    await h.status(a!.id, 'has-question');
    const gone = await h.sup.archive(a!.id, { reason: 'discarded', deleteWorktree: true });
    const blocked = h.sup.unarchive({ spec: specA, summary: gone, resumeBlocked: WORKTREE_GONE });
    expect(blocked.resumeBlocked).toBe(WORKTREE_GONE);
    await expect(h.sup.resume(a!.id)).rejects.toThrow(/cannot be resumed/);
    expect(() => h.sup.send(a!.id, { kind: 'text', text: 'hi' })).toThrow(/cannot be resumed/);
  }, 30_000);
});

describe('Supervisor.restore: interrupted agents', () => {
  it('marks agents that were working as Interrupted (restart or crash) and clears it once they run again', async () => {
    const h = await harness('--fake-scenario basic');
    const base = (id: string, status: AgentSummary['status']) => ({ ...createSummary({ id, projectId: 'p1', title: id, mode: 'default', model: 'sonnet', status, sessionId: `00000000-0000-4000-8000-00000000000${id.length}` }) });
    const restored = h.sup.restore([
      { spec: spec({ title: 'working' }), summary: base('working', 'running'), interruption: 'crash' },
      { spec: spec({ title: 'asking' }), summary: base('asking', 'needs-permission') },
      { spec: spec({ title: 'idle' }), summary: base('idle', 'has-question') },
      { spec: spec({ title: 'paused' }), summary: base('paused1', 'paused') },
      { spec: spec({ title: 'archived' }), summary: { ...base('archived', 'stopped'), archived: { at: 1, reason: 'merged', worktreeRemoved: true } } },
    ]);
    const by = Object.fromEntries(restored.map((s) => [s.id, s]));
    expect(Object.keys(by).sort()).toEqual(['asking', 'idle', 'paused1', 'working']);
    expect(by.working).toMatchObject({ status: 'stopped', interrupted: { reason: 'crash' } });
    expect(by.asking).toMatchObject({ status: 'stopped', interrupted: { reason: 'restart' } });
    expect(by.idle!.interrupted).toBeUndefined();
    expect(by.paused1).toMatchObject({ status: 'stopped' });
    expect(by.paused1!.interrupted).toBeUndefined();

    await h.sup.resume('working');
    await h.status('working', 'has-question');
    expect(h.get('working').interrupted).toBeUndefined();
  }, 30_000);
});

describe('AgentReducer cost', () => {
  it('sums the CLI-reported cost across turns and processes', () => {
    const r = new AgentReducer(createSummary({ id: 'agent-1', projectId: 'p', title: 't', mode: 'default', model: 'sonnet' }));
    const result = (total: number) => ({ type: 'result' as const, subtype: 'success', isError: false, totalCostUsd: total });
    for (const e of stamp([{ type: 'init', sessionId: 's' }, result(0.01), result(0.25), { type: 'init', sessionId: 's' }, result(0.1)])) r.apply(e);
    expect(r.summary.costUsd).toBeCloseTo(0.35, 6);
  });
});
