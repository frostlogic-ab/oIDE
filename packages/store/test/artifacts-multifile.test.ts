import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ARTIFACT_LIMITS } from '@oide/protocol';
import { ArtifactStore, isTextFile, openStore, pickEntry, type ArtifactChange } from '../src/index.js';
import { cleanup, tempDir } from './helpers.js';

afterAll(cleanup);

/** Multi-file artifacts (ADR 0014): versions are full snapshots, paths stay inside the folder. */

function setup() {
  const s = openStore(':memory:');
  const repo = tempDir('oide-repo-');
  const appData = tempDir('oide-appdata-');
  const p = s.projects.open(repo, { name: 'oide' });
  const changes: Array<{ id?: string; info?: ArtifactChange }> = [];
  const store = new ArtifactStore({ db: s.database, appDataDir: appData, projectPath: (id) => s.projects.pathOf(id), onChange: (id, info) => changes.push({ ...(id ? { id } : {}), ...(info ? { info } : {}) }) });
  return { s, repo, appData, p, store, changes };
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const text = (path: string, data: string) => ({ path, encoding: 'utf8' as const, data });
const b64 = (path: string, bytes: Buffer) => ({ path, encoding: 'base64' as const, data: bytes.toString('base64') });

/** A staging folder like the retrieval service fills. */
function staging(files: Record<string, string | Buffer>): string {
  const dir = tempDir('oide-staging-');
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(join(dir, ...p.split('/').slice(0, -1)), { recursive: true });
    writeFileSync(join(dir, ...p.split('/')), c);
  }
  return dir;
}

describe('multi-file artifacts', () => {
  it('writeFiles makes one new version holding every file; older versions stay full snapshots', async () => {
    const { store, appData } = setup();
    const art = await store.create({ title: 'Site', kind: 'design', content: '<!doctype html><title>Site</title><link rel="stylesheet" href="site.css">' });
    expect(art).toMatchObject({ version: 1, entry: 'index.html', fileCount: 1 });
    const v2 = await store.writeFiles(art.id, { files: [text('site.css', 'body{color:red}'), b64('shots/home.png', PNG), text('about.html', '<!doctype html><p>About</p>')], note: 'Pages' });
    expect(v2).toMatchObject({ version: 2, entry: 'index.html', fileCount: 4 });
    expect((await store.files(art.id)).map((f) => [f.path, f.text])).toEqual([
      ['about.html', true],
      ['index.html', true],
      ['shots/home.png', false],
      ['site.css', true],
    ]);
    expect(await store.readFile(art.id, 'shots/home.png')).toEqual({ encoding: 'base64', data: PNG.toString('base64') });
    expect(await store.readFile(art.id, 'site.css')).toEqual({ encoding: 'utf8', data: 'body{color:red}' });
    const dir = join(appData, 'artifacts', 'site');
    expect(readdirSync(join(dir, '.versions', '1')).sort()).toEqual(['index.html']);
    expect(readdirSync(join(dir, '.versions', '2')).sort()).toEqual(['about.html', 'index.html', 'shots', 'site.css']);
    expect((await store.files(art.id, 1)).map((f) => f.path)).toEqual(['index.html']);
    await expect(store.readFile(art.id, 'site.css', 1)).rejects.toThrow();
    // readVersion still gives the entry's text; versions carry no internal fields.
    expect(await store.readVersion(art.id, 1)).toContain('<title>Site</title>');
    expect((await store.versions(art.id))[0]).toEqual({ version: 2, ts: expect.any(Number), author: 'user', note: 'Pages' });

    // Deletes, an entry move, and the empty folder going with its last file.
    const v3 = await store.writeFiles(art.id, { deletes: ['shots/home.png', 'index.html'], entry: 'about.html' });
    expect(v3).toMatchObject({ version: 3, entry: 'about.html', fileCount: 2 });
    expect(existsSync(join(dir, 'shots'))).toBe(false);
    expect(existsSync(join(dir, 'index.html'))).toBe(false);
    expect((await store.read(art.id)).content).toContain('About');
    expect(await store.readVersion(art.id, 2)).toContain('<title>Site</title>');
    // The entry can't simply be deleted.
    await expect(store.writeFiles(art.id, { deletes: ['about.html'] })).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(store.writeFiles(art.id, { deletes: ['nope.css'] })).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(store.writeFiles(art.id, { files: [text('x.css', '')], baseVersion: 2 })).rejects.toMatchObject({ code: 'conflict' });
  });

  it('save writes the entry file and keeps every other file', async () => {
    const { store } = setup();
    const art = await store.create({ title: 'Deck', kind: 'design', content: '<!doctype html><p>1</p>' });
    await store.writeFiles(art.id, { files: [text('deck.css', 'p{}')] });
    const v3 = await store.save(art.id, '<!doctype html><p>2</p>');
    expect(v3).toMatchObject({ version: 3, entry: 'index.html', fileCount: 2 });
    expect((await store.readFile(art.id, 'deck.css')).data).toBe('p{}');
    // A multi-file design does not switch to App.jsx when React source is saved into its entry.
    const v4 = await store.save(art.id, "import React from 'react';\nexport default function A() { return <p>x</p>; }\n");
    expect(v4.entry).toBe('index.html');
  });

  it('refuses unsafe paths: .., absolute, backslashes, reserved names, devices, case clashes', async () => {
    const { store } = setup();
    const art = await store.create({ title: 'Paths', kind: 'design', content: '<p>x</p>' });
    for (const p of ['../evil.html', '/etc/passwd', 'C:/x.html', 'a\\b.html', 'artifact.json', '.versions/1/index.html', '.staging/x', '__oide/react-runtime.js', 'CON', 'aux.txt', 'a/./b', 'a//b', 'dots.', 'x'.repeat(300)]) {
      await expect(store.writeFiles(art.id, { files: [text(p, 'x')] }), p).rejects.toMatchObject({ code: 'invalid_input' });
      await expect(store.readFile(art.id, p), p).rejects.toThrow();
    }
    await expect(store.writeFiles(art.id, { files: [text('A.css', '1'), text('a.css', '2')] })).rejects.toThrow(/twice/);
    await expect(store.writeFiles(art.id, { files: [text('a', '1'), text('a/b.css', '2')] })).rejects.toThrow(/both a file and a folder/);
    await expect(store.writeFiles(art.id, { files: [{ path: 'x.png', encoding: 'base64', data: 'not base64!' }] })).rejects.toThrow(/base64/);
    expect((await store.read(art.id)).meta.version).toBe(1);
  });

  it('enforces the limits before anything is written', async () => {
    const { store } = setup();
    const art = await store.create({ title: 'Big', kind: 'design', content: '<p>x</p>' });
    const tooMany = Array.from({ length: ARTIFACT_LIMITS.files }, (_, i) => text(`f${i}.css`, ''));
    await expect(store.writeFiles(art.id, { files: tooMany })).rejects.toThrow(/at most 500 files/);
    const big = Buffer.alloc(ARTIFACT_LIMITS.fileBytes + 1);
    await expect(store.writeFiles(art.id, { files: [b64('big.bin', big)] })).rejects.toThrow(/larger than 10 MB/);
    const nine = Buffer.alloc(ARTIFACT_LIMITS.fileBytes - 1024);
    const eleven = Array.from({ length: 11 }, (_, i) => b64(`p${i}.bin`, nine));
    await expect(store.writeFiles(art.id, { files: eleven })).rejects.toThrow(/at most 100 MB/);
    expect((await store.versions(art.id)).length).toBe(1);
  });

  it('reads and writes never follow a symbolic link inside the folder', async () => {
    const { store, appData } = setup();
    const art = await store.create({ title: 'Links', kind: 'design', content: '<p>x</p>' });
    const outside = tempDir('oide-outside-');
    writeFileSync(join(outside, 'secret.css'), 'SECRET');
    const dir = join(appData, 'artifacts', 'links');
    try {
      symlinkSync(outside, join(dir, 'assets'), 'junction');
    } catch {
      return; // no link support here
    }
    expect((await store.files(art.id)).map((f) => f.path)).toEqual(['index.html']);
    await expect(store.readFile(art.id, 'assets/secret.css')).rejects.toThrow(/symbolic link/);
    await expect(store.writeFiles(art.id, { files: [text('assets/new.css', 'x')] })).rejects.toThrow(/symbolic link/);
    expect(readdirSync(outside)).toEqual(['secret.css']);
    expect((await store.versions(art.id)).length).toBe(1);
  });
});

describe('linked artifacts (version 0) and retrieval commits', () => {
  const link = 'https://claude.ai/artifact/NFaggV4JC9X6prTgKhobKm';

  it('creates version 0 with no files, lists it, reads it empty, and survives a rescan', async () => {
    const { store, s, appData, p, changes } = setup();
    const art = await store.createLinked({ url: link, projectId: p.id });
    expect(art).toMatchObject({ version: 0, fileCount: 0, kind: 'design', title: 'Imported from claude.ai', importedFrom: link, projectId: p.id });
    expect(changes.at(-1)).toEqual({ id: art.id, info: { change: 'created', version: 0, author: 'user' } });
    expect((await store.list()).map((m) => m.id)).toEqual([art.id]);
    expect(await store.read(art.id)).toMatchObject({ content: '', meta: { version: 0 } });
    expect(await store.files(art.id)).toEqual([]);
    expect(await store.versions(art.id)).toEqual([]);
    await expect(store.readFile(art.id, 'index.html')).rejects.toThrow(/no files yet/);
    await expect(store.createLinked({ url: 'https://claude.ai/chat/abc' })).rejects.toMatchObject({ reason: 'bad_link' });

    s.database.db.prepare('DELETE FROM artifacts').run();
    const fresh = new ArtifactStore({ db: s.database, appDataDir: appData, projectPath: (id) => s.projects.pathOf(id) });
    await fresh.rescan([]);
    expect(fresh.metaOf(art.id)).toMatchObject({ version: 0, fileCount: 0 });
  });

  it('records the retrieval state without a version', async () => {
    const { store, changes } = setup();
    const art = await store.createLinked({ url: link });
    const r = await store.setRetrieval(art.id, { status: 'retrieving', agentId: 'agt-1', trigger: 'import', startedAt: 5 });
    expect(r).toMatchObject({ version: 0, retrieval: { status: 'retrieving', agentId: 'agt-1' } });
    expect(changes.at(-1)).toEqual({ id: art.id, info: { change: 'retrieval', version: 0 } });
    expect(store.metaOf(art.id).retrieval?.status).toBe('retrieving');
  });

  it('commitFolder: the first retrieval sets the guessed title and kind, then replaces the whole set', async () => {
    const { store, appData } = setup();
    const art = await store.createLinked({ url: link });
    const src = staging({ 'project/Main.html': '<!doctype html><title>x</title>', 'site.css': 'a{}', 'shots/1.png': PNG, 'canvas.json': '{}' });
    const v1 = await store.commitFolder(art.id, src, { title: 'oIDE docs site', kind: 'design', note: 'Retrieved from claude.ai', author: 'agent:agt-1', retrieval: { status: 'ready', agentId: 'agt-1', trigger: 'import', startedAt: 1, finishedAt: 2, retrievedAt: 2 } });
    expect(v1).toMatchObject({ version: 1, title: 'oIDE docs site', entry: 'project/Main.html', fileCount: 4, retrieval: { status: 'ready' } });
    expect((await store.versions(art.id))[0]).toMatchObject({ version: 1, author: 'agent:agt-1', note: 'Retrieved from claude.ai' });
    const raw = JSON.parse(readFileSync(join(appData, 'artifacts', 'imported-from-claude-ai', 'artifact.json'), 'utf8'));
    expect(raw.oideInternal).toBeUndefined();

    // Update: the agent's title no longer applies; files that are gone go.
    const src2 = staging({ 'index.html': '<!doctype html><p>new</p>', 'site.css': 'b{}' });
    const v2 = await store.commitFolder(art.id, src2, { title: 'Other', note: 'Updated from claude.ai', author: 'agent:agt-2', retrieval: { status: 'ready', trigger: 'update', startedAt: 3 } });
    expect(v2).toMatchObject({ version: 2, title: 'oIDE docs site', entry: 'index.html', fileCount: 2 });
    expect((await store.files(art.id)).map((f) => f.path)).toEqual(['index.html', 'site.css']);
    expect((await store.files(art.id, 1)).length).toBe(4);
  });

  it('commitFolder keeps a title and kind the user gave, and picks the kind from the files when guessed', async () => {
    const { store } = setup();
    const mine = await store.createLinked({ url: link, title: 'My title', kind: 'design' });
    await store.commitFolder(mine.id, staging({ 'index.html': '<p>x</p>' }), { title: 'Agent title', kind: 'doc', note: 'n', author: 'agent:a', retrieval: { status: 'ready', trigger: 'import', startedAt: 1 } });
    expect(store.metaOf(mine.id)).toMatchObject({ title: 'My title', kind: 'design' });

    const guessed = await store.createLinked({ url: link });
    await store.commitFolder(guessed.id, staging({ 'notes/spec.md': '# Spec' }), { note: 'n', author: 'agent:a', retrieval: { status: 'ready', trigger: 'import', startedAt: 1 } });
    expect(store.metaOf(guessed.id)).toMatchObject({ kind: 'doc', entry: 'notes/spec.md', version: 1 });
  });

  it('a refused commit leaves the current version untouched', async () => {
    const { store } = setup();
    const art = await store.createLinked({ url: link, kind: 'design' });
    const retrieval = { status: 'ready' as const, trigger: 'import' as const, startedAt: 1 };
    await expect(store.commitFolder(art.id, staging({ 'shots/1.png': PNG }), { note: 'n', author: 'agent:a', retrieval })).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(store.commitFolder(art.id, staging({ 'a.css': 'x' }), { entry: 'missing.html', note: 'n', author: 'agent:a', retrieval })).rejects.toThrow(/not one of/);
    await expect(store.commitFolder(art.id, staging({ 'a.css': 'x' }), { entry: 'a.css', note: 'n', author: 'agent:a', retrieval })).rejects.toThrow(/HTML page or a React/);
    expect(store.metaOf(art.id)).toMatchObject({ version: 0 });
    expect(store.metaOf(art.id).retrieval).toBeUndefined();
  });

  it('a user rename makes the title theirs', async () => {
    const { store } = setup();
    const art = await store.createLinked({ url: link });
    await store.rename(art.id, 'Imported from claude.ai');
    await store.commitFolder(art.id, staging({ 'index.html': '<p>x</p>' }), { title: 'Agent', note: 'n', author: 'agent:a', retrieval: { status: 'ready', trigger: 'import', startedAt: 1 } });
    expect(store.metaOf(art.id).title).toBe('Imported from claude.ai');
  });
});

describe('rescan of multi-file folders', () => {
  it('keeps a safe entry that exists, falls back otherwise, counts files and finishes an interrupted sync', async () => {
    const { store, s, appData, repo, p } = setup();
    const dir = join(repo, '.oide', 'artifacts', 'site');
    mkdirSync(join(dir, 'pages'), { recursive: true });
    mkdirSync(join(dir, '.versions', '1', 'pages'), { recursive: true });
    for (const base of [dir, join(dir, '.versions', '1')]) {
      writeFileSync(join(base, 'pages', 'Main.html'), '<p>main</p>');
      writeFileSync(join(base, 'site.css'), 'x');
    }
    const now = Date.now();
    const meta = { id: 'site-1', slug: 'site', title: 'Site', kind: 'design', location: 'repo', version: 1, entry: 'pages/Main.html', createdAt: now, updatedAt: now };
    writeFileSync(join(dir, 'artifact.json'), JSON.stringify(meta));
    await store.rescan([{ id: p.id, path: repo }]);
    expect(store.metaOf('site-1')).toMatchObject({ entry: 'pages/Main.html', fileCount: 2 });

    writeFileSync(join(dir, 'artifact.json'), JSON.stringify({ ...meta, entry: '../../../outside.html' }));
    await store.rescan([{ id: p.id, path: repo }]);
    expect(store.metaOf('site-1').entry).toBe('pages/Main.html'); // the default pick: the only page

    // A crash after the snapshot: the root is brought in line with it at the next scan.
    writeFileSync(join(dir, 'artifact.json'), JSON.stringify(meta));
    writeFileSync(join(dir, 'stale.css'), 'old');
    writeFileSync(join(dir, '.versions', '.sync'), '1');
    await store.rescan([{ id: p.id, path: repo }]);
    expect(existsSync(join(dir, 'stale.css'))).toBe(false);
    expect(existsSync(join(dir, '.versions', '.sync'))).toBe(false);
    void s;
    void appData;
  });
});

describe('importFiles from disk', () => {
  it('imports a picked folder keeping relative paths, skipping .git and links', async () => {
    const { store } = setup();
    const src = tempDir('oide-pick-');
    mkdirSync(join(src, 'shots'), { recursive: true });
    mkdirSync(join(src, '.git'), { recursive: true });
    writeFileSync(join(src, 'index.html'), '<!doctype html><title>Docs site</title>');
    writeFileSync(join(src, 'site.css'), 'a{}');
    writeFileSync(join(src, 'shots', 'a.png'), PNG);
    writeFileSync(join(src, '.git', 'HEAD'), 'ref');
    try {
      symlinkSync(tempDir('oide-out-'), join(src, 'linked'), 'junction');
    } catch {
      /* no links: the rest still runs */
    }
    const art = await store.importFiles({ folderPath: src });
    expect(art).toMatchObject({ kind: 'design', entry: 'index.html', title: 'Docs site', fileCount: 3, version: 1 });
    expect((await store.files(art.id)).map((f) => f.path)).toEqual(['index.html', 'shots/a.png', 'site.css']);
  });

  it('imports several picked files; one known file still goes through importFile', async () => {
    const { store } = setup();
    const src = tempDir('oide-pick-');
    writeFileSync(join(src, 'notes.md'), '# Notes');
    writeFileSync(join(src, 'chart.png'), PNG);
    const multi = await store.importFiles({ filePaths: [join(src, 'notes.md'), join(src, 'chart.png')] });
    expect(multi).toMatchObject({ kind: 'doc', entry: 'notes.md', title: 'Notes', fileCount: 2 });
    const one = await store.importFiles({ filePaths: [join(src, 'notes.md')] });
    expect(one).toMatchObject({ kind: 'doc', entry: 'doc.md', fileCount: 1 });
    await expect(store.importFiles({ filePaths: [join(src, 'chart.png')] })).rejects.toMatchObject({ reason: 'wrong_kind' });
    const bad = tempDir('oide-pick-');
    writeFileSync(join(bad, 'index.html'), '<p>x</p>');
    writeFileSync(join(bad, 'aux.css'), 'x');
    await expect(store.importFiles({ folderPath: bad })).rejects.toMatchObject({ reason: 'bad_path' });
  });
});

describe('file helpers', () => {
  it('tells text from binary by extension and content', () => {
    expect(isTextFile('a.css', Buffer.from('a{}'))).toBe(true);
    expect(isTextFile('a.png', Buffer.from('looks like text'))).toBe(false);
    expect(isTextFile('a.dat', Buffer.from([0x61, 0, 0x62]))).toBe(false);
    expect(isTextFile('a.txt', Buffer.from([0xff, 0xfe, 0x41]))).toBe(false);
    // A prefix cut inside a multi-byte character is still text.
    expect(isTextFile('a.txt', Buffer.from('é', 'utf8').subarray(0, 1), true)).toBe(true);
  });

  it('picks the default entry per kind', () => {
    expect(pickEntry('design', ['b/x.html', 'a.html', 'App.jsx'])).toBe('App.jsx');
    expect(pickEntry('design', ['deep/x/y.html', 'top/a.html'])).toBe('top/a.html');
    expect(pickEntry('doc', ['z.md', 'doc.md'])).toBe('doc.md');
    expect(pickEntry('whiteboard', ['canvas.json', 'b.excalidraw'])).toBe('b.excalidraw');
    expect(pickEntry('design', ['a.css'])).toBeUndefined();
  });
});
