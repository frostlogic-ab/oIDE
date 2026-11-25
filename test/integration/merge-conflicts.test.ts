import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentEvent, AgentSummary } from '../../packages/protocol/src/index.js';
import { cleanup, git, makeRepo, startHarness, waitFor, type Harness } from './harness.js';

/**
 * "Merge into main?" predicts conflicts, and "Ask <agent> to resolve" hands them back to the agent,
 * through the real IPC router against tools/fake-claude (its `resolve-conflicts` scenario runs the
 * `git merge` the message names, keeps both sides and submits for review again). Covers a live
 * agent, a stopped one (resumed), an archived one (unarchived), a deleted worktree, the queue at
 * Max running, the project folder, and the message content.
 */

const open: Harness[] = [];
const dirs: string[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close().catch(() => undefined);
  cleanup(...dirs.splice(0));
});

const strategy = { kind: 'single' as const, lead: { model: 'sonnet' } };

async function harness(): Promise<Harness> {
  const h = await startHarness({ confirm: 'accept' });
  open.push(h);
  dirs.push(h.userData);
  return h;
}

async function agent(h: Harness, id: string): Promise<AgentSummary | undefined> {
  return (await h.call('agents.list', undefined)).find((a) => a.id === id);
}

/** Wait for a status, allowing every tool call the agent asks for on the way. */
async function until(h: Harness, id: string, status: AgentSummary['status'], ms = 30_000): Promise<AgentSummary> {
  return waitFor(
    async () => {
      const s = await agent(h, id);
      if (s?.status === 'needs-permission' && s.pendingPermission) {
        await h.call('agents.answerPermission', { agentId: id, answer: { requestId: s.pendingPermission.requestId, behavior: 'allow' } }).catch(() => undefined);
        return false;
      }
      return s?.status === status && s;
    },
    `${id} → ${status}`,
    ms,
  );
}

/** A project whose agents commit `committed.txt` (fake-claude `commit-work`) and submit for review. */
async function setup(h: Harness, patch: Record<string, unknown> = {}) {
  const repo = makeRepo();
  dirs.push(repo);
  await h.call('settings.update', { patch: { claude: { extraFlags: '--fake-scenario commit-work' }, ...patch } });
  h.allowOpen(repo);
  const project = (await h.call('projects.open', { path: repo }))!;
  return { repo, project };
}

async function readyAgent(h: Harness, projectId: string, title = 'Add committed') {
  const [a] = await h.call('agents.spawn', { projectId, title, goal: 'Commit one file', mode: 'acceptEdits', strategy });
  return until(h, a!.id, 'ready-for-review');
}

/** main changes the same file the agent committed: merging the agent branch conflicts in committed.txt. */
function conflictOnMain(repo: string): string {
  writeFileSync(join(repo, 'committed.txt'), 'main has its own version\n');
  git(repo, 'add', 'committed.txt');
  git(repo, 'commit', '-q', '-m', 'main: committed.txt');
  return git(repo, 'rev-parse', 'HEAD');
}

const userTexts = async (h: Harness, id: string) =>
  (await h.call('agents.events', { agentId: id, limit: 5000 })).filter((e): e is Extract<AgentEvent, { type: 'user-text' }> => e.type === 'user-text');

describe('merge conflicts go back to the agent (main services, fake-claude)', () => {
  it('a live agent: predicted, sent as a message from oIDE, resolved in its worktree, then main merges cleanly by hand', async () => {
    const h = await harness();
    const { repo, project } = await setup(h);
    const a = await readyAgent(h, project.id);
    expect((await h.call('git.predictMerge', { agentId: a.id })).status).toBe('clean');
    const head = conflictOnMain(repo);

    const p = await h.call('git.predictMerge', { agentId: a.id, withMainStatus: true });
    expect(p).toMatchObject({ status: 'conflicts', files: ['committed.txt'], target: { branch: 'main', sha: head }, behind: 1, canAsk: true, mainDirty: [] });

    const sent = await h.call('git.askToResolve', { agentId: a.id });
    expect(sent).toMatchObject({ files: 1, unarchived: false, resumed: false, status: 'running' });
    const busy = (await agent(h, a.id))!;
    expect(busy.mergeConflict).toMatchObject({ target: 'main', targetSha: head, files: ['committed.txt'] });

    // The message: user-visible, marked as sent by oIDE, and says exactly what to do and not do.
    const msg = (await userTexts(h, a.id)).find((e) => e.origin === 'oide')!;
    expect(msg.text.split('\n')[0]).toBe('[Sent by oIDE] Merge conflicts: please resolve them in your worktree.');
    expect(msg.text).toContain(`\`main\` @ ${head.slice(0, 7)}`);
    expect(msg.text).toContain('- "committed.txt"');
    expect(msg.text).toContain('run `git merge main` inside your own worktree');
    expect(msg.text).toMatch(/no fetch is needed/);
    expect(msg.text).toMatch(/keeping the intent of both sides/);
    expect(msg.text).toMatch(/project's checks/);
    expect(msg.text).toMatch(/Commit the merge/);
    expect(msg.text).toMatch(/submit_for_review again/);
    expect(msg.text).toMatch(/Never rebase and never force-push/);
    expect(msg.text).toMatch(/Never touch the main checkout/);
    expect(msg.text).toMatch(/Never run `git merge --abort` without saying why/);

    // The fake agent merges main, keeps both sides, commits and submits: back in Ready for review.
    const back = await until(h, a.id, 'ready-for-review');
    expect(back.mergeConflict).toBeUndefined();
    expect(git(back.worktreePath!, 'log', '-1', '--format=%P').split(' ')).toHaveLength(2);
    // Nothing merged into main on its own; the prediction is fresh again: clean and up to date.
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(head);
    expect(await h.call('git.predictMerge', { agentId: a.id })).toMatchObject({ status: 'clean', behind: 0, files: [] });
    // The user clicks Merge again.
    expect(await h.call('git.mergeLocal', { agentId: a.id })).toMatchObject({ ok: true });
    expect(h.emitErrors).toEqual([]);
  }, 90_000);

  it('a stopped agent is resumed with --resume, and an archived one is unarchived first', async () => {
    const h = await harness();
    const { repo, project } = await setup(h);
    const a = await readyAgent(h, project.id, 'Stopped one');
    const b = await readyAgent(h, project.id, 'Archived one');
    conflictOnMain(repo);

    await h.call('agents.stop', { agentId: a.id });
    await until(h, a.id, 'stopped');
    const r1 = await h.call('git.askToResolve', { agentId: a.id, source: 'prediction' });
    expect(r1).toMatchObject({ resumed: true, unarchived: false, files: 1 });
    expect(['queued', 'starting', 'running']).toContain(r1.status);

    await h.call('agents.archive', { agentId: b.id });
    expect(await agent(h, b.id)).toBeUndefined();
    // Prediction works on the archived agent too (its worktree is kept).
    expect((await h.call('git.predictMerge', { agentId: b.id })).status).toBe('conflicts');
    const r2 = await h.call('git.askToResolve', { agentId: b.id });
    expect(r2).toMatchObject({ unarchived: true, resumed: true, files: 1 });
    expect(await agent(h, b.id)).toBeDefined();

    for (const id of [a.id, b.id]) {
      const done = await until(h, id, 'ready-for-review', 45_000);
      expect(done.mergeConflict).toBeUndefined();
      expect((await userTexts(h, id)).some((e) => e.origin === 'oide')).toBe(true);
    }
    expect((await h.call('git.predictMerge', { agentId: a.id })).status).toBe('clean');
  }, 120_000);

  it('queues behind Max running: the message waits for a free slot', async () => {
    const h = await harness();
    const { repo, project } = await setup(h, { agents: { maxRunning: 1 } });
    const a = await readyAgent(h, project.id, 'Waits');
    conflictOnMain(repo);
    await h.call('agents.stop', { agentId: a.id });
    await until(h, a.id, 'stopped');
    // Another agent holds the only slot.
    const [busy] = await h.call('agents.spawn', { projectId: project.id, title: 'Busy', goal: 'Count [fake-scenario:slow]', mode: 'acceptEdits', strategy });
    await until(h, busy!.id, 'running');

    const r = await h.call('git.askToResolve', { agentId: a.id });
    expect(r).toMatchObject({ status: 'queued', resumed: true });
    await new Promise((res) => setTimeout(res, 500));
    expect((await agent(h, a.id))!.status).toBe('queued');
    expect((await agent(h, a.id))!.mergeConflict?.files).toEqual(['committed.txt']);

    await h.call('agents.stop', { agentId: busy!.id });
    await until(h, a.id, 'ready-for-review', 45_000);
    expect((await h.call('git.predictMerge', { agentId: a.id })).status).toBe('clean');
  }, 90_000);

  it('no action when the worktree is gone or the agent works in the project folder; agents.send cannot fake an oIDE message', async () => {
    const h = await harness();
    const { repo, project } = await setup(h);
    const a = await readyAgent(h, project.id, 'Loses its worktree');
    conflictOnMain(repo);

    // The renderer cannot send a merge-conflicts message itself.
    expect(
      await h.fails('agents.send', { agentId: a.id, message: { kind: 'merge-conflicts', target: 'main', targetSha: 'abcdef1', mergeRef: 'main', fetchFirst: false, files: [], binary: [], submodules: [] } }),
    ).toBe('invalid_input');

    // Worktree folder deleted behind oIDE's back: the prediction still runs, the action is blocked.
    await h.call('agents.stop', { agentId: a.id });
    await until(h, a.id, 'stopped');
    rmSync(a.worktreePath!, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    const p = await h.call('git.predictMerge', { agentId: a.id });
    expect(p).toMatchObject({ status: 'conflicts', canAsk: false });
    expect(p.askBlocked).toMatch(/worktree was deleted/);
    expect(await h.fails('git.askToResolve', { agentId: a.id })).toBe('conflict');
    expect((await agent(h, a.id))!.mergeConflict).toBeUndefined();

    // Discarded with its worktree (and branch): nothing to predict, nothing to ask.
    await h.call('agents.remove', { agentId: a.id, deleteWorktree: true });
    const gone = await h.call('git.predictMerge', { agentId: a.id });
    expect(gone).toMatchObject({ status: 'unavailable', canAsk: false });
    expect(await h.fails('git.askToResolve', { agentId: a.id })).toBe('conflict');

    // An agent in the project folder has no branch: no prediction and no action.
    await h.call('settings.update', { patch: { claude: { extraFlags: '--fake-scenario basic' } } });
    const [pf] = await h.call('agents.spawn', { projectId: project.id, title: 'In place', goal: 'Say hi', workIn: 'project-folder', mode: 'acceptEdits', strategy });
    await until(h, pf!.id, 'has-question');
    expect(await h.call('git.predictMerge', { agentId: pf!.id })).toMatchObject({ status: 'unavailable', canAsk: false, reason: expect.stringMatching(/project folder/) });
    expect(await h.fails('git.askToResolve', { agentId: pf!.id })).toBe('conflict');
  }, 90_000);

  it('main checkout with uncommitted changes: listed up front, and Merge refuses with a clear message', async () => {
    const h = await harness();
    const { repo, project } = await setup(h);
    const a = await readyAgent(h, project.id);
    writeFileSync(join(repo, 'committed.txt'), 'uncommitted in main\n');
    git(repo, 'add', 'committed.txt');
    const p = await h.call('git.predictMerge', { agentId: a.id, withMainStatus: true });
    expect(p.mainDirty).toEqual(['committed.txt']);
    const err = await h.call('git.mergeLocal', { agentId: a.id }).catch((e: Error & { code?: string }) => e);
    expect((err as { code?: string }).code).toBe('conflict');
    expect((err as Error).message).toMatch(/uncommitted changes .*committed\.txt.*Commit or stash them/);
  }, 60_000);
});
