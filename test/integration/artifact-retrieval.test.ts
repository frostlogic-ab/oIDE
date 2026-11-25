import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pathKey } from '../../packages/store/src/index.js';
import type { AgentSummary } from '../../packages/protocol/src/index.js';
import { cleanup, makeRepo, startHarness, tempDir, waitFor, type Harness } from './harness.js';

/**
 * Multi-file artifacts and agent retrieval (ADR 0014) through the real IPC router and services,
 * with tools/fake-claude as the agent: artifacts.importLink starts a queued agent; the MCP backend
 * main gives the MCP server accepts files only from that agent; a finished retrieval is a new
 * version and its agent is archived with its worktree; Update, Cancel, files, readFile, writeFiles,
 * importFiles and dialog.pickArtifactFiles.
 */

const LINK = 'https://claude.ai/artifact/NFaggV4JC9X6prTgKhobKm';
const open: Harness[] = [];
const dirs: string[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close().catch(() => undefined);
  cleanup(...dirs.splice(0));
});

async function harness(opts: Parameters<typeof startHarness>[0] = {}): Promise<Harness> {
  const h = await startHarness({ confirm: 'accept', ...opts });
  open.push(h);
  dirs.push(h.userData);
  return h;
}

async function project(h: Harness) {
  const repo = makeRepo();
  dirs.push(repo);
  h.allowOpen(repo);
  return (await h.call('projects.open', { path: repo }))!;
}

const agentOf = async (h: Harness, id: string): Promise<AgentSummary | undefined> => (await h.call('agents.list', undefined)).find((a) => a.id === id);

describe('artifact retrieval (main services, fake-claude)', () => {
  it('importLink → retrieving agent → files handed over by that agent only → version 1, agent archived, worktree removed', async () => {
    const h = await harness();
    const p = await project(h);
    expect(await h.fails('artifacts.importLink', { url: 'https://claude.ai/chat/0b5c4d5e-1111-2222-3333-444455556666', projectId: p.id })).toBe('invalid_input');
    expect(await h.call('artifacts.list', {})).toEqual([]);

    const art = await h.call('artifacts.importLink', { url: LINK, projectId: p.id });
    expect(art).toMatchObject({ version: 0, kind: 'design', importedFrom: LINK, retrieval: { status: 'retrieving', trigger: 'import' } });
    const agentId = art.retrieval!.agentId!;
    const a = await waitFor(() => agentOf(h, agentId), 'retrieval agent on the Wall');
    expect(a.title).toBe('Retrieve Imported from claude.ai');
    expect(h.eventsOf('artifacts.changed')).toContainEqual({ id: art.id, change: 'retrieval', version: 0 });
    expect(await h.fails('artifacts.refresh', { id: art.id })).toBe('busy');
    // The fake ends its turn without finishing: an idle agent keeps the retrieval running.
    const idle = await waitFor(async () => {
      const s = await agentOf(h, agentId);
      return s && s.status === 'has-question' && s;
    }, 'agent idle');
    expect((await h.call('artifacts.get', { id: art.id })).meta.retrieval?.status).toBe('retrieving');
    // Its preview is a 404 until files arrive.
    const { resolveArtifactRequest } = await import('../../apps/desktop/src/main/services/artifact-preview.js');
    expect(await resolveArtifactRequest(h.services.artifacts, (await h.call('artifacts.previewUrl', { id: art.id })).url, undefined)).toBeNull();

    // The MCP backend main hands the server: the retrieval agent sees the tools, another agent is refused.
    const { mcpArtifacts } = await import('../../apps/desktop/src/main/services/core.js');
    const backend = mcpArtifacts(h.services.artifacts, () => true, { worktreeOf: (id) => h.services.agents.supervisor.get(id)?.worktreePath, retrieval: () => h.services.retrieval });
    expect(backend.isRetrievalAgent!(agentId)).toBe(true);
    await expect(backend.retrievalAddFiles!({ agentId: 'someone-else', projectId: p.id }, art.id, [{ path: 'index.html', content: 'x' }])).rejects.toThrow(/Only the agent/);
    mkdirSync(join(idle.worktreePath!, 'dl'), { recursive: true });
    writeFileSync(join(idle.worktreePath!, 'dl', 'home.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await backend.retrievalAddFiles!({ agentId, projectId: p.id }, art.id, [
      { path: 'index.html', content: '<!doctype html><title>oIDE docs</title><link rel="stylesheet" href="site.css"><img src="shots/home.png">' },
      { path: 'site.css', content: 'body{}' },
      { path: 'shots/home.png', fromFile: 'dl/home.png' },
    ]);
    const done = await backend.retrievalFinish!({ agentId, projectId: p.id }, art.id, { ok: true, entry: 'index.html', title: 'oIDE docs site', kind: 'design' });
    expect(done).toMatchObject({ status: 'ready', version: 1 });

    const meta = (await h.call('artifacts.get', { id: art.id })).meta;
    expect(meta).toMatchObject({ version: 1, title: 'oIDE docs site', fileCount: 3, retrieval: { status: 'ready' } });
    expect((await h.call('artifacts.files', { id: art.id })).map((f) => [f.path, f.text])).toEqual([
      ['index.html', true],
      ['shots/home.png', false],
      ['site.css', true],
    ]);
    expect(await h.call('artifacts.readFile', { id: art.id, path: 'shots/home.png' })).toEqual({ encoding: 'base64', data: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64') });
    const url = (await h.call('artifacts.previewUrl', { id: art.id })).url;
    expect(url).toBe(`oide-artifact://${encodeURIComponent(art.id)}/index.html`);
    expect(await resolveArtifactRequest(h.services.artifacts, url.replace('index.html', 'shots/home.png'), undefined)).toMatchObject({ mime: 'image/png' });

    // The agent was idle, so it is archived at once, with its worktree.
    await waitFor(async () => !(await agentOf(h, agentId)), 'retrieval agent archived');
    await waitFor(() => !existsSync(idle.worktreePath!), 'worktree removed');
    expect(h.services.agents.getArchived(agentId).archived).toMatchObject({ reason: 'completed', worktreeRemoved: true });
    expect(h.emitErrors).toEqual([]);
  }, 60_000);

  it('Update starts a new agent; Cancel stops it and keeps the version; a failed finish keeps it too', async () => {
    const h = await harness();
    const p = await project(h);
    const linked = await h.services.artifacts.createLinked({ url: LINK });
    // No project of its own and none given: the user has to choose one.
    expect(await h.fails('artifacts.refresh', { id: linked.id })).toBe('needs_project');
    const started = await h.call('artifacts.refresh', { id: linked.id, projectId: p.id });
    expect(started.retrieval).toMatchObject({ status: 'retrieving', trigger: 'retry' });
    const cancelled = await h.call('artifacts.cancelRetrieval', { id: linked.id });
    expect(cancelled).toMatchObject({ version: 0, retrieval: { status: 'failed', error: 'Cancelled' } });
    await waitFor(async () => (await agentOf(h, started.retrieval!.agentId!))?.status === 'stopped', 'agent stopped');
    expect(await h.fails('artifacts.cancelRetrieval', { id: linked.id })).toBe('conflict');

    const again = await h.call('artifacts.refresh', { id: linked.id, projectId: p.id });
    const r = await h.services.retrieval.finish(again.retrieval!.agentId!, linked.id, { ok: false, reason: 'Claude Code CLI has no tool that can read claude.ai Design artifacts.' });
    expect(r.status).toBe('failed');
    expect((await h.call('artifacts.get', { id: linked.id })).meta.retrieval).toMatchObject({ status: 'failed', error: 'Claude Code CLI has no tool that can read claude.ai Design artifacts.' });
    // A local artifact has nothing to refresh from.
    const local = await h.call('artifacts.create', { title: 'Local', kind: 'doc', content: 'x' });
    expect(await h.fails('artifacts.refresh', { id: local.id, projectId: p.id })).toBe('invalid_input');
    expect(await h.fails('artifacts.refresh', { id: 'missing' })).toBe('not_found');
    expect(h.emitErrors).toEqual([]);
  }, 60_000);

  it('writeFiles, files and readFile through IPC; importFiles accepts only picked or dropped paths', async () => {
    const h = await harness();
    const art = await h.call('artifacts.create', { title: 'Site', kind: 'design', content: '<!doctype html><p>x</p>' });
    const v2 = await h.call('artifacts.writeFiles', { id: art.id, files: [{ path: 'site.css', encoding: 'utf8', data: 'a{}' }], note: 'CSS', baseVersion: 1 });
    expect(v2).toMatchObject({ version: 2, fileCount: 2 });
    expect(await h.fails('artifacts.writeFiles', { id: art.id, files: [{ path: 'x.css', encoding: 'utf8', data: '' }], baseVersion: 1 })).toBe('conflict');
    expect(await h.fails('artifacts.writeFiles', { id: art.id, files: [{ path: '../x.css', encoding: 'utf8', data: '' }] })).toBe('invalid_input');
    expect(await h.fails('artifacts.readFile', { id: art.id, path: 'artifact.json' })).toBe('invalid_input');
    expect((await h.call('artifacts.files', { id: art.id, version: 1 })).map((f) => f.path)).toEqual(['index.html']);
    expect(h.eventsOf('artifacts.changed').at(-1)).toEqual({ id: art.id, change: 'saved', version: 2, author: 'user' });

    const src = tempDir('oide-pick-');
    dirs.push(src);
    mkdirSync(join(src, 'shots'));
    writeFileSync(join(src, 'index.html'), '<!doctype html><title>Picked</title>');
    writeFileSync(join(src, 'shots', 'a.png'), Buffer.from([1, 2]));
    expect(await h.fails('artifacts.importFiles', { folderPath: src })).toBe('forbidden_path');
    // What dialog.pickArtifactFiles (or a drop) registers.
    h.services.picked.add(pathKey(resolve(src)));
    const imported = await h.call('artifacts.importFiles', { folderPath: src });
    expect(imported).toMatchObject({ title: 'Picked', kind: 'design', entry: 'index.html', fileCount: 2 });
    expect(await h.fails('artifacts.importFiles', { filePaths: [join(src, 'index.html'), join(src, 'shots', 'a.png')] })).toBe('forbidden_path');
  });

  it('artifacts.restore brings back every file of a version through IPC, refusing a stale base', async () => {
    const h = await harness();
    const art = await h.call('artifacts.create', { title: 'Site', kind: 'design', content: '<!doctype html><p>one</p>' });
    await h.call('artifacts.writeFiles', { id: art.id, files: [{ path: 'site.css', encoding: 'utf8', data: 'a{}' }, { path: 'shots/a.png', encoding: 'base64', data: 'AQI=' }], baseVersion: 1 });
    await h.call('artifacts.writeFiles', { id: art.id, files: [{ path: 'site.css', encoding: 'utf8', data: 'b{}' }], deletes: ['shots/a.png'], baseVersion: 2 });
    expect(await h.fails('artifacts.restore', { id: art.id, version: 2, baseVersion: 2 })).toBe('conflict');
    expect(await h.fails('artifacts.restore', { id: art.id, version: 9 })).toBe('invalid_input');
    expect(await h.fails('artifacts.restore', { id: 'nope', version: 1 })).toBe('not_found');
    const restored = await h.call('artifacts.restore', { id: art.id, version: 2, baseVersion: 3 });
    expect(restored).toMatchObject({ version: 4, entry: 'index.html', fileCount: 3 });
    expect((await h.call('artifacts.files', { id: art.id })).map((f) => f.path)).toEqual(['index.html', 'shots/a.png', 'site.css']);
    expect(await h.call('artifacts.readFile', { id: art.id, path: 'site.css' })).toEqual({ encoding: 'utf8', data: 'a{}' });
    expect((await h.call('artifacts.get', { id: art.id })).versions[0]).toMatchObject({ version: 4, author: 'user', note: 'Restored v2' });
    expect(h.eventsOf('artifacts.changed').at(-1)).toEqual({ id: art.id, change: 'saved', version: 4, author: 'user' });
  });

  it('dialog.pickArtifactFiles registers the picked files or folder', async () => {
    const src = tempDir('oide-pick-');
    dirs.push(src);
    writeFileSync(join(src, 'a.md'), '# A');
    writeFileSync(join(src, 'b.png'), Buffer.from([1]));
    const h = await harness({ platform: { pickFiles: async () => [join(src, 'a.md'), join(src, 'b.png')], pickFolder: async () => src } });
    expect(await h.call('dialog.pickArtifactFiles', { folder: false })).toEqual([join(src, 'a.md'), join(src, 'b.png')]);
    const doc = await h.call('artifacts.importFiles', { filePaths: [join(src, 'a.md'), join(src, 'b.png')] });
    expect(doc).toMatchObject({ kind: 'doc', entry: 'a.md', fileCount: 2 });
    expect(await h.call('dialog.pickArtifactFiles', { folder: true })).toEqual([src]);
    expect((await h.call('artifacts.importFiles', { folderPath: src })).fileCount).toBe(2);
  });

  it('a retrieval whose agent is gone at the next start fails; deleting an artifact cancels its retrieval', async () => {
    const h = await harness();
    const p = await project(h);
    const art = await h.call('artifacts.importLink', { url: LINK, projectId: p.id });
    const agentId = art.retrieval!.agentId!;
    await waitFor(() => agentOf(h, agentId), 'agent');
    // The agent is removed behind the retrieval's back (Delete permanently).
    await h.services.agents.deletePermanently(agentId);
    await waitFor(async () => (await h.call('artifacts.get', { id: art.id })).meta.retrieval?.status === 'failed', 'retrieval failed');
    expect((await h.call('artifacts.get', { id: art.id })).meta.retrieval?.error).toMatch(/stopped before it handed over/);

    const second = await h.call('artifacts.importLink', { url: LINK, projectId: p.id });
    await waitFor(() => agentOf(h, second.retrieval!.agentId!), 'second agent');
    expect(await h.call('artifacts.delete', { id: second.id })).toEqual({ ok: true });
    await waitFor(async () => (await agentOf(h, second.retrieval!.agentId!))?.status === 'stopped', 'second agent stopped');
  }, 60_000);
});
