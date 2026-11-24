import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Harness } from '../integration/harness.js';
import { git, makeRepo, waitFor } from '../integration/harness.js';
import { agentOf, driveTo, gateHarness, single, track, useGateCleanup } from './helpers.js';

/**
 * M3 gate: "A change goes from Spawn to a merged branch without leaving oIDE."
 *
 * Spawn → the agent commits committed.txt (with the `Oide-Agent:` trailer) and leaves pending.txt
 * uncommitted → Review diff lists both → a review comment + Send feedback → second turn edits
 * pending.txt and submits again → Merge locally → the branch is on main.
 *
 * fake-claude scenarios: `commit-work` (turn 1), `address-feedback` (turn 2), `commit-all` (only if
 * Merge locally refuses while there are uncommitted files; one of the two fixes B1 allows).
 */

useGateCleanup();

async function toSecondReview(): Promise<{
  h: Harness;
  repo: string;
  id: string;
  worktree: string;
  branch: string;
  projectId: string;
}> {
  const repo = makeRepo();
  track(repo);
  const h = await gateHarness();
  await h.call('settings.update', {
    patch: {
      claude: { extraFlags: '--fake-scenario commit-work,address-feedback' },
      agents: { cleanup: 'never' },
    },
  });
  const project = (await h.call('projects.open', { path: repo }))!;
  const [spawned] = await h.call('agents.spawn', {
    projectId: project.id,
    title: 'M3 gate',
    goal: 'Add committed.txt and pending.txt',
    mode: 'acceptEdits',
    strategy: single,
  });
  const id = spawned!.id;

  // Turn 1: two Bash prompts (git commit, npm test) answered in oIDE, then submit_for_review.
  const first = await driveTo(h, id, 'ready-for-review');
  expect(first.prompts.map((p) => p.toolName)).toEqual(['Bash', 'Bash']);
  expect(first.agent.review?.summary).toMatch(/pending\.txt is still uncommitted/);
  const worktree = first.agent.worktreePath!;
  const branch = first.agent.branch!;
  expect(branch).toBe('oide/m3-gate');

  // The agent committed one file on its branch and left the other uncommitted.
  expect(git(worktree, 'log', '--format=%s%n%b', 'main..HEAD')).toMatch(
    /Add committed\.txt[\s\S]*Oide-Agent: M3 gate/,
  );
  expect(git(worktree, 'status', '--porcelain')).toContain('pending.txt');

  // Review shows committed + uncommitted changes.
  const diff = await h.call('git.diff', { agentId: id });
  expect(diff.map((d) => d.path).sort()).toEqual(['committed.txt', 'pending.txt']);
  await waitFor(async () => (await agentOf(h, id))?.diff?.files === 2 && true, 'tile diff counts');

  // Comment + feedback → the second turn.
  const comment = await h.call('review.addComment', {
    agentId: id,
    path: 'pending.txt',
    line: 1,
    body: 'Say why this is pending',
  });
  await h.call('review.sendFeedback', { agentId: id, note: 'Then it is good to merge' });
  expect((await h.call('review.comments', { agentId: id })).find((c) => c.id === comment.id)?.sent).toBe(
    true,
  );
  const second = await driveTo(
    h,
    id,
    (a) => a.status === 'ready-for-review' && (a.review?.submittedAt ?? 0) > first.agent.review!.submittedAt,
  );
  expect(second.agent.review?.summary).toMatch(/Addressed the review feedback/);
  expect(readFileSync(join(worktree, 'pending.txt'), 'utf8')).toBe(
    'pending\naddressed: pending.txt:1: Say why this is pending\n',
  );
  const diff2 = await h.call('git.diff', { agentId: id });
  expect(diff2.find((d) => d.path === 'pending.txt')).toMatchObject({ additions: 2 });

  return { h, repo, id, worktree, branch, projectId: project.id };
}

describe('M3 gate: Spawn → Review → feedback → merge locally', { timeout: 60_000 }, () => {
  it('spawn, commit, review diff, feedback, second turn, merge: the agent branch lands on main', async () => {
    const { h, repo, id, branch, projectId } = await toSecondReview();
    const merged = await h
      .call('git.mergeLocal', { agentId: id })
      .catch((err: Error) => ({ ok: false, conflicts: [], error: err.message }));
    if (merged.ok) {
      expect(merged).toEqual({ ok: true, conflicts: [] });
      // The branch's commits are on main, with the agent attribution from the trailer.
      expect(readFileSync(join(repo, 'committed.txt'), 'utf8')).toBe('committed by the agent\n');
      git(repo, 'merge-base', '--is-ancestor', branch, 'main');
      const log = await h.call('git.log', { projectId, ref: 'main', limit: 10 });
      expect(log.some((l) => l.agent === 'M3 gate')).toBe(true);
      expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
    }
    // A refusal must leave the worktree (and its uncommitted change) in place.
    else expect(existsSync(join((await agentOf(h, id))!.worktreePath!, 'pending.txt'))).toBe(true);
  });

  // B1 (review-conformance.md): Merge locally must merge what Review showed, including the
  // uncommitted pending.txt. Today it merges only the branch's commits, reports ok, and pending.txt
  // never reaches main. Remove `.fails` once B1 is fixed.
  it.fails('everything Review showed (committed and uncommitted) ends up on main', async () => {
    const { h, repo, id, branch } = await toSecondReview();
    let merged = await h
      .call('git.mergeLocal', { agentId: id })
      .catch(() => ({ ok: false, conflicts: [] as string[] }));
    if (!merged.ok) {
      // The "refuse while uncommitted" fix: ask the agent to commit, then merge again.
      await h.call('agents.send', {
        agentId: id,
        message: { kind: 'text', text: '[fake-scenario:commit-all] Commit everything, then I will merge.' },
      });
      await driveTo(h, id, 'has-question');
      merged = await h.call('git.mergeLocal', { agentId: id });
    }
    expect(merged).toEqual({ ok: true, conflicts: [] });
    expect(readFileSync(join(repo, 'committed.txt'), 'utf8')).toBe('committed by the agent\n');
    expect(existsSync(join(repo, 'pending.txt')) && readFileSync(join(repo, 'pending.txt'), 'utf8')).toBe(
      'pending\naddressed: pending.txt:1: Say why this is pending\n',
    );
    git(repo, 'merge-base', '--is-ancestor', branch, 'main');
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });
});
