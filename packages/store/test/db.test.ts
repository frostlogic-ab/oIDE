import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import { MIGRATIONS, openDatabase, openStore } from '../src/index.js';
import { cleanup, spec, tempDir } from './helpers.js';

afterAll(cleanup);

describe('openDatabase', () => {
  it('opens in memory with foreign keys and the full schema', () => {
    const d = openDatabase(':memory:');
    expect(d.version).toBe(MIGRATIONS[MIGRATIONS.length - 1]!.version);
    expect((d.db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys).toBe(1);
    const tables = (d.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>).map((r) => r.name);
    for (const t of ['projects', 'agents', 'subagents', 'events', 'event_summaries', 'usage_samples', 'review_comments', 'review_viewed', 'settings', 'ui_state', 'artifacts', 'artifact_uses', 'extensions', 'custom_servers', 'secrets']) {
      expect(tables).toContain(t);
    }
    d.close();
  });

  it('uses WAL on disk, backs up before pending migrations, and is idempotent', () => {
    const dir = tempDir();
    const file = join(dir, 'oide.db');
    const first = openDatabase(file);
    expect((first.db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode).toBe('wal');
    expect(first.backupPath).toBeUndefined();
    first.db.prepare("INSERT INTO settings (key, data, updated_at) VALUES ('x', '1', 1)").run();
    first.close();

    const again = openDatabase(file);
    expect(again.backupPath).toBeUndefined();
    again.close();

    const extra = [...MIGRATIONS, { version: 99, name: 'add column', up: 'ALTER TABLE settings ADD COLUMN extra TEXT' }];
    const migrated = openDatabase(file, { migrations: extra });
    expect(migrated.version).toBe(99);
    expect(migrated.backupPath).toBeDefined();
    expect(existsSync(migrated.backupPath!)).toBe(true);
    migrated.close();
    // the backup is a consistent copy at the old version
    const bak = new DatabaseSync(migrated.backupPath!);
    expect((bak.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number }).v).toBe(MIGRATIONS[MIGRATIONS.length - 1]!.version);
    expect((bak.prepare("SELECT data FROM settings WHERE key = 'x'").get() as { data: string }).data).toBe('1');
    bak.close();
    expect(readdirSync(dir).filter((f) => f.endsWith('.bak'))).toHaveLength(1);
  });

  it('rolls back a failing migration and refuses newer databases', () => {
    const dir = tempDir();
    const file = join(dir, 'oide.db');
    openDatabase(file).close();
    const bad = [...MIGRATIONS, { version: 98, name: 'broken', up: 'CREATE TABLE ok_part (x INT); SELECT * FROM missing_table;' }];
    expect(() => openDatabase(file, { migrations: bad })).toThrow();
    const d = openDatabase(file);
    expect(d.db.prepare("SELECT name FROM sqlite_master WHERE name = 'ok_part'").get()).toBeUndefined();
    d.db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (500, 'future', 1)").run();
    d.close();
    expect(() => openDatabase(file)).toThrow(/newer than this build/);
  });

  it('migration 2 adds review_comments.side; comments from version 1 read as new-side', () => {
    const file = join(tempDir(), 'oide.db');
    const v1 = openDatabase(file, { migrations: MIGRATIONS.filter((m) => m.version === 1) });
    v1.db.exec('PRAGMA foreign_keys = OFF');
    v1.db.prepare("INSERT INTO review_comments (id, agent_id, path, line, body, sent, created_at) VALUES ('c1', 'a1', 'x.ts', 4, 'old one', 0, 1)").run();
    v1.close();
    const s = openStore(file);
    expect(s.review.comments('a1')).toEqual([expect.objectContaining({ id: 'c1', line: 4, side: 'new' })]);
    s.close();
  });

  it('nests transactions with savepoints', () => {
    const d = openDatabase(':memory:');
    d.transaction(() => {
      d.db.prepare("INSERT INTO settings (key, data, updated_at) VALUES ('a', '1', 1)").run();
      expect(() =>
        d.transaction(() => {
          d.db.prepare("INSERT INTO settings (key, data, updated_at) VALUES ('b', '1', 1)").run();
          throw new Error('inner');
        }),
      ).toThrow('inner');
    });
    const keys = (d.db.prepare('SELECT key FROM settings').all() as Array<{ key: string }>).map((r) => r.key);
    expect(keys).toEqual(['a']);
  });

  it('cascades project deletion to agents and events', () => {
    const s = openStore(':memory:');
    const p = s.projects.open('/tmp/x');
    s.agents.insert({ id: 'a1', projectId: p.id, spec: spec(p.id), status: 'running' });
    s.events.appendDraft('a1', { type: 'user-text', text: 'hi' });
    s.projects.remove(p.id);
    expect(s.agents.get('a1')).toBeUndefined();
    expect(s.events.count('a1')).toBe(0);
    s.close();
  });
});
