import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  ArtifactError,
  ArtifactStore,
  MAX_TITLE_LENGTH,
  openStore,
  type ArtifactChange,
} from '../src/index.js';
import { cleanup, tempDir } from './helpers.js';

afterAll(cleanup);

function setup() {
  const s = openStore(':memory:');
  const repo = tempDir('oide-repo-');
  const appData = tempDir('oide-appdata-');
  const p = s.projects.open(repo, { name: 'oide' });
  const events: Array<{ id?: string } & Partial<ArtifactChange>> = [];
  let t = 1_000;
  const store = new ArtifactStore({
    db: s.database,
    appDataDir: appData,
    projectPath: (id) => s.projects.pathOf(id),
    now: () => (t += 1_000),
    onChange: (id, info) => events.push({ id, ...info }),
  });
  return { s, repo, appData, p, store, events };
}

describe('ArtifactStore editing (rename, delete, conflicts, change events)', () => {
  it('renames: new title in artifact.json and the index, same folder, id and version', async () => {
    const { store, repo, p, events } = setup();
    const a = await store.create({ title: 'Main window', kind: 'design', projectId: p.id, location: 'repo' });
    await store.save(a.id, '<p>v2</p>');
    const before = store.dirOf(a.id);

    const renamed = await store.rename(a.id, '  Main   window  v2 ');
    expect(renamed).toMatchObject({ id: a.id, slug: 'main-window', title: 'Main window v2', version: 2 });
    expect(renamed.updatedAt).toBeGreaterThan(a.updatedAt);
    expect(store.dirOf(a.id)).toBe(before);
    expect(existsSync(join(repo, '.oide', 'artifacts', 'main-window', 'index.html'))).toBe(true);
    expect(JSON.parse(readFileSync(join(before, 'artifact.json'), 'utf8')).title).toBe('Main window v2');
    expect((await store.list()).map((x) => x.title)).toEqual(['Main window v2']);
    // A rename is not a version: history and content are untouched.
    expect((await store.versions(a.id)).map((v) => v.version)).toEqual([2, 1]);
    expect((await store.read(a.id)).content).toBe('<p>v2</p>');
    expect(events.at(-1)).toEqual({ id: a.id, change: 'renamed', version: 2 });

    // Same title: no write, no event.
    const n = events.length;
    expect((await store.rename(a.id, 'Main window v2')).title).toBe('Main window v2');
    expect(events.length).toBe(n);
  });

  it('refuses empty, too long and unknown renames', async () => {
    const { store } = setup();
    const a = await store.create({ title: 'Notes', kind: 'doc' });
    await expect(store.rename(a.id, '   ')).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(store.rename(a.id, 'x'.repeat(MAX_TITLE_LENGTH + 1))).rejects.toBeInstanceOf(ArtifactError);
    await expect(store.rename('nope', 'Title')).rejects.toThrow(/Unknown artifact/);
    expect((await store.read(a.id)).meta.title).toBe('Notes');
  });

  it('save with baseVersion refuses when someone saved in between (code conflict)', async () => {
    const { store, events } = setup();
    const a = await store.create({ title: 'Webhook retry design', kind: 'doc', content: '# v1\n' });
    // The editor opened v1; an agent writes v2.
    await store.write(a.id, '# agent v2\n', 'agent-7');
    expect(events.at(-1)).toEqual({ id: a.id, change: 'saved', version: 2, author: 'agent:agent-7' });

    const err = await store.save(a.id, '# mine\n', { baseVersion: 1 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ArtifactError);
    expect(err).toMatchObject({ code: 'conflict' });
    expect((err as Error).message).toMatch(/now v2.*from v1/);
    expect((await store.read(a.id)).content).toContain('agent v2');
    expect((await store.versions(a.id)).length).toBe(2);

    // Keep mine: save on top of the version you have seen.
    const mine = await store.save(a.id, '# mine\n', {
      baseVersion: 2,
      author: 'user',
      note: 'Edited by you over v2',
    });
    expect(mine.version).toBe(3);
    expect(await store.readVersion(a.id, 2)).toContain('agent v2');
    expect(events.at(-1)).toEqual({ id: a.id, change: 'saved', version: 3, author: 'user' });
  });

  it('concurrent saves from the same base: one wins, the other gets a conflict', async () => {
    const { store } = setup();
    const a = await store.create({ title: 'Board', kind: 'whiteboard' });
    const results = await Promise.allSettled([
      store.save(a.id, '{"elements":[1]}', { baseVersion: 1 }),
      store.save(a.id, '{"elements":[2]}', { baseVersion: 1 }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect((await store.read(a.id)).meta.version).toBe(2);
  });

  it('delete removes the folder, the index row and the uses, and emits deleted', async () => {
    const { store, s, appData, events } = setup();
    const a = await store.create({ title: 'Scratch', kind: 'doc' });
    await store.backend().read(a.id, 'agent-1');
    expect(store.uses(a.id)).toHaveLength(1);
    expect(await store.delete(a.id)).toBe(true);
    expect(readdirSync(join(appData, 'artifacts'))).toEqual([]);
    expect(store.uses(a.id)).toEqual([]);
    expect(s.database.db.prepare('SELECT COUNT(*) AS n FROM artifacts').get()).toMatchObject({ n: 0 });
    expect(events.at(-1)).toEqual({ id: a.id, change: 'deleted' });
    expect(await store.delete(a.id)).toBe(false);
  });

  it('create reports created with the author', async () => {
    const { store, events } = setup();
    const a = await store.createForAgent({ title: 'Plan', kind: 'doc' }, 'agent-2');
    expect(events.at(-1)).toEqual({ id: a.id, change: 'created', version: 1, author: 'agent:agent-2' });
  });
});
