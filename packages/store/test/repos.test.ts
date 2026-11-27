import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import type { AgentSummary, CustomServer, InstalledExtension } from '@oide/protocol';
import { EventsRepo, openStore } from '../src/index.js';
import { spec } from './helpers.js';

const DAY = 86_400_000;

function setup() {
  const s = openStore(':memory:');
  const p = s.projects.open('/code/oide', { name: 'oide' });
  return { s, p };
}

describe('projects', () => {
  it('opens once per folder, case-insensitively on Windows/macOS, and tracks trust', () => {
    const { s, p } = setup();
    expect(p).toMatchObject({ name: 'oide', trusted: false });
    expect(s.projects.open('/code/oide').id).toBe(p.id);
    if (process.platform === 'win32' || process.platform === 'darwin') expect(s.projects.open('/CODE/OIDE').id).toBe(p.id);
    expect(s.projects.setTrusted(p.id, true).trusted).toBe(true);
    expect(s.projects.list()).toHaveLength(1);
    expect(() => s.projects.setTrusted('nope', true)).toThrow();
  });
});

describe('agents and subagents', () => {
  it('stores spec, status, worktree and the latest summary', () => {
    const { s, p } = setup();
    const a = s.agents.insert({ id: 'a1', projectId: p.id, spec: spec(p.id), status: 'queued', attemptGroup: 'g1' });
    expect(a.title).toBe('Fix the flaky test');
    expect(a.spec.workIn).toBe('worktree-from-main');
    s.agents.update('a1', { status: 'running', branch: 'oide/fix', worktreePath: '/wt/fix', baseRef: 'main' });
    const summary: z.input<typeof AgentSummary> = {
      id: 'a1',
      projectId: p.id,
      title: 'Fix the flaky test',
      status: 'ready-for-review',
      mode: 'auto',
      model: 'opus',
      sessionId: 'sess-1',
      activity: ['Read src/x.ts'],
      contextUsed: 1000,
      contextWindow: 200_000,
      usage: { input: 1, output: 2, cacheRead: 0, cacheCreation: 0 },
      subagents: [],
      todos: [],
      createdAt: 1,
      updatedAt: 2,
    };
    const saved = s.agents.saveSummary(summary);
    expect(saved).toMatchObject({ status: 'ready-for-review', sessionId: 'sess-1', branch: 'oide/fix', worktreePath: '/wt/fix' });
    expect(saved.summary?.activity).toEqual(['Read src/x.ts']);
    expect(s.agents.list({ projectId: p.id, statuses: ['ready-for-review'] })).toHaveLength(1);
    expect(s.agents.list({ attemptGroup: 'g1' })).toHaveLength(1);
    expect(s.agents.summaries()).toHaveLength(1);
    expect(s.agents.update('a1', { status: 'done' }).endedAt).toBeDefined();

    s.subagents.upsert({ id: 't1', agentId: 'a1', name: 'reviewer', task: 'review', status: 'running', startedAt: 5 });
    s.subagents.upsert({ id: 't1', agentId: 'a1', name: 'reviewer', task: 'review', status: 'done', startedAt: 5, endedAt: 9, tier: 'simple', model: 'haiku' });
    expect(s.subagents.list('a1')).toEqual([expect.objectContaining({ status: 'done', endedAt: 9 })]);
    expect(s.subagents.activeCount()).toBe(0);
    expect(s.agents.remove('a1')).toBe(true);
    expect(s.subagents.list('a1')).toEqual([]);
  });

  it('a renamed agent (set_title): saveSpec stores the new spec and title; saveSummary mirrors the title', () => {
    const { s, p } = setup();
    s.agents.insert({ id: 'a1', projectId: p.id, spec: { ...spec(p.id), title: 'Can we fix the fl…', autoTitle: true }, status: 'running' });
    const named = s.agents.saveSpec('a1', { ...spec(p.id), title: 'Fix flaky invoice test' });
    expect(named.title).toBe('Fix flaky invoice test');
    expect(named.spec.title).toBe('Fix flaky invoice test');
    expect(named.spec.autoTitle).toBeUndefined();
    expect(s.agents.get('a1')!.spec.attachments).toBeUndefined();
    expect(() => s.agents.saveSpec('nope', spec(p.id))).toThrow();
    const saved = s.agents.saveSummary({ id: 'a1', projectId: p.id, title: 'Another', status: 'running', mode: 'auto', model: 'opus', createdAt: 1, updatedAt: 2 });
    expect(saved.title).toBe('Another');
  });
});

describe('events', () => {
  it('assigns seq, skips partial deltas, pages both ways and keeps raw JSON', () => {
    const { s, p } = setup();
    s.agents.insert({ id: 'a1', projectId: p.id, spec: spec(p.id), status: 'running' });
    for (let i = 0; i < 10; i++) s.events.appendDraft('a1', { type: 'assistant-text', text: `t${i}` }, { raw: i }, 1000 + i);
    s.events.appendDraft('a1', { type: 'partial', kind: 'text', delta: 'x' });
    expect(s.events.count('a1')).toBe(10);
    const last = s.events.page('a1', { limit: 3 });
    expect(last.events.map((e) => e.seq)).toEqual([7, 8, 9]);
    expect(last.hasMore).toBe(true);
    const older = s.events.page('a1', { beforeSeq: 7, limit: 5 });
    expect(older.events.map((e) => e.seq)).toEqual([2, 3, 4, 5, 6]);
    expect(s.events.page('a1', { beforeSeq: 2, limit: 5 })).toMatchObject({ hasMore: false });
    expect(s.events.list('a1', { afterSeq: 8 }).map((e) => e.seq)).toEqual([9]);
    expect(s.events.raw('a1', 3)).toEqual({ raw: 3 });
    expect(s.events.nextSeq('a1')).toBe(10);
  });

  it('reads unknown stored shapes as unknown events instead of throwing', () => {
    const { s, p } = setup();
    s.agents.insert({ id: 'a1', projectId: p.id, spec: spec(p.id), status: 'running' });
    s.database.db.prepare("INSERT INTO events (agent_id, seq, type, ts, data) VALUES ('a1', 0, 'future-type', 5, '{\"type\":\"future-type\"}')").run();
    expect(s.events.list('a1')[0]).toMatchObject({ type: 'unknown', rawType: 'future-type', seq: 0 });
  });

  it('compacts old events into summaries and keeps seq monotonic', () => {
    const { s, p } = setup();
    s.agents.insert({ id: 'a1', projectId: p.id, spec: spec(p.id), status: 'done' });
    const now = 100 * DAY;
    const old = now - 40 * DAY;
    s.events.appendDraft('a1', { type: 'tool-use', toolUseId: 'u1', name: 'Read', input: {} }, undefined, old);
    s.events.appendDraft('a1', { type: 'usage', usage: { input: 10, output: 5, cacheRead: 1, cacheCreation: 0 } }, undefined, old + 1);
    s.events.appendDraft('a1', { type: 'assistant-text', text: 'All done' }, undefined, old + 2);
    s.events.appendDraft('a1', { type: 'user-text', text: 'recent' }, undefined, now - DAY);
    expect(s.events.compactOlderThan(30, now)).toEqual({ agents: 1, removed: 3, trimmed: 0 });
    expect(s.events.list('a1').map((e) => e.type)).toEqual(['user-text']);
    const [sum] = s.events.summaries('a1');
    expect(sum).toMatchObject({ fromSeq: 0, toSeq: 2, count: 3, tools: { Read: 1 }, usage: { input: 10, output: 5, cacheRead: 1 }, lastAssistantText: 'All done' });
    // a fresh repo instance continues after the highest seq, compacted or not
    s.database.db.prepare('DELETE FROM events').run();
    const fresh = new EventsRepo(s.database);
    expect(fresh.nextSeq('a1')).toBe(3); // continues after the compacted range (0..2)
  });
});

describe('usage, review, ui state', () => {
  it('sums usage and attributes it to subagents', () => {
    const { s, p } = setup();
    s.agents.insert({ id: 'a1', projectId: p.id, spec: spec(p.id), status: 'running' });
    s.usage.add({ agentId: 'a1', ts: 10, usage: { input: 100, output: 10 } });
    s.usage.add({ agentId: 'a1', subagentId: 't1', ts: 20, usage: { input: 50, output: 5, cacheRead: 5 } });
    s.usage.add({ ts: 5, usage: { input: 1 } });
    expect(s.usage.totals({ since: 10 })).toEqual({ input: 150, output: 15, cacheRead: 5, cacheCreation: 0, total: 170 });
    expect(s.usage.totals({ agentId: 'a1' }).total).toBe(170);
    expect(s.usage.bySubagent('a1')).toEqual([
      { subagentId: undefined, total: 110 },
      { subagentId: 't1', total: 60 },
    ]);
  });

  it('sums usage per Claude Code account (spec.accountId, default otherwise)', () => {
    const { s, p } = setup();
    s.agents.insert({ id: 'a1', projectId: p.id, spec: spec(p.id), status: 'running' });
    s.agents.insert({ id: 'a2', projectId: p.id, spec: { ...spec(p.id), accountId: 'acc-work01' }, status: 'running' });
    s.usage.add({ agentId: 'a1', ts: 10, usage: { input: 100 } });
    s.usage.add({ agentId: 'a2', ts: 10, usage: { input: 30, output: 3 } });
    s.usage.add({ agentId: 'a2', ts: 1, usage: { input: 999 } });
    s.usage.add({ ts: 10, usage: { input: 1 } });
    expect(Object.fromEntries(s.usage.totalsByAccount(5))).toEqual({ default: 101, 'acc-work01': 33 });
  });

  it('rolls old samples up per day, project and model, and reads days across both (Usage screen)', () => {
    const { s, p } = setup();
    s.agents.insert({ id: 'a1', projectId: p.id, spec: spec(p.id), status: 'done' });
    const off = 2 * 3600_000; // UTC+2
    const day = (n: number, h = 12) => n * DAY - off + h * 3600_000; // local noon of day n
    s.usage.add({ agentId: 'a1', ts: day(100), model: 'opus', usage: { input: 10, output: 1 } });
    s.usage.add({ agentId: 'a1', ts: day(100, 1), model: 'opus', usage: { input: 5, cacheRead: 100 } });
    s.usage.add({ ts: day(100), usage: { input: 7 } }); // no agent, no model
    s.usage.add({ agentId: 'a1', ts: day(101), model: 'opus', usage: { output: 3 } });
    s.usage.add({ agentId: 'a1', ts: day(200), model: 'haiku', usage: { input: 2 } });
    const before = s.usage.daily({ sinceDay: 0, offsetMs: off });

    // Compact everything before day 150: two days of samples become rollup rows.
    expect(s.usage.compactOlderThan(150 * DAY, off)).toBe(4);
    expect(s.usage.totals().total).toBe(2);
    expect(s.usage.daily({ sinceDay: 0, offsetMs: off })).toEqual(before);
    expect(before).toEqual([
      { day: 100, usage: { input: 7, output: 0, cacheRead: 0, cacheCreation: 0 } },
      { day: 100, projectId: p.id, model: 'opus', usage: { input: 15, output: 1, cacheRead: 100, cacheCreation: 0 } },
      { day: 101, projectId: p.id, model: 'opus', usage: { input: 0, output: 3, cacheRead: 0, cacheCreation: 0 } },
      { day: 200, projectId: p.id, model: 'haiku', usage: { input: 2, output: 0, cacheRead: 0, cacheCreation: 0 } },
    ]);
    // A later compaction of the same day adds to its row instead of replacing it.
    s.usage.add({ agentId: 'a1', ts: day(101, 2), model: 'opus', usage: { output: 4 } });
    s.usage.compactOlderThan(150 * DAY, off);
    expect(s.usage.daily({ sinceDay: 101, offsetMs: off })[0]).toMatchObject({ day: 101, usage: { output: 7 } });
    // Removing the agent keeps the rolled-up tokens with their project.
    s.agents.remove('a1');
    expect(s.usage.daily({ sinceDay: 101, offsetMs: off })[0]).toMatchObject({ projectId: p.id });
  });

  it('lists sessions and counts subagents since a time', () => {
    const { s, p } = setup();
    s.agents.insert({ id: 'old', projectId: p.id, spec: spec(p.id), status: 'done', createdAt: 5 });
    s.agents.insert({ id: 'a1', projectId: p.id, spec: spec(p.id), status: 'error', createdAt: 20, worktreePath: '/wt/a1', attemptGroup: 'g' });
    s.agents.update('a1', { archivedAt: 30, archiveReason: 'merged' });
    expect(s.agents.sessionsSince(10)).toEqual([
      expect.objectContaining({ projectId: p.id, status: 'error', createdAt: 20, archiveReason: 'merged', worktree: true, attemptGroup: 'g' }),
    ]);
    s.subagents.upsert({ id: 't1', agentId: 'a1', name: 'x', task: 'y', status: 'done', startedAt: 25 });
    s.subagents.upsert({ id: 't0', agentId: 'old', name: 'x', task: 'y', status: 'done', startedAt: 6 });
    expect(s.subagents.countSince(10)).toBe(1);
  });

  it('keeps review comments and viewed files', () => {
    const { s, p } = setup();
    s.agents.insert({ id: 'a1', projectId: p.id, spec: spec(p.id), status: 'ready-for-review' });
    const c1 = s.review.addComment({ agentId: 'a1', path: 'src/a.ts', line: 3, body: 'Rename this' }, 1);
    s.review.addComment({ agentId: 'a1', path: 'src/b.ts', body: 'Why?' }, 2);
    expect(s.review.comments('a1').map((c) => c.body)).toEqual(['Rename this', 'Why?']);
    const removed = s.review.addComment({ agentId: 'a1', path: 'src/a.ts', line: 3, side: 'old', body: 'Keep this line' }, 3);
    expect(s.review.comments('a1').map((c) => [c.line, c.side])).toEqual([[3, 'new'], [undefined, 'new'], [3, 'old']]);
    s.review.deleteComment(removed.id);
    expect(s.review.takeUnsent('a1')).toHaveLength(2);
    expect(s.review.takeUnsent('a1')).toHaveLength(0);
    expect(s.review.comments('a1').every((c) => c.sent)).toBe(true);
    expect(s.review.deleteComment(c1.id)).toBe(true);
    s.review.setViewed('a1', 'src/a.ts', true);
    s.review.setViewed('a1', 'src/a.ts', true);
    s.review.setViewed('a1', 'src/b.ts', true);
    s.review.setViewed('a1', 'src/b.ts', false);
    expect(s.review.viewed('a1')).toEqual(['src/a.ts']);
  });

  it('persists the project scope per window', () => {
    const { s, p } = setup();
    expect(s.ui.scope()).toBe('all');
    s.ui.setScope(p.id);
    expect(s.ui.scope()).toBe(p.id);
    expect(s.ui.scope('second-window')).toBe('all');
    s.ui.kv.set('scope:main', { bad: true });
    expect(s.ui.scope()).toBe('all');
  });
});

describe('extensions and custom servers', () => {
  it('validates and round-trips documents', () => {
    const { s } = setup();
    const ext: z.input<typeof InstalledExtension> = {
      id: 'e1',
      name: 'oide-git',
      version: '1.0.0',
      displayName: 'Git',
      source: 'builtin',
      path: '/ext/git',
      enabledProjects: [],
      enabledGlobally: true,
      reviewed: true,
      devMode: false,
      manifest: {
        name: 'oide-git',
        version: '1.0.0',
        oide: {
          engine: '^0.1.0',
          displayName: 'Git',
          categories: [],
          activation: [],
          mcpServers: {},
          contributes: { panels: [], commands: [], settings: {}, themes: [], techniques: [], artifactTypes: [], languages: [], deployTargets: [] },
          capabilities: { network: [], spawn: false, fs: [] },
        },
      },
    };
    s.extensions.upsert(ext);
    expect(s.extensions.byName('oide-git')?.displayName).toBe('Git');
    s.extensions.upsert({ ...ext, enabledProjects: ['p1'] });
    expect(s.extensions.list()).toHaveLength(1);
    expect(s.extensions.get('e1')?.enabledProjects).toEqual(['p1']);

    const server: z.input<typeof CustomServer> = {
      id: 'c1',
      name: 'linear',
      route: 'url',
      transport: { kind: 'http', url: 'https://mcp.example.com/mcp', auth: 'oauth' },
      tools: [{ name: 'search', risk: 'read', enabled: true }],
      projects: [],
      allProjects: true,
      savedTo: 'my-settings',
      reviewed: false,
    };
    s.customServers.upsert(server);
    expect(s.customServers.list()[0]?.tools[0]?.risk).toBe('read');
    expect(() => s.customServers.upsert({ ...server, name: 'bad name!' })).toThrow();
    expect(s.customServers.remove('c1')).toBe(true);
  });
});
