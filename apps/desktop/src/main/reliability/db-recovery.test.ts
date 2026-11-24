import { existsSync, mkdtempSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '@oide/store';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { removeSync } from './fs-safe.js';
import { classifyDbError, dbFailurePrompt, openWithRecovery, tryOpenDatabase } from './db-recovery.js';

const dirs: string[] = [];
function tmp(): string {
  // Spaces and non-ASCII on purpose: userData paths like that must work.
  const d = mkdtempSync(join(tmpdir(), 'oide db ünï 文-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) removeSync(d);
});

describe('classifyDbError', () => {
  it('maps SQLite and fs errors to kinds', () => {
    expect(classifyDbError(new Error('database is locked'))).toBe('locked');
    expect(classifyDbError(new Error('file is not a database'))).toBe('corrupt');
    expect(classifyDbError(new Error('database disk image is malformed'))).toBe('corrupt');
    expect(classifyDbError(new Error('database or disk is full'))).toBe('disk-full');
    expect(classifyDbError(Object.assign(new Error('x'), { code: 'EACCES' }))).toBe('permission');
    expect(classifyDbError(new Error('Database x is at schema version 9, newer than this build (3). Update oIDE.'))).toBe('newer-schema');
    expect(classifyDbError(new Error('???'))).toBe('other');
  });
});

describe('opening a damaged database', () => {
  it('backs the files up, never deletes them, and the store releases the file handle', () => {
    const dir = tmp();
    const file = join(dir, 'oide.db');
    writeFileSync(file, 'this is not sqlite at all, just garbage bytes '.repeat(200));
    const r = tryOpenDatabase(file, join(dir, 'backups'), () => openStore(file));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.kind).toBe('corrupt');
    expect(r.backups).toHaveLength(1);
    expect(readFileSync(r.backups[0]!, 'utf8')).toContain('garbage bytes');
    expect(existsSync(file)).toBe(true);
    // Windows: the failed open must not keep the file locked (store closes it on failure).
    unlinkSync(file);
    expect(existsSync(file)).toBe(false);
  });

  it('openWithRecovery: Quit is the default and leaves the file alone', async () => {
    const dir = tmp();
    const file = join(dir, 'oide.db');
    writeFileSync(file, 'garbage'.repeat(500));
    const ask = vi.fn(async (p: ReturnType<typeof dbFailurePrompt>) => p.defaultId);
    expect(await openWithRecovery({ file, backupDir: join(dir, 'backups'), open: () => openStore(file), ask, openFolder: () => {} })).toBeNull();
    expect(readFileSync(file, 'utf8')).toContain('garbage');
  });

  it('openWithRecovery: "Start with a new database" moves the damaged files aside and opens a fresh one', async () => {
    const dir = tmp();
    const file = join(dir, 'oide.db');
    writeFileSync(file, 'garbage'.repeat(500));
    const opened: string[] = [];
    let asked = 0;
    const store = await openWithRecovery({
      file,
      backupDir: join(dir, 'backups'),
      open: () => openStore(file),
      // First "Open backups folder" (asks again), then "Start with a new database".
      ask: async (p) => {
        const want = ++asked === 1 ? 'open-backups' : 'fresh';
        return p.buttons.findIndex((b) => b.action === want);
      },
      openFolder: (d) => opened.push(`folder:${d}`),
    });
    expect(asked).toBe(2);
    expect(store).not.toBeNull();
    store!.close();
    const backups = readdirSync(join(dir, 'backups'));
    expect(backups.some((f) => f.includes('.failed-'))).toBe(true);
    expect(backups.some((f) => f.includes('.corrupt-'))).toBe(true);
    expect(opened.some((o) => o.startsWith('folder:'))).toBe(true);
  });

  it('a locked database offers Retry and is not copied', async () => {
    let calls = 0;
    const store = await openWithRecovery({
      file: join(tmp(), 'oide.db'),
      backupDir: join(tmp(), 'b'),
      open: () => {
        if (++calls === 1) throw new Error('database is locked');
        return 'store';
      },
      ask: async (p) => {
        expect(p.buttons.map((b) => b.action)).toEqual(['retry', 'quit']);
        return 0;
      },
      openFolder: () => {},
    });
    expect(store).toBe('store');
  });

  it('prompts never default to the destructive choice', () => {
    for (const kind of ['locked', 'corrupt', 'newer-schema', 'disk-full', 'permission', 'other'] as const) {
      const p = dbFailurePrompt(kind, new Error('x'), []);
      expect(p.buttons[p.defaultId]!.action).not.toBe('fresh');
      expect(p.buttons[p.cancelId]!.action).not.toBe('fresh');
    }
  });
});
