import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import type { AgentSummary } from '@oide/protocol';
import { MIGRATIONS, openDatabase, openStore } from '../src/index.js';
import { cleanup, spec, tempDir } from './helpers.js';

const DAY = 86_400_000;

function setup() {
  const s = openStore(':memory:');
  const p = s.projects.open('/code/oide', { name: 'oide' });
  return { s, p };
}

function summary(id: string, projectId: string, extra: Partial<z.input<typeof AgentSummary>> = {}): z.input<typeof AgentSummary> {
  return { id, projectId, title: `Agent ${id}`, status: 'ready-for-review', mode: 'acceptEdits', model: 'sonnet', branch: `oide/${id}`, worktreePath: `/wt/${id}`, createdAt: 1, updatedAt: 2, ...extra };
}

afterEach(cleanup);

describe('migration 3: archived agents', () => {
  it('adds archived_at, archive_reason and merge_commit; rows from version 2 read as on the Wall', () => {
    const file = join(tempDir(), 'oide.db');
    const v2 = openDatabase(file, { migrations: MIGRATIONS.filter((m) => m.version <= 2) });
    v2.db.prepare("INSERT INTO projects (id, name, path, path_key, created_at) VALUES ('p1', 'p', '/p', '/p', 1)").run();
    v2.db
      .prepare("INSERT INTO agents (id, project_id, title, spec, status, created_at, updated_at) VALUES ('a1', 'p1', 'Old agent', ?, 'stopped', 1, 1)")
      .run(JSON.stringify({ ...spec('p1'), workIn: 'worktree-from-main', context: [], mode: 'auto', attempts: 1 }));
    v2.close();
    const s = openStore(file);
    expect(s.database.version).toBeGreaterThanOrEqual(3);
    const cols = (s.database.db.prepare('PRAGMA table_info(agents)').all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(['archived_at', 'archive_reason', 'merge_commit']));
    expect(s.agents.get('a1')).toMatchObject({ id: 'a1', status: 'stopped' });
    expect(s.agents.get('a1')?.archivedAt).toBeUndefined();
    expect(s.agents.list({ archived: false }).map((a) => a.id)).toEqual(['a1']);
    expect(s.agents.listArchived().total).toBe(0);
    // The CHECK constraint keeps reasons to the contract's enum.
    expect(() => s.database.db.prepare("UPDATE agents SET archive_reason = 'lost' WHERE id = 'a1'").run()).toThrow();
    s.close();
  });
});

describe('archived agents repository', () => {
  it('mirrors summary.archived into the columns and clears them on unarchive', () => {
    const { s, p } = setup();
    s.agents.insert({ id: 'a1', projectId: p.id, spec: spec(p.id), status: 'ready-for-review' });
    s.agents.saveSummary(summary('a1', p.id, { archived: { at: 50, reason: 'merged', mergeCommit: 'abc123', worktreeRemoved: true }, diff: { files: 2, additions: 10, deletions: 3 }, costUsd: 0.42 }));
    const rec = s.agents.get('a1')!;
    expect(rec).toMatchObject({ archivedAt: 50, archiveReason: 'merged', mergeCommit: 'abc123' });
    expect(rec.summary).toMatchObject({ archived: { reason: 'merged', worktreeRemoved: true }, diff: { additions: 10 }, costUsd: 0.42 });
    expect(s.agents.list({ archived: false })).toEqual([]);
    expect(s.agents.list({ archived: true }).map((a) => a.id)).toEqual(['a1']);

    s.agents.saveSummary(summary('a1', p.id, { status: 'stopped' }));
    expect(s.agents.get('a1')).toMatchObject({ archivedAt: undefined, archiveReason: undefined, mergeCommit: undefined });
    expect(s.agents.list({ archived: false }).map((a) => a.id)).toEqual(['a1']);
  });

  it('pages archived agents newest first, filters by project and title, and counts them', () => {
    const { s, p } = setup();
    const q = s.projects.open('/code/other', { name: 'other' });
    for (let i = 0; i < 7; i++) {
      const pid = i % 2 ? q.id : p.id;
      const title = i === 3 ? 'Fix 100%_done bug' : `Task ${i}`;
      s.agents.insert({ id: `a${i}`, projectId: pid, spec: spec(pid, title), status: 'stopped' });
      s.agents.saveSummary(summary(`a${i}`, pid, { title, archived: { at: 1000 + (i === 6 ? 50 : i), reason: 'archived-by-user', worktreeRemoved: false } }));
    }
    s.agents.insert({ id: 'live', projectId: p.id, spec: spec(p.id), status: 'running' });

    const first = s.agents.listArchived({ limit: 3 });
    expect(first.total).toBe(7);
    expect(first.records.map((r) => r.id)).toEqual(['a6', 'a5', 'a4']);
    const second = s.agents.listArchived({ limit: 3, cursor: first.nextCursor! });
    expect(second.records.map((r) => r.id)).toEqual(['a3', 'a2', 'a1']);
    const third = s.agents.listArchived({ limit: 3, cursor: second.nextCursor! });
    expect(third.records.map((r) => r.id)).toEqual(['a0']);
    expect(third.nextCursor).toBeUndefined();

    expect(s.agents.listArchived({ projectId: q.id }).records.map((r) => r.id)).toEqual(['a5', 'a3', 'a1']);
    expect(s.agents.listArchived({ query: 'task' }).total).toBe(6);
    // LIKE wildcards in the query are literal.
    expect(s.agents.listArchived({ query: '100%_' }).records.map((r) => r.id)).toEqual(['a3']);
    expect(s.agents.listArchived({ query: '%' }).total).toBe(1);
    expect(s.agents.archivedWorktrees(q.id).sort()).toEqual(['/wt/a1', '/wt/a3', '/wt/a5']);
  });

  it('skips a row it cannot read and repairs a stale summary instead of failing the whole list', () => {
    const { s, p } = setup();
    s.agents.insert({ id: 'good', projectId: p.id, spec: spec(p.id), status: 'running' });
    s.agents.insert({ id: 'stale', projectId: p.id, spec: spec(p.id), status: 'running' });
    s.agents.insert({ id: 'broken', projectId: p.id, spec: spec(p.id), status: 'running' });
    s.agents.saveSummary(summary('good', p.id));
    // A summary from an older build: a bad diff and one bad activity line.
    s.database.db.prepare("UPDATE agents SET summary = ? WHERE id = 'stale'").run(JSON.stringify({ ...summary('stale', p.id), diff: { files: -1 }, activity: ['ok', 42, 'fine'] }));
    s.database.db.prepare("UPDATE agents SET spec = '{not json' WHERE id = 'broken'").run();
    const list = s.agents.list();
    expect(list.map((a) => a.id)).toEqual(['good', 'stale']);
    expect(list[1]!.summary).toMatchObject({ id: 'stale', activity: ['ok', 'fine'] });
    expect(list[1]!.summary!.diff).toBeUndefined();
    expect(s.agents.skipped).toEqual([{ id: 'broken', error: expect.any(String) }]);
    expect(s.agents.repaired).toEqual([expect.objectContaining({ id: 'stale', dropped: expect.arrayContaining(['diff', 'activity[1]']) })]);
    expect(s.agents.get('broken')).toBeUndefined();
  });
});

describe('event retention for archived agents', () => {
  it('compacts an archived transcript instead of deleting it', () => {
    const { s, p } = setup();
    s.agents.insert({ id: 'arch', projectId: p.id, spec: spec(p.id), status: 'stopped' });
    s.agents.insert({ id: 'live', projectId: p.id, spec: spec(p.id), status: 'stopped' });
    s.agents.saveSummary(summary('arch', p.id, { archived: { at: 5, reason: 'merged', worktreeRemoved: true } }));
    const now = 100 * DAY;
    const old = now - 40 * DAY;
    const big = 'x'.repeat(10_000);
    for (const id of ['arch', 'live']) {
      s.events.appendDraft(id, { type: 'user-text', text: 'Build it' }, { raw: 'user' }, old);
      s.events.appendDraft(id, { type: 'tool-use', toolUseId: 'u1', name: 'Bash', input: { command: 'ls' } }, { raw: 'tool' }, old + 1);
      s.events.appendDraft(id, { type: 'tool-result', toolUseId: 'u1', isError: false, content: big }, { raw: big }, old + 2);
      s.events.appendDraft(id, { type: 'usage', usage: { input: 10, output: 5, cacheRead: 0, cacheCreation: 0 } }, undefined, old + 3);
      s.events.appendDraft(id, { type: 'stderr', text: 'warning' }, undefined, old + 4);
      s.events.appendDraft(id, { type: 'assistant-text', text: 'Done' }, { raw: 'asst' }, old + 5);
    }
    expect(s.events.compactOlderThan(30, now)).toEqual({ agents: 2, removed: 6 + 2, trimmed: 4 });
    // Agent on the Wall: as before, everything old went into a summary row.
    expect(s.events.list('live')).toEqual([]);
    // Archived agent: the conversation stays readable, without raw JSON, tool output trimmed.
    const kept = s.events.list('arch');
    expect(kept.map((e) => e.type)).toEqual(['user-text', 'tool-use', 'tool-result', 'assistant-text']);
    const result = kept[2] as Extract<(typeof kept)[number], { type: 'tool-result' }>;
    expect(result.content.length).toBeLessThan(4100);
    expect(result.content).toMatch(/trimmed after 30 days/);
    expect(s.events.raw('arch', 0)).toBeUndefined();
    expect(s.events.summaries('arch')).toEqual([expect.objectContaining({ count: 2, byType: { usage: 1, stderr: 1 }, usage: expect.objectContaining({ input: 10 }) })]);
    // Idempotent.
    expect(s.events.compactOlderThan(30, now)).toEqual({ agents: 0, removed: 0, trimmed: 0 });
    expect(s.events.list('arch')).toHaveLength(4);
  });
});
