import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentSummary } from '../../packages/protocol/src/index.js';
import { findFolderHolders } from '../../apps/desktop/src/main/reliability/folder-holders.js';
import { cleanup, git, makeRepo, startHarness, waitFor, type Harness } from './harness.js';

/**
 * The incident behind docs/wiki/pages/git-worktrees.md "Why a worktree can't be deleted on
 * Windows": a process started from the worktree (Docker Desktop there; a node process here) keeps
 * the folder as its current directory after the agent is gone. Discarding the agent must still
 * work, the notice must name the program, Settings › Diagnostics must list the folder, and the
 * retry must finish the job once the program has quit.
 */

const open: Harness[] = [];
const dirs: string[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close().catch(() => undefined);
  cleanup(...dirs.splice(0));
});

const strategy = { kind: 'single' as const, lead: { model: 'sonnet' } };

describe.skipIf(process.platform !== 'win32')('deleting a worktree a program holds open (Windows)', () => {
  it('names the holder, lists the folder, and finishes removing it once the program quits', async () => {
    const h = await startHarness({ confirm: 'accept', findHolders: findFolderHolders });
    open.push(h);
    dirs.push(h.userData);
    const tracked: Array<[string, unknown]> = [];
    h.ctx.telemetry = { service: { track: (name: string, props: unknown) => (tracked.push([name, props]), true) } } as never;

    const repo = makeRepo();
    dirs.push(repo);
    await h.call('settings.update', { patch: { claude: { extraFlags: '--fake-scenario basic' } } });
    h.allowOpen(repo);
    const p = (await h.call('projects.open', { path: repo }))!;
    const [a] = await h.call('agents.spawn', { projectId: p.id, title: 'Runs docker', goal: 'hi', mode: 'acceptEdits', strategy });
    const idle = await waitFor(async () => {
      const s = (await h.call('agents.list', undefined)).find((x) => x.id === a!.id);
      return s?.status === 'has-question' && s;
    }, 'agent idle');
    const wt = (idle as AgentSummary).worktreePath!;

    // A "daemon" started from inside the worktree, outliving the agent.
    const inner = join(wt, 'node_modules', 'pkg');
    mkdirSync(inner, { recursive: true });
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { cwd: inner, stdio: 'ignore', windowsHide: true });
    try {
      await new Promise((r) => setTimeout(r, 300));
      await h.call('agents.remove', { agentId: a!.id, deleteWorktree: true });
      expect((await h.call('agents.getArchived', { agentId: a!.id })).archived?.reason).toBe('discarded');
      expect(existsSync(wt)).toBe(true);

      const notice = await waitFor(() => h.eventsOf('notify').find((n) => /still has this folder open/.test(n.message)), 'holder notice', 20_000);
      expect(notice.message).toBe(`Could not delete the worktree folder ${wt}. Node.js (node.exe) still has this folder open. Quit it, and oIDE will finish removing the folder.`);
      expect(tracked).toContainEqual(['worktree_delete_failed', { holder: 'node' }]);

      const pending = await h.call('app.pendingCleanups', undefined);
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({ name: basename(wt), lastError: 'locked', holders: ['Node.js'] });
      const holders = await h.call('app.cleanupHolders', { path: pending[0]!.path });
      expect(holders.holders.find((x) => x.label === 'Node.js')?.pids).toContain(child.pid);
      // Only queued folders: no probing of arbitrary paths from the renderer.
      expect(await h.fails('app.cleanupHolders', { path: repo })).toBe('not_found');
      expect(await h.fails('app.retryCleanup', { path: repo })).toBe('not_found');
    } finally {
      child.kill();
      await new Promise((r) => (child.exitCode !== null ? r(null) : child.once('exit', r)));
    }

    const r = await h.call('app.retryCleanup', {});
    expect(r.removed).toHaveLength(1);
    expect(existsSync(wt)).toBe(false);
    expect(await h.call('app.pendingCleanups', undefined)).toEqual([]);
    expect(h.eventsOf('notify').some((n) => n.message === `Finished removing ${basename(wt)}`)).toBe(true);
    expect(tracked).toContainEqual(['worktree_delete_retried_ok', { attempts: '1' }]);
    expect(git(repo, 'worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1);
  }, 90_000);
});
