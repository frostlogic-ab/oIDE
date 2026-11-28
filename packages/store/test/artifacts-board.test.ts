import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parseBoard, serializeBoard, defaultBoard } from '@oide/protocol';
import { ArtifactError, ArtifactStore, openStore, type ArtifactChange } from '../src/index.js';
import { cleanup, tempDir } from './helpers.js';

afterAll(cleanup);

function setup(boardKeepVersions?: number) {
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
    ...(boardKeepVersions ? { boardKeepVersions } : {}),
  });
  return { s, repo, p, store, events };
}

describe('ArtifactStore: kanban boards (ADR 0022)', () => {
  it('a new board is board.json with the default backlog, in the repo when asked', async () => {
    const { store, repo, p } = setup();
    const meta = await store.create({ title: 'Product Backlog', kind: 'board', projectId: p.id, location: 'repo' });
    expect(meta).toMatchObject({ kind: 'board', entry: 'board.json', version: 1, fileCount: 1 });
    const file = join(repo, '.oide', 'artifacts', 'product-backlog', 'board.json');
    expect(existsSync(file)).toBe(true);
    expect(parseBoard(readFileSync(file, 'utf8')).columns[0]!.name).toBe('Proposed');
    const { board } = await store.readBoard(meta.id);
    expect(board.properties.map((x) => x.name)).toEqual(['Priority', 'Effort', 'Type']);
  });

  it('updateBoard applies operations as one version, noted, attributed and announced', async () => {
    const { store, events } = setup();
    const meta = await store.create({ title: 'Backlog', kind: 'board' });
    const added = await store.updateBoard(meta.id, [{ op: 'add_card', title: 'Fix login', props: { Priority: 'P1' } }], { author: 'user' });
    expect(added.meta.version).toBe(2);
    const cardId = added.results[0]!.cardId!;
    const moved = await store.updateBoard(meta.id, [{ op: 'move_card', cardId, column: 'In review' }], { author: 'agent:a1', authorName: 'Login agent' });
    expect(moved.meta.version).toBe(3);
    const versions = await store.versions(meta.id);
    expect(versions[0]).toMatchObject({ version: 3, author: 'agent:a1', note: 'Moved "Fix login" to In review' });
    expect(versions[1]).toMatchObject({ version: 2, author: 'user', note: 'Added "Fix login" to Proposed' });
    expect(events.at(-1)).toMatchObject({ id: meta.id, change: 'saved', version: 3, author: 'agent:a1' });
    // The agent's write is in the uses log ("Agents using it").
    expect(store.uses(meta.id).some((u) => u.agentId === 'a1' && u.op === 'write')).toBe(true);
    const { board } = await store.readBoard(meta.id);
    expect(board.cards[0]!.column).toBe(board.columns.find((c) => c.name === 'In review')!.id);
  });

  it('concurrent updates from the user and an agent both land (no lost update)', async () => {
    const { store } = setup();
    const meta = await store.create({ title: 'Backlog', kind: 'board' });
    await Promise.all(Array.from({ length: 8 }, (_, i) => store.updateBoard(meta.id, [{ op: 'add_card', title: `Card ${i}` }], { author: i % 2 ? 'user' : 'agent:a1' })));
    const { meta: after, board } = await store.readBoard(meta.id);
    expect(board.cards).toHaveLength(8);
    expect(after.version).toBe(9);
  });

  it('a refused operation writes nothing and says why', async () => {
    const { store } = setup();
    const meta = await store.create({ title: 'Backlog', kind: 'board' });
    const err = await store.updateBoard(meta.id, [{ op: 'add_card', title: 'A' }, { op: 'delete_column', column: 'Nowhere' }], { author: 'user' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ArtifactError);
    expect((err as ArtifactError).code).toBe('invalid_input');
    expect((err as Error).message).toMatch(/No column "Nowhere"/);
    expect((await store.readBoard(meta.id)).meta.version).toBe(1);
  });

  it('updateBoard and readBoard refuse other kinds', async () => {
    const { store } = setup();
    const doc = await store.create({ title: 'Notes', kind: 'doc' });
    await expect(store.updateBoard(doc.id, [{ op: 'add_card', title: 'A' }], { author: 'user' })).rejects.toThrow(/not a board/);
    await expect(store.readBoard(doc.id)).rejects.toThrow(/not a board/);
  });

  it('saving content that is not a board is refused (raw writes are checked too)', async () => {
    const { store } = setup();
    const meta = await store.create({ title: 'Backlog', kind: 'board' });
    await expect(store.save(meta.id, '{"type":"excalidraw"}')).rejects.toThrow(/Not an oIDE board/);
    await expect(store.create({ title: 'Bad', kind: 'board', content: 'nope' })).rejects.toThrow(/must be JSON/);
    const b = defaultBoard();
    const ok = await store.save(meta.id, serializeBoard({ ...b, columns: b.columns.slice(0, 2) }));
    expect(ok.version).toBe(2);
  });

  it('keeps only the newest board snapshots; restoring a recent one still works', async () => {
    const { store } = setup(3);
    const meta = await store.create({ title: 'Backlog', kind: 'board' });
    for (let i = 0; i < 5; i++) await store.updateBoard(meta.id, [{ op: 'add_card', title: `Card ${i}` }], { author: 'user' });
    const versions = await store.versions(meta.id);
    expect(versions.map((v) => v.version)).toEqual([6, 5, 4]);
    const dir = store.dirOf(meta.id);
    expect(existsSync(join(dir, '.versions', '1'))).toBe(false);
    expect(existsSync(join(dir, '.versions', '3'))).toBe(false);
    expect(existsSync(join(dir, '.versions', '4'))).toBe(true);
    const restored = await store.restore(meta.id, 4);
    expect(restored.version).toBe(7);
    expect((await store.readBoard(meta.id)).board.cards).toHaveLength(3);
    // Other kinds keep every version.
    const doc = await store.create({ title: 'Notes', kind: 'doc' });
    for (let i = 0; i < 4; i++) await store.save(doc.id, `v${i}`);
    expect((await store.versions(doc.id)).map((v) => v.version)).toEqual([5, 4, 3, 2, 1]);
  });

  it('restoring a version that is no longer kept says so', async () => {
    const { store } = setup(2);
    const meta = await store.create({ title: 'Backlog', kind: 'board' });
    for (let i = 0; i < 3; i++) await store.updateBoard(meta.id, [{ op: 'add_card', title: `Card ${i}` }], { author: 'user' });
    await expect(store.restore(meta.id, 1)).rejects.toThrow(/no longer kept: boards keep their newest 2 versions/);
  });

  it('a picked board.json is a board only when it holds one (an Excalidraw scene stays a whiteboard)', async () => {
    const { store } = setup();
    const { writeFileSync } = await import('node:fs');
    const a = tempDir('oide-import-');
    writeFileSync(join(a, 'board.json'), serializeBoard(defaultBoard()));
    writeFileSync(join(a, 'notes.md'), '# Notes');
    expect((await store.importFiles({ folderPath: a })).kind).toBe('board');
    const b = tempDir('oide-import-');
    writeFileSync(join(b, 'board.json'), JSON.stringify({ type: 'excalidraw', version: 2, elements: [] }));
    writeFileSync(join(b, 'notes.txt'), 'x');
    expect((await store.importFiles({ folderPath: b })).kind).not.toBe('board');
  });

  it('a board.json file imports as a board', async () => {
    const { store } = setup();
    const dir = tempDir('oide-import-');
    const file = join(dir, 'board.json');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(file, serializeBoard(defaultBoard()));
    const meta = await store.importFile({ filePath: file });
    expect(meta).toMatchObject({ kind: 'board', entry: 'board.json' });
  });
});
