import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentSummary } from '@oide/protocol';
import { GitService } from './git.js';

/**
 * Shutdown must not leave git running against a worktree: on Windows an in-flight `git diff`
 * keeps the folder locked, so removing it right after shutdown failed (integration cleanup).
 */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function service(opts: { diffStat: (path: string, base: string) => Promise<{ files: number; additions: number; deletions: number }>; watch?: ConstructorParameters<typeof GitService>[0]['watch'] }) {
  const wt = mkdtempSync(join(tmpdir(), 'oide-git-svc-'));
  dirs.push(wt);
  const agent = { id: 'a1', projectId: 'p1', worktreePath: wt, baseRef: 'HEAD' } as unknown as AgentSummary;
  const diffs: unknown[] = [];
  const changed: string[] = [];
  const svc = new GitService({
    ctx: { log: { debug: () => {}, warn: () => {}, error: () => {} }, emit: (_e: string, p: { projectId: string }) => (changed.push(p.projectId), true) } as never,
    store: {} as never,
    settings: {} as never,
    worktrees: {} as never,
    projects: {} as never,
    agents: { list: () => [agent], get: () => agent, setDiff: (_id, d) => void diffs.push(d) },
    archiveMerged: async () => {},
    removeWorktreeOf: async () => false,
    watch: opts.watch,
    diffStat: opts.diffStat as never,
    debounceMs: 0,
  });
  return { svc, wt, diffs, changed };
}

describe('GitService shutdown', () => {
  it('dispose waits for an in-flight diff refresh and drops its result', async () => {
    let finished = false;
    const { svc, diffs } = service({
      diffStat: () =>
        new Promise((r) =>
          setTimeout(() => {
            finished = true;
            r({ files: 1, additions: 1, deletions: 0 });
          }, 150),
        ),
    });
    void svc.refreshDiff('a1');
    expect(svc.pendingWork).toBe(1);
    await svc.dispose();
    expect(finished).toBe(true);
    expect(svc.pendingWork).toBe(0);
    expect(diffs).toEqual([]); // closed: no summary update after shutdown
  });

  it('cancels debounced refreshes and refuses new ones after dispose', async () => {
    let calls = 0;
    const { svc } = service({ diffStat: async () => (calls++, { files: 0, additions: 0, deletions: 0 }) });
    svc.scheduleDiff('a1', 50);
    await svc.dispose();
    svc.scheduleDiff('a1', 0);
    await svc.refreshDiff('a1');
    await new Promise((r) => setTimeout(r, 80));
    expect(calls).toBe(0);
  });

  it('closes watchers (including ones still subscribing) before dispose resolves', async () => {
    let unsubscribed = 0;
    const { svc, wt } = service({
      diffStat: async () => ({ files: 0, additions: 0, deletions: 0 }),
      watch: () => new Promise((r) => setTimeout(() => r({ unsubscribe: async () => void unsubscribed++ }), 50)),
    });
    svc.watch(wt, 'p1');
    await svc.dispose();
    expect(unsubscribed).toBe(1);
  });

  it('gives up waiting after disposeWaitMs', async () => {
    const { svc } = service({ diffStat: () => new Promise(() => {}) });
    (svc as unknown as { o: { disposeWaitMs: number } }).o.disposeWaitMs = 50;
    void svc.refreshDiff('a1');
    const t = Date.now();
    await svc.dispose();
    expect(Date.now() - t).toBeLessThan(2000);
  });
});
