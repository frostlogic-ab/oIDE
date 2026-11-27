import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentSummary } from '../../packages/protocol/src/index.js';
import { cleanup, makeRepo, startHarness, waitFor, type Harness } from './harness.js';

/**
 * The artifact agent (Artifacts › open view) through the real IPC router and services, with
 * tools/fake-claude as the agent: artifacts.startAgent starts an agent bound to the artifact in an
 * empty folder under app data; Spawn cannot make one; the MCP backend lets it write only its own
 * artifact; agents.setModel switches its model from the next turn.
 */

const open: Harness[] = [];
const dirs: string[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close().catch(() => undefined);
  cleanup(...dirs.splice(0));
});

async function harness(): Promise<Harness> {
  const h = await startHarness({ confirm: 'accept' });
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

describe('artifact agent (main services, fake-claude)', () => {
  it('starts in its own empty folder, bound to the artifact; one at a time; Spawn cannot make one', async () => {
    const h = await harness();
    const p = await project(h);
    const art = await h.call('artifacts.create', { title: 'Landing page', kind: 'design', projectId: p.id, location: 'app-data', content: '<h1>Hi</h1>' });

    expect(
      await h.fails('agents.spawn', { projectId: p.id, title: 'x', goal: 'y', workIn: 'artifact-folder', artifactId: art.id, mode: 'default', strategy: { kind: 'single', lead: { model: 'sonnet' } } }),
    ).toBe('forbidden');
    expect(await h.fails('artifacts.startAgent', { id: 'nope', text: 'Hi' })).toBe('not_found');

    const a = await h.call('artifacts.startAgent', { id: art.id, text: 'Make the heading bigger.', mode: 'acceptEdits' });
    expect(a).toMatchObject({ artifactId: art.id, workIn: 'artifact-folder', title: 'Edit Landing page', projectId: p.id, mode: 'acceptEdits' });
    expect(await h.fails('artifacts.startAgent', { id: art.id, text: 'Again' })).toBe('busy');

    const idle = await waitFor(async () => {
      const s = await agentOf(h, a.id);
      return s && s.status === 'has-question' && s;
    }, 'artifact agent idle');
    // Its folder sits under app data, never in the repo, and is not a git checkout.
    const root = resolve(h.userData, 'artifact-agents');
    expect(resolve(idle.worktreePath!).startsWith(root)).toBe(true);
    expect(existsSync(join(idle.worktreePath!, '.git'))).toBe(false);
    expect(idle.branch).toBeUndefined();
    // Its first message is the user's direction, as typed.
    const events = await h.call('agents.events', { agentId: a.id, limit: 500 });
    expect(events.find((e) => e.type === 'user-text')).toMatchObject({ text: 'Make the heading bigger.' });

    // The MCP backend main gives the server: it writes only its own artifact and creates none.
    const { mcpArtifacts } = await import('../../apps/desktop/src/main/services/core.js');
    const other = await h.call('artifacts.create', { title: 'Other', kind: 'doc', projectId: p.id, location: 'app-data', content: '# Other' });
    const backend = mcpArtifacts(h.services.artifacts, () => true, { artifactOf: (id) => h.services.agents.supervisor.spec(id)?.artifactId });
    const ctx = { agentId: a.id, projectId: p.id };
    await backend.writeFiles!(ctx, art.id, { files: [{ path: 'index.html', content: '<h1 class="big">Hi</h1>' }], note: 'Bigger heading' });
    expect((await h.call('artifacts.get', { id: art.id })).content).toBe('<h1 class="big">Hi</h1>');
    await expect(backend.writeFiles!(ctx, other.id, { content: '# Changed' })).rejects.toThrow(/only that artifact/);
    await expect(backend.write(ctx, other.id, '# Changed')).rejects.toThrow(/only that artifact/);
    await expect(backend.create(ctx, { title: 'New', kind: 'doc', content: '# New', location: 'app-data' })).rejects.toThrow(/cannot create/);
    // Reading other artifacts is fine.
    expect((await backend.read(ctx, other.id)).content).toContain('# Other');

    // Another model and effort, from the next turn; stored with the spec.
    await h.call('agents.setModel', { agentId: a.id, model: 'opus', effort: 'high' });
    expect(await agentOf(h, a.id)).toMatchObject({ model: 'opus', effort: 'high' });
    expect(h.services.store.agents.get(a.id)?.spec.strategy.lead).toEqual({ model: 'opus', effort: 'high' });
    expect(readdirSync(root)).toHaveLength(1);

    // Deleting the artifact archives its agent and deletes the agent's folder.
    await h.call('artifacts.delete', { id: art.id });
    await waitFor(async () => !(await agentOf(h, a.id)), 'agent archived');
    await waitFor(() => !existsSync(idle.worktreePath!), 'folder deleted');
  }, 60_000);

  it('a personal artifact needs a project to run under', async () => {
    const h = await harness();
    const p = await project(h);
    const art = await h.call('artifacts.create', { title: 'Notes', kind: 'doc', location: 'app-data', content: '# Notes' });
    expect(await h.fails('artifacts.startAgent', { id: art.id, text: 'Tidy it up.' })).toBe('needs_project');
    const a = await h.call('artifacts.startAgent', { id: art.id, text: 'Tidy it up.', projectId: p.id });
    expect(a).toMatchObject({ artifactId: art.id, projectId: p.id });
  }, 60_000);
});
