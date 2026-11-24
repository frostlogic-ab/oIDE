import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ArtifactStore, MemorySecretStore, SqliteSecretStore, inferKind, openStore, secretKeys } from '../src/index.js';
import { cleanup, tempDir } from './helpers.js';

afterAll(cleanup);

// Reversible stand-in for Electron safeStorage.
const cipher = {
  encrypt: (s: string) => Buffer.from([...Buffer.from(s, 'utf8')].map((b) => b ^ 0x5a)),
  decrypt: (b: Uint8Array) => Buffer.from([...b].map((x) => x ^ 0x5a)).toString('utf8'),
};

describe('secrets', () => {
  it('keeps ciphertext in SQLite and only accepts namespaced keys', () => {
    const s = openStore(':memory:');
    const secrets = new SqliteSecretStore(s.database, cipher);
    secrets.set(secretKeys.model('local-coder'), 'sk-test-123');
    secrets.set(secretKeys.mcpToken('linear'), 'tok');
    secrets.set(secretKeys.extension('oide-git', 'token'), 'gh');
    expect(secrets.get('model:local-coder')).toBe('sk-test-123');
    const raw = s.database.db.prepare("SELECT ciphertext FROM secrets WHERE key = 'model:local-coder'").get() as { ciphertext: Uint8Array };
    expect(Buffer.from(raw.ciphertext).toString('utf8')).not.toContain('sk-test-123');
    expect(secrets.has('mcp:linear:token')).toBe(true);
    expect(secrets.keys('ext:')).toEqual(['ext:oide-git:token']);
    expect(secrets.deletePrefix('mcp:linear:')).toBe(1);
    expect(secrets.get('mcp:linear:token')).toBeUndefined();
    expect(() => secrets.set('claude:oauth', 'x')).toThrow(/Invalid secret key/);
    expect(() => secrets.set('', 'x')).toThrow();
    expect(() => secrets.deletePrefix('')).toThrow();
    const unavailable = new SqliteSecretStore(s.database, { ...cipher, available: () => false });
    expect(() => unavailable.set('model:x', 'y')).toThrow(/not available/);

    const mem = new MemorySecretStore();
    mem.set('model:a', '1');
    expect(mem.get('model:a')).toBe('1');
    expect(mem.delete('model:a')).toBe(true);
    expect(() => mem.set('nope', '1')).toThrow();
  });
});

function setup() {
  const s = openStore(':memory:');
  const repo = tempDir('oide-repo-');
  const appData = tempDir('oide-appdata-');
  const p = s.projects.open(repo, { name: 'oide' });
  const changes: Array<string | undefined> = [];
  const store = new ArtifactStore({ db: s.database, appDataDir: appData, projectPath: (id) => s.projects.pathOf(id), onChange: (id) => changes.push(id) });
  return { s, repo, appData, p, store, changes };
}

describe('ArtifactStore', () => {
  it('creates each kind with its entry file, artifact.json and version 1', async () => {
    const { store, appData, repo, p } = setup();
    const doc = await store.create({ title: 'Extension manifest RFC', kind: 'doc', content: '# RFC\n' });
    expect(doc).toMatchObject({ slug: 'extension-manifest-rfc', kind: 'doc', location: 'app-data', version: 1, entry: 'doc.md' });
    const dir = join(appData, 'artifacts', 'extension-manifest-rfc');
    expect(readFileSync(join(dir, 'doc.md'), 'utf8')).toBe('---\ntitle: "Extension manifest RFC"\nkind: doc\n---\n\n# RFC\n');
    expect(JSON.parse(readFileSync(join(dir, 'artifact.json'), 'utf8')).id).toBe(doc.id);

    const design = await store.create({ title: 'Main window v2', kind: 'design', projectId: p.id, location: 'repo' });
    expect(existsSync(join(repo, '.oide', 'artifacts', 'main-window-v2', 'index.html'))).toBe(true);
    expect((await store.read(design.id)).content).toContain('<title>Main window v2</title>');

    const board = await store.create({ title: 'Session lifecycle', kind: 'whiteboard', projectId: p.id });
    expect(JSON.parse((await store.read(board.id)).content).type).toBe('excalidraw');
    await expect(store.create({ title: 'Bad', kind: 'whiteboard', content: 'not json' })).rejects.toThrow(/Excalidraw/);
    await expect(store.create({ title: 'x', kind: 'doc', location: 'repo' })).rejects.toThrow(/project/);

    const again = await store.create({ title: 'Extension manifest RFC', kind: 'doc' });
    expect(again.slug).toBe('extension-manifest-rfc-2');

    expect((await store.list()).length).toBe(4);
    expect((await store.list({ projectId: p.id })).map((a) => a.title).sort()).toEqual(['Main window v2', 'Session lifecycle']);
    expect((await store.list({ kind: 'design' })).map((a) => a.id)).toEqual([design.id]);
  });

  it('saves numbered snapshots, logs agent uses and exposes the MCP backend', async () => {
    const { store, changes } = setup();
    const backend = store.backend();
    const created = await backend.create({ title: 'Webhook retry design', kind: 'doc', content: 'v1' }, 'agent-1');
    expect(created.version).toBe(1);
    await backend.read(created.id, 'agent-2');
    const v2 = await backend.write(created.id, 'v2 text', 'agent-1');
    expect(v2.version).toBe(2);
    const v3 = await store.save(created.id, 'v3 text', { note: 'tidy' });
    expect(v3.version).toBe(3);
    // concurrent writes get distinct versions
    const [a, b] = await Promise.all([backend.write(created.id, 'A', 'agent-1'), backend.write(created.id, 'B', 'agent-2')]);
    expect([a.version, b.version].sort()).toEqual([4, 5]);

    const detail = await store.get(created.id);
    expect(detail.content).toBe('B');
    expect(detail.versions.map((v) => v.version)).toEqual([5, 4, 3, 2, 1]);
    expect(detail.versions.find((v) => v.version === 3)).toMatchObject({ author: 'user', note: 'tidy' });
    expect(detail.versions.find((v) => v.version === 2)?.author).toBe('agent:agent-1');
    expect(await store.readVersion(created.id, 2)).toBe('v2 text');
    expect(detail.uses.map((u) => `${u.agentId}:${u.op}`).sort()).toEqual(['agent-1:create', 'agent-1:write', 'agent-1:write', 'agent-2:read', 'agent-2:write']);
    expect(store.usesByAgent('agent-2')).toHaveLength(2);
    expect(changes).toContain(created.id);

    expect(await store.delete(created.id)).toBe(true);
    expect(existsSync(store.root('app-data'))).toBe(true);
    await expect(store.read(created.id)).rejects.toThrow(/Unknown artifact/);
    expect(await store.delete(created.id)).toBe(false);
  });

  it('imports claude.ai links as stubs and dropped files by type', async () => {
    const { store, p } = setup();
    const link = await store.importUrl({ url: 'https://claude.ai/public/artifacts/abc-123', title: 'Pricing page' });
    expect(link).toMatchObject({ importedFrom: 'https://claude.ai/public/artifacts/abc-123', kind: 'doc' });
    expect((await store.read(link.id)).content).toMatch(/importedFrom: "https:\/\/claude.ai\/public\/artifacts\/abc-123"/);
    await expect(store.importUrl({ url: 'https://evil.example.com/x' })).rejects.toThrow(/claude.ai/);
    await expect(store.importUrl({ url: 'http://claude.ai/x' })).rejects.toThrow();

    const dir = tempDir();
    const html = join(dir, 'Invoice page.html');
    writeFileSync(html, '<!doctype html><p>hi</p>');
    const imported = await store.importFile({ filePath: html, projectId: p.id });
    expect(imported).toMatchObject({ title: 'Invoice page', kind: 'design', projectId: p.id });
    const ex = join(dir, 'board.json');
    writeFileSync(ex, JSON.stringify({ type: 'excalidraw', elements: [] }));
    expect((await store.importFile({ filePath: ex })).kind).toBe('whiteboard');
    writeFileSync(join(dir, 'x.bin'), 'x');
    await expect(store.importFile({ filePath: join(dir, 'x.bin') })).rejects.toThrow(/Unknown artifact type/);
    expect(inferKind('a.MD')).toBe('doc');
  });

  it('rescans folders on disk (teammates commit repo artifacts)', async () => {
    const { s, store, repo, p, appData } = setup();
    const a = await store.create({ title: 'Docs IA sketch', kind: 'whiteboard', projectId: p.id, location: 'repo' });
    const b = await store.create({ title: 'Personal', kind: 'doc' });
    // A fresh install with the same folders: empty index.
    s.database.db.prepare('DELETE FROM artifacts').run();
    expect(await store.list()).toEqual([]);
    const fresh = new ArtifactStore({ db: s.database, appDataDir: appData, projectPath: (id) => s.projects.pathOf(id) });
    expect(await fresh.rescan([{ id: p.id, path: repo }])).toBe(2);
    expect((await fresh.list()).map((m) => m.id).sort()).toEqual([a.id, b.id].sort());
    expect((await fresh.list({ projectId: p.id })).map((m) => m.id)).toEqual([a.id]);
  });

  it('ignores a hostile entry in a cloned artifact.json and refuses id hijacking', async () => {
    const { store, repo, p, appData } = setup();
    const secret = join(appData, 'outside.txt');
    writeFileSync(secret, 'SECRET');
    const personal = await store.create({ title: 'Personal', kind: 'doc', content: 'mine' });
    // A cloned repo ships an artifact whose entry points outside its folder and reuses an existing id.
    const evilDir = join(repo, '.oide', 'artifacts', 'evil');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(evilDir, { recursive: true });
    const now = Date.now();
    const evil = { id: 'evil-1', slug: 'evil', title: 'Evil', kind: 'doc', location: 'repo', version: 1, entry: '../../../../outside.txt', createdAt: now, updatedAt: now };
    writeFileSync(join(evilDir, 'artifact.json'), JSON.stringify(evil));
    writeFileSync(join(evilDir, 'doc.md'), 'benign');
    const hijack = { ...evil, id: personal.id, slug: 'hijack', entry: 'doc.md' };
    mkdirSync(join(repo, '.oide', 'artifacts', 'hijack'), { recursive: true });
    writeFileSync(join(repo, '.oide', 'artifacts', 'hijack', 'artifact.json'), JSON.stringify(hijack));
    await store.rescan([{ id: p.id, path: repo }]);
    const read = await store.read('evil-1');
    expect(read.content).toBe('benign');
    expect(read.meta.entry).toBe('doc.md');
    await store.save('evil-1', 'changed');
    expect(readFileSync(secret, 'utf8')).toBe('SECRET');
    expect((await store.read(personal.id)).content).toContain('mine');
  });
});

describe('ArtifactStore symlinks', () => {
  it('refuses to read or write through a symlinked entry file from a cloned repo', async () => {
    const { mkdirSync, symlinkSync } = await import('node:fs');
    const { store, repo, p, appData } = setup();
    const secret = join(appData, 'secret.txt');
    writeFileSync(secret, 'SECRET');
    const dir = join(repo, '.oide', 'artifacts', 'linked');
    mkdirSync(dir, { recursive: true });
    const now = Date.now();
    writeFileSync(join(dir, 'artifact.json'), JSON.stringify({ id: 'linked-1', slug: 'linked', title: 'Linked', kind: 'doc', location: 'repo', version: 1, entry: 'doc.md', createdAt: now, updatedAt: now }));
    try {
      symlinkSync(secret, join(dir, 'doc.md'), 'file');
    } catch {
      return; // creating symlinks needs Developer Mode or admin on Windows; nothing to test here
    }
    await store.rescan([{ id: p.id, path: repo }]);
    await expect(store.read('linked-1')).rejects.toThrow(/symbolic link/);
    await expect(store.save('linked-1', 'overwrite')).rejects.toThrow(/symbolic link/);
    expect(readFileSync(secret, 'utf8')).toBe('SECRET');
  });
});
