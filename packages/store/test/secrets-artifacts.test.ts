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

  it('never creates an artifact from a link alone, and imports dropped files by type', async () => {
    const { store, p } = setup();
    const url = 'https://claude.ai/public/artifacts/0f8fad5b-d9cb-469f-a165-70867728950e';
    // A link alone (or with blank content) is refused before anything is written.
    await expect(store.importUrl({ url, title: 'Pricing page' })).rejects.toMatchObject({ code: 'invalid_input', reason: 'no_content', message: /Paste the artifact's code/ });
    await expect(store.importUrl({ url, content: '  \n', kind: 'design' })).rejects.toMatchObject({ reason: 'no_content' });
    await expect(store.importUrl({ url: 'https://evil.example.com/x', content: '# x' })).rejects.toMatchObject({ reason: 'bad_link', message: /claude.ai/ });
    await expect(store.importUrl({ url: 'http://claude.ai/artifact/MyEmjmATV3mpUv6SZmFj4T', content: '# x' })).rejects.toThrow();
    await expect(store.importUrl({ url: 'https://claude.ai/chat/0f8fad5b-d9cb-469f-a165-70867728950e', content: '# x' })).rejects.toMatchObject({ reason: 'bad_link', message: /chat link/ });
    await expect(store.importUrl({ url: 'https://claude.ai/settings', content: '# x' })).rejects.toMatchObject({ reason: 'bad_link', message: /isn't a claude.ai artifact link/ });
    expect(await store.list()).toHaveLength(0);
    expect(existsSync(store.root('app-data'))).toBe(false);

    const dir = tempDir();
    const html = join(dir, 'Invoice page.html');
    writeFileSync(html, '<!doctype html><p>hi</p>');
    const imported = await store.importFile({ filePath: html, projectId: p.id });
    expect(imported).toMatchObject({ title: 'Invoice page', kind: 'design', projectId: p.id, entry: 'index.html' });
    const ex = join(dir, 'board.json');
    writeFileSync(ex, JSON.stringify({ type: 'excalidraw', elements: [] }));
    expect((await store.importFile({ filePath: ex })).kind).toBe('whiteboard');
    writeFileSync(join(dir, 'x.bin'), 'x');
    await expect(store.importFile({ filePath: join(dir, 'x.bin') })).rejects.toThrow(/Unknown artifact type/);
    expect(inferKind('a.MD')).toBe('doc');
    expect(inferKind('App.jsx')).toBe('design');
    expect(inferKind('App.tsx')).toBe('design');
    expect(inferKind('logo.svg')).toBe('design');
  });

  it('imports a claude.ai link with the pasted content, the kind and title following the content', async () => {
    const { store, p } = setup();
    const url = 'https://claude.ai/artifact/MyEmjmATV3mpUv6SZmFj4T#open';
    const page = '<!doctype html>\n<html><head><title>Checkout &amp; pay</title></head><body><h1>Pay</h1></body></html>\n';
    const design = await store.importUrl({ url, content: page, projectId: p.id, location: 'repo' });
    expect(design).toMatchObject({ kind: 'design', title: 'Checkout & pay', importedFrom: url, location: 'repo', entry: 'index.html' });
    expect((await store.read(design.id)).content).toBe(page);
    expect(readFileSync(join(store.dirOf(design.id), 'index.html'), 'utf8')).toBe(page);

    const doc = await store.importUrl({ url, content: '﻿# Launch plan\n\nShip it.\n' });
    expect(doc).toMatchObject({ kind: 'doc', title: 'Launch plan' });
    const md = (await store.read(doc.id)).content;
    expect(md).toMatch(/^---\ntitle: "Launch plan"\nkind: doc\nimportedFrom: "https:\/\/claude.ai\/artifact\/MyEmjmATV3mpUv6SZmFj4T#open"\n---\n/);
    expect(md).toContain('# Launch plan\n\nShip it.');

    const board = await store.importUrl({ url, content: JSON.stringify({ type: 'excalidraw', elements: [] }) });
    expect(board).toMatchObject({ kind: 'whiteboard', title: 'Imported from claude.ai' });

    // A title the user typed wins.
    expect(await store.importUrl({ url, content: page, title: 'Mine' })).toMatchObject({ title: 'Mine', kind: 'design' });
  });

  it('imports React artifacts as designs (App.jsx) and switches the entry when the format changes', async () => {
    const { store } = setup();
    const url = 'https://claude.ai/artifact/NFaggV4JC9X6prTgKhobKm#page-dcb81aee8d83';
    const jsx = "import React, { useState } from 'react';\n\nexport default function Pricing() {\n  return <h1 className=\"text-xl\">Plans</h1>;\n}\n";
    const design = await store.importUrl({ url, content: jsx });
    expect(design).toMatchObject({ kind: 'design', entry: 'App.jsx', title: 'Plans', importedFrom: url });
    const dir = store.dirOf(design.id);
    expect(readFileSync(join(dir, 'App.jsx'), 'utf8')).toBe(jsx);
    expect(existsSync(join(dir, 'index.html'))).toBe(false);
    expect((await store.read(design.id)).content).toBe(jsx);

    // Saving HTML over React stores index.html, removes App.jsx, and keeps v1 readable.
    const page = '<!doctype html><p>Plans</p>';
    const v2 = await store.save(design.id, page);
    expect(v2).toMatchObject({ version: 2, entry: 'index.html' });
    expect(existsSync(join(dir, 'App.jsx'))).toBe(false);
    expect((await store.read(design.id)).content).toBe(page);
    expect(await store.readVersion(design.id, 1)).toBe(jsx);
    expect(await store.readVersion(design.id, 2)).toBe(page);
    const v3 = await store.save(design.id, jsx);
    expect(v3).toMatchObject({ version: 3, entry: 'App.jsx' });
    expect(existsSync(join(dir, 'index.html'))).toBe(false);
    expect(JSON.parse(readFileSync(join(dir, 'artifact.json'), 'utf8')).entry).toBe('App.jsx');

    const files = tempDir();
    writeFileSync(join(files, 'Dashboard.jsx'), jsx);
    expect(await store.importFile({ filePath: join(files, 'Dashboard.jsx') })).toMatchObject({ kind: 'design', entry: 'App.jsx', title: 'Dashboard' });
    writeFileSync(join(files, 'notes.jsx'), 'just some words');
    await expect(store.importFile({ filePath: join(files, 'notes.jsx') })).rejects.toMatchObject({ reason: 'wrong_kind' });
  });

  it('refuses pasted content that does not fit the kind, the old placeholder, and links with credentials', async () => {
    const { store } = setup();
    const url = 'https://claude.ai/artifact/MyEmjmATV3mpUv6SZmFj4T';
    await expect(store.importUrl({ url, content: 'Just some notes', kind: 'design' })).rejects.toMatchObject({ code: 'invalid_input', reason: 'wrong_kind', message: /isn't an HTML page or a React component/ });
    await expect(store.importUrl({ url, content: '{"type":', kind: 'whiteboard' })).rejects.toMatchObject({ code: 'invalid_input', reason: 'wrong_kind' });
    await expect(store.importUrl({ url, content: 'x'.repeat(10 * 1024 * 1024 + 1) })).rejects.toMatchObject({ reason: 'too_large', message: /larger than 10 MB/ });
    const stub = `<!doctype html><p>Imported from ${url}. oIDE cannot fetch claude.ai artifacts: open the link, copy the artifact's code and paste it here.</p>`;
    await expect(store.importUrl({ url, content: stub })).rejects.toMatchObject({ reason: 'stub_content' });
    const files = tempDir();
    writeFileSync(join(files, 'stub.html'), stub);
    await expect(store.importFile({ filePath: join(files, 'stub.html') })).rejects.toMatchObject({ reason: 'stub_content' });
    writeFileSync(join(files, 'empty.html'), '  ');
    await expect(store.importFile({ filePath: join(files, 'empty.html') })).rejects.toMatchObject({ reason: 'no_content' });
    await expect(store.importUrl({ url: 'https://user:pw@claude.ai/artifact/MyEmjmATV3mpUv6SZmFj4T', content: '# x' })).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(store.importUrl({ url: 'https://claude.ai.evil.example/artifact/MyEmjmATV3mpUv6SZmFj4T', content: '<p>x</p>' })).rejects.toThrow(/claude.ai/);
    expect(await store.list()).toHaveLength(0);
  });

  it('flags a link-only import made by an older oIDE as brokenImport until real content is saved', async () => {
    const { store } = setup();
    const url = 'https://claude.ai/artifact/NFaggV4JC9X6prTgKhobKm';
    // What older versions stored for "Import link only" (written through create, as they did).
    const notice = `<!doctype html>\n<html lang="en">\n<head><meta charset="utf-8"><title>oIDE website design</title></head>\n<body>\n<p>Imported from ${url}. oIDE cannot fetch claude.ai artifacts: open the link, copy the artifact&#39;s code and paste it here to keep a local copy.</p>\n</body>\n</html>\n`;
    const old = await store.create({ title: 'oIDE website design', kind: 'design', content: notice, importedFrom: url });
    const plain = await store.create({ title: 'Mine', kind: 'design', content: notice });
    expect((await store.read(old.id)).meta.brokenImport).toBe(true);
    expect((await store.get(old.id)).meta.brokenImport).toBe(true);
    expect((await store.list()).find((m) => m.id === old.id)?.brokenImport).toBe(true);
    // Not an import (no link): not flagged.
    expect((await store.read(plain.id)).meta.brokenImport).toBeUndefined();
    // Never stored.
    expect(JSON.parse(readFileSync(join(store.dirOf(old.id), 'artifact.json'), 'utf8')).brokenImport).toBeUndefined();

    const fixed = await store.save(old.id, "export default function Site() { return <main>oIDE</main>; }\n");
    expect(fixed).toMatchObject({ version: 2, entry: 'App.jsx' });
    expect(fixed.brokenImport).toBeUndefined();
    expect((await store.read(old.id)).meta.brokenImport).toBeUndefined();
    expect((await store.list()).find((m) => m.id === old.id)?.brokenImport).toBeUndefined();
  });

  it('flags old link-only whiteboard imports (an empty oIDE board), and never reads big files to check', async () => {
    const { store } = setup();
    const url = 'https://claude.ai/artifact/NFaggV4JC9X6prTgKhobKm';
    // Older versions stored a link-only whiteboard import as oIDE's default empty board.
    const board = await store.create({ title: 'Board', kind: 'whiteboard', importedFrom: url });
    expect((await store.read(board.id)).meta.brokenImport).toBe(true);
    expect((await store.list()).find((m) => m.id === board.id)?.brokenImport).toBe(true);
    // A real import bigger than the placeholder could be is not read by list.
    const big = await store.importUrl({ url, content: '<!doctype html><p>' + 'x'.repeat(20_000) + '</p>' });
    expect((await store.list()).find((m) => m.id === big.id)?.brokenImport).toBeUndefined();
    // Renaming a broken import keeps the flag on what it returns.
    const notice = `<p>Imported from ${url}. oIDE cannot fetch claude.ai artifacts: open the link, copy the code.</p>`;
    const old = await store.create({ title: 'Old', kind: 'design', content: notice, importedFrom: url });
    expect((await store.rename(old.id, 'Old site')).brokenImport).toBe(true);
  });

  it('reads a design whose entry file went missing from the other format (an interrupted switch)', async () => {
    const { store } = setup();
    const page = '<!doctype html><p>Plans</p>';
    const d = await store.create({ title: 'Plans', kind: 'design', content: page });
    // artifact.json and the index say App.jsx, but only index.html is there.
    const dir = store.dirOf(d.id);
    const meta = JSON.parse(readFileSync(join(dir, 'artifact.json'), 'utf8'));
    writeFileSync(join(dir, 'artifact.json'), JSON.stringify({ ...meta, entry: 'App.jsx' }));
    await store.rescan();
    expect(store.metaOf(d.id).entry).toBe('index.html');
    const r = await store.read(d.id);
    expect(r.content).toBe(page);
  });

  it('keeps the claude.ai link of an imported file, and checks non-HTML files picked as a design', async () => {
    const { store } = setup();
    const dir = tempDir();
    const html = join(dir, 'Pricing.html');
    writeFileSync(html, 'Plain text in an .html file');
    const imported = await store.importFile({ filePath: html, url: 'https://claude.ai/artifact/MyEmjmATV3mpUv6SZmFj4T' });
    expect(imported).toMatchObject({ kind: 'design', importedFrom: 'https://claude.ai/artifact/MyEmjmATV3mpUv6SZmFj4T', title: 'Pricing' });
    const md = join(dir, 'notes.md');
    writeFileSync(md, '# Notes');
    await expect(store.importFile({ filePath: md, kind: 'design' })).rejects.toThrow(/isn't an HTML page or a React component/);
    await expect(store.importFile({ filePath: md, url: 'https://example.com/x' })).rejects.toThrow(/claude.ai/);
    expect((await store.importFile({ filePath: md })).importedFrom).toBeUndefined();
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
