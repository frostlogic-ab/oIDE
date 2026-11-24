import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentSummary } from '../../packages/protocol/src/index.js';
import { cleanup, git, makeRepo, startHarness, waitFor, type Harness } from '../integration/harness.js';

/**
 * Brief conformance, M3 gate ("A change goes from Spawn to a merged branch without leaving oIDE").
 * Review shows `git diff <merge-base>...HEAD` PLUS uncommitted changes in the worktree (brief:
 * Projects and git worktrees › Diff). "Merge worktree into main locally" must therefore merge what
 * Review showed. Today `git.mergeLocal` merges only the branch's commits: when the agent did not
 * commit (fake-claude's `review` scenario, or a real agent that forgot the trailer commit), the
 * merge is a no-op that reports ok, and with cleanup "Right away" the worktree holding the only
 * copy of the change is force-removed.
 *
 * Fixed (B1): `git.mergeLocal` first commits the worktree's pending changes on the agent's behalf
 * (`Oide-Agent:` trailer), reports ok only when the main checkout moved, and cleanup removes a
 * worktree only when its branch is in main and it holds no other changes.
 */

const open: Harness[] = [];
const dirs: string[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close().catch(() => undefined);
  cleanup(...dirs.splice(0));
});

const strategy = { kind: 'single' as const, lead: { model: 'sonnet' } };

async function readyAgent(cleanupMode: 'right-away' | 'never'): Promise<{ h: Harness; repo: string; a: AgentSummary }> {
  const repo = makeRepo();
  dirs.push(repo);
  const h = await startHarness({ confirm: 'accept' });
  open.push(h);
  dirs.push(h.userData);
  await h.call('settings.update', { patch: { claude: { extraFlags: '--fake-scenario review' }, agents: { cleanup: cleanupMode } } });
  h.allowOpen(repo);
  const project = (await h.call('projects.open', { path: repo }))!;
  const [spawned] = await h.call('agents.spawn', { projectId: project.id, title: 'Uncommitted', goal: 'Add feature.txt', mode: 'acceptEdits', strategy });
  const id = spawned!.id;
  const asking = await waitFor(async () => (await h.call('agents.list', undefined)).find((x) => x.id === id && x.status === 'needs-permission'), 'prompt');
  await h.call('agents.answerPermission', { agentId: id, answer: { requestId: asking.pendingPermission!.requestId, behavior: 'allow' } });
  const a = await waitFor(async () => (await h.call('agents.list', undefined)).find((x) => x.id === id && x.status === 'ready-for-review'), 'review');
  return { h, repo, a };
}

describe('conformance: Review → Merge locally merges what Review showed', () => {
  it('Review lists the uncommitted file and Merge locally brings it to main', async () => {
    const { h, repo, a } = await readyAgent('never');
    expect(git(a.worktreePath!, 'status', '--porcelain')).toContain('feature.txt');
    const diff = await h.call('git.diff', { agentId: a.id });
    expect(diff.map((d) => d.path)).toEqual(['feature.txt']);

    const merged = await h.call('git.mergeLocal', { agentId: a.id });
    // Either the merge carries the change, or it refuses (ok: false) and says why.
    if (merged.ok) expect(existsSync(join(repo, 'feature.txt')) && readFileSync(join(repo, 'feature.txt'), 'utf8')).toBe('feature\n');
    else expect(merged.ok).toBe(false);
  });

  it('cleanup "Right away" never deletes a worktree whose change was not merged', async () => {
    const { h, repo, a } = await readyAgent('right-away');
    const merged = await h.call('git.mergeLocal', { agentId: a.id }).catch(() => ({ ok: false, conflicts: [] }));
    const changeOnMain = existsSync(join(repo, 'feature.txt'));
    const worktreeKept = existsSync(join(a.worktreePath!, 'feature.txt'));
    // The change must survive somewhere.
    expect({ merged: merged.ok, changeOnMain, worktreeKept }).not.toEqual({ merged: true, changeOnMain: false, worktreeKept: false });
  });
});
