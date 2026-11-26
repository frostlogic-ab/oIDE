import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { GhCli, PrInfo, PrLookup } from '@oide/git';
import type { AgentPrInfo, AgentSummary } from '@oide/protocol';
import { GitService } from './git.js';
import { FOCUS_MIN_MS, MAX_BACKOFF_MS, PrWatcher, toAgentPr } from './pr-watch.js';

/**
 * Pull request lifecycle with a fake `gh`: discovery of a PR opened elsewhere, polling of open PRs
 * only, merged → archive once, closed → badge only, backoff on gh errors, no polling offline or
 * without gh; and `git.openPr` returning the existing PR instead of failing.
 */

const URL1 = 'https://github.com/o/r/pull/12';

class FakeGh {
  available_ = true;
  prs = new Map<string, PrInfo | 'error'>();
  calls: string[] = [];
  created: string[] = [];
  drafts: Array<{ title: string; body: string }> = [];
  createError: string | undefined;
  async available() {
    return this.available_;
  }
  async prLookup(_cwd: string, branch: string): Promise<PrLookup> {
    this.calls.push(branch);
    if (!this.available_) return { unavailable: true };
    const pr = this.prs.get(branch);
    if (pr === 'error') return { error: 'HTTP 502: Bad Gateway' };
    return pr ? { pr } : {};
  }
  async prView(cwd: string, branch: string) {
    return (await this.prLookup(cwd, branch)).pr;
  }
  async prCreate(_cwd: string, o: { head?: string; title: string; body: string }) {
    if (this.createError) throw new Error(this.createError);
    this.created.push(o.head ?? '');
    this.drafts.push({ title: o.title, body: o.body });
    const url = `https://github.com/o/r/pull/${20 + this.created.length}`;
    this.prs.set(o.head ?? '', { state: 'open', number: 20 + this.created.length, url });
    return { url };
  }
}

function agent(id: string, extra: Partial<AgentSummary> = {}): AgentSummary {
  return { id, projectId: 'p1', title: `Agent ${id}`, status: 'ready-for-review', mode: 'auto', model: 'opus', branch: `oide/${id}`, worktreePath: `/wt/${id}`, activity: [], contextUsed: 0, contextWindow: 200_000, usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, subagents: [], todos: [], backgroundTasks: 0, createdAt: 1, updatedAt: 1, ...extra };
}

function watcher(list: AgentSummary[], opts: { online?: boolean; trusted?: boolean; interval?: number } = {}) {
  const gh = new FakeGh();
  let now = 1_000_000;
  const merged: Array<[string, AgentPrInfo]> = [];
  const agents = new Map(list.map((a) => [a.id, a]));
  const w = new PrWatcher({
    gh,
    agents: { list: () => [...agents.values()], setPr: (id, pr) => void (agents.get(id) && agents.set(id, { ...agents.get(id)!, ...(pr ? { pr } : {}) })) },
    trusted: () => opts.trusted ?? true,
    intervalMinutes: () => opts.interval ?? 10,
    isOnline: () => opts.online ?? true,
    onMerged: async (a, pr) => void merged.push([a.id, pr]),
    now: () => now,
  });
  return { w, gh, agents, merged, tick: (ms: number) => (now += ms) };
}

describe('PrWatcher', () => {
  it('skips projects without a git remote quietly (no lookup, no warning, no backoff)', async () => {
    const gh = new FakeGh();
    const warnings: unknown[] = [];
    const remotes: Record<string, boolean> = { p1: false, p2: true };
    const marked: string[] = [];
    const w = new PrWatcher({
      gh,
      agents: { list: () => [agent('local'), agent('remote', { projectId: 'p2' })], setPr: () => {} },
      trusted: () => true,
      hasRemote: async (id) => remotes[id] ?? false,
      noRemote: (id) => void marked.push(id),
      intervalMinutes: () => 10,
      onMerged: async () => {},
      log: { debug: () => {}, warn: (...a) => void warnings.push(a) },
    });
    await w.poll('timer');
    expect(gh.calls).toEqual(['oide/remote']);
    // The cache said "has a remote" but gh found none: same quiet skip, and the cache is corrected.
    remotes.p1 = true;
    gh.prLookup = async (_cwd, branch) => (gh.calls.push(branch), branch === 'oide/local' ? { error: 'no git remotes found' } : {});
    const w2 = new PrWatcher({ gh, agents: { list: () => [agent('local')], setPr: () => {} }, trusted: () => true, hasRemote: async (id) => remotes[id] ?? false, noRemote: (id) => void marked.push(id), intervalMinutes: () => 10, onMerged: async () => {}, log: { debug: () => {}, warn: (...a) => void warnings.push(a) } });
    await w2.poll('timer');
    expect(marked).toEqual(['p1']);
    expect(warnings).toEqual([]);
    expect(w2.failureCount).toBe(0);
    expect(w2.backoffUntil).toBe(0);
  });

  it('discovers a PR opened outside oIDE once, then polls only open or draft PRs', async () => {
    const t = watcher([agent('a'), agent('b'), agent('busy', { status: 'running' })]);
    t.gh.prs.set('oide/a', { state: 'open', number: 12, url: URL1 });
    expect(await t.w.poll('timer')).toEqual({ checked: 2 });
    expect(t.gh.calls.sort()).toEqual(['oide/a', 'oide/b']); // never the agent still working
    expect(t.agents.get('a')!.pr).toMatchObject({ number: 12, state: 'open', url: URL1 });
    expect(t.agents.get('b')!.pr).toBeUndefined();
    t.gh.calls = [];
    await t.w.poll('timer');
    // b has no PR and was looked up already this session: only the open PR is polled.
    expect(t.gh.calls).toEqual(['oide/a']);
  });

  it('merged → onMerged once (with the merge commit); closed → state only, no archive', async () => {
    const t = watcher([agent('a', { pr: { number: 12, url: URL1, state: 'open' } }), agent('c', { pr: { number: 13, url: 'https://github.com/o/r/pull/13', state: 'draft' } })]);
    t.gh.prs.set('oide/a', { state: 'merged', number: 12, url: URL1, mergeCommit: 'abc123' });
    t.gh.prs.set('oide/c', { state: 'closed', number: 13, url: 'https://github.com/o/r/pull/13' });
    await t.w.poll('timer');
    expect(t.merged).toEqual([['a', expect.objectContaining({ state: 'merged', mergeCommit: 'abc123', number: 12 })]]);
    expect(t.agents.get('c')!.pr).toMatchObject({ state: 'closed' });
    t.gh.calls = [];
    await t.w.poll('timer');
    // Neither is polled again: merged and closed PRs are final.
    expect(t.gh.calls).toEqual([]);
    expect(t.merged).toHaveLength(1);
  });

  it('backs off exponentially on gh errors and resets after a good round', async () => {
    const t = watcher([agent('a', { pr: { number: 12, url: URL1, state: 'open' } })], { interval: 10 });
    t.gh.prs.set('oide/a', 'error');
    await t.w.poll('timer');
    expect(t.w.failureCount).toBe(1);
    expect(await t.w.poll('timer')).toEqual({ checked: 0, skipped: 'backoff' });
    expect(t.gh.calls).toHaveLength(1);
    t.tick(10 * 60_000);
    await t.w.poll('timer');
    expect(t.w.failureCount).toBe(2);
    expect(t.w.backoffUntil - 1_000_000 - 10 * 60_000).toBe(20 * 60_000);
    expect(t.w.backoffMs(20)).toBe(MAX_BACKOFF_MS);
    t.tick(20 * 60_000);
    t.gh.prs.set('oide/a', { state: 'open', number: 12, url: URL1 });
    await t.w.poll('timer');
    expect(t.w.failureCount).toBe(0);
  });

  it('never polls offline, without gh, for untrusted projects, or more than once per focus window', async () => {
    const off = watcher([agent('a', { pr: { number: 12, url: URL1, state: 'open' } })], { online: false });
    expect(await off.w.poll('timer')).toEqual({ checked: 0, skipped: 'offline' });
    const untrusted = watcher([agent('a')], { trusted: false });
    expect(await untrusted.w.poll('timer')).toEqual({ checked: 0 });
    expect(untrusted.gh.calls).toEqual([]);
    const noGh = watcher([agent('a', { pr: { number: 12, url: URL1, state: 'open' } })]);
    noGh.gh.available_ = false;
    expect(await noGh.w.poll('timer')).toEqual({ checked: 0, skipped: 'gh-unavailable' });
    expect(noGh.gh.calls).toEqual([]);
    const focus = watcher([agent('a', { pr: { number: 12, url: URL1, state: 'open' } })]);
    expect((await focus.w.poll('focus')).checked).toBe(1);
    expect(await focus.w.poll('focus')).toEqual({ checked: 0, skipped: 'throttled' });
    focus.tick(FOCUS_MIN_MS);
    expect((await focus.w.poll('focus')).checked).toBe(1);
  });

  it('toAgentPr keeps only complete https PRs', () => {
    expect(toAgentPr({ state: 'open', number: 3, url: URL1 }, 5)).toEqual({ number: 3, url: URL1, state: 'open', checkedAt: 5 });
    expect(toAgentPr({ state: 'open', url: URL1 }, 5)).toBeUndefined();
    expect(toAgentPr({ state: 'open', number: 3, url: 'javascript:alert(1)' }, 5)).toBeUndefined();
    expect(toAgentPr({ state: 'weird', number: 3, url: URL1 }, 5)).toBeUndefined();
  });
});

describe('GitService.openPr is idempotent', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  function repoWithRemote(): string {
    const run = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, stdio: 'ignore' });
    const remote = mkdtempSync(join(tmpdir(), 'oide-pr-remote-'));
    const repo = mkdtempSync(join(tmpdir(), 'oide-pr-repo-'));
    dirs.push(remote, repo);
    run(remote, 'init', '-q', '--bare');
    run(repo, 'init', '-q', '-b', 'oide/a');
    run(repo, 'config', 'user.name', 't');
    run(repo, 'config', 'user.email', 't@t.invalid');
    run(repo, 'config', 'commit.gpgsign', 'false');
    writeFileSync(join(repo, 'f.txt'), 'x\n');
    run(repo, 'add', '-A');
    run(repo, 'commit', '-q', '-m', 'x');
    run(repo, 'remote', 'add', 'origin', remote);
    return repo;
  }

  function service(a: AgentSummary, gh: FakeGh) {
    const setPr: Array<AgentPrInfo | undefined> = [];
    const svc = new GitService({
      ctx: { log: { debug: () => {}, warn: () => {}, error: () => {} }, emit: () => true } as never,
      store: {} as never,
      settings: { get: () => ({ agents: { fetchIntervalMinutes: 10, cleanup: 'never' } }) } as never,
      worktrees: {} as never,
      projects: { get: () => ({ trusted: true }), require: () => ({ id: 'p1', name: 'P', path: '/not-the-worktree', trusted: true }) } as never,
      agents: { list: () => [a], get: () => a, setDiff: () => {}, setPr: (_id, pr) => void setPr.push(pr) },
      archiveMerged: async () => {},
      removeWorktreeOf: async () => false,
      gh: gh as unknown as GhCli,
    });
    return { svc, setPr };
  }

  it('returns the existing open PR (opened earlier or outside oIDE) instead of failing', async () => {
    const repo = repoWithRemote();
    const gh = new FakeGh();
    gh.prs.set('oide/a', { state: 'open', number: 12, url: URL1 });
    const { svc, setPr } = service(agent('a', { worktreePath: repo, baseRef: 'main' }), gh);
    expect(await svc.openPr('a', 'T', 'B')).toEqual({ url: URL1, number: 12, state: 'open', existing: true });
    expect(gh.created).toEqual([]);
    expect(setPr.at(-1)).toMatchObject({ number: 12, state: 'open' });
    await svc.dispose();
  });

  it('creates one when there is none, and recovers from gh\'s "already exists"', async () => {
    const repo = repoWithRemote();
    const gh = new FakeGh();
    const { svc, setPr } = service(agent('a', { worktreePath: repo, baseRef: 'main' }), gh);
    expect(await svc.openPr('a', 'T', 'B')).toEqual({ url: 'https://github.com/o/r/pull/21', number: 21, state: 'open', existing: false, draft: 'given' });
    expect(setPr.at(-1)).toMatchObject({ number: 21 });
    // Second click: the PR exists now, so no second create.
    expect((await svc.openPr('a', 'T', 'B')).existing).toBe(true);
    expect(gh.created).toHaveLength(1);

    // The lookup misses it but create says it exists: return the one gh then finds.
    const gh2 = new FakeGh();
    const { svc: svc2 } = service(agent('a', { worktreePath: repo, baseRef: 'main' }), gh2);
    gh2.createError = 'gh pr create failed: a pull request for branch "oide/a" into branch "main" already exists:\nhttps://github.com/o/r/pull/12';
    let first = true;
    const orig = gh2.prLookup.bind(gh2);
    gh2.prLookup = async (cwd, branch) => {
      if (first) {
        first = false;
        return {};
      }
      gh2.prs.set('oide/a', { state: 'open', number: 12, url: URL1 });
      return orig(cwd, branch);
    };
    expect(await svc2.openPr('a', 'T', 'B')).toMatchObject({ url: URL1, number: 12, existing: true });
    gh2.createError = 'gh pr create failed: HTTP 422';
    gh2.prs.clear();
    gh2.prLookup = async () => ({});
    await expect(svc2.openPr('a', 'T', 'B')).rejects.toThrow(/HTTP 422/);
    await svc.dispose();
    await svc2.dispose();
  });

  it("writes the PR from the agent's draft, else from the project's template and title rules", async () => {
    const repo = repoWithRemote();
    mkdirSync(join(repo, '.github'), { recursive: true });
    writeFileSync(join(repo, '.github', 'pull_request_template.md'), '## Summary\n\n<!-- What and why. -->\n\n## How I tested it\n\n## Checklist\n\n- [ ] Docs updated\n');
    writeFileSync(join(repo, 'release-please-config.json'), '{}');
    const review = { agentId: 'a', summary: 'Tiles can be filtered by status.', checks: [{ name: 'pnpm test', status: 'passed' as const }], submittedAt: 1 };

    const gh = new FakeGh();
    const { svc } = service(agent('a', { title: 'Add tile filters', worktreePath: repo, review }), gh);
    expect(await svc.openPr('a')).toMatchObject({ existing: false, draft: 'template' });
    expect(gh.drafts[0]!.title).toBe('feat: add tile filters');
    expect(gh.drafts[0]!.body).toContain('## Summary\n\n<!-- What and why. -->\n\nTiles can be filtered by status.');
    expect(gh.drafts[0]!.body).toContain('## How I tested it\n\n- [x] pnpm test');
    expect(gh.drafts[0]!.body).toContain('- [ ] Docs updated');
    await svc.dispose();

    const gh2 = new FakeGh();
    const pr = { title: 'feat(wall): filter tiles by status', body: '## Summary\n\nDrafted by the agent.' };
    const { svc: svc2 } = service(agent('a', { title: 'Add tile filters', worktreePath: repo, review: { ...review, pr } }), gh2);
    expect(await svc2.openPr('a')).toMatchObject({ draft: 'agent' });
    expect(gh2.drafts[0]).toEqual(pr);
    await svc2.dispose();
  });

  it('Push to PR commits follow-up files, pushes them to the open PR and never opens another', async () => {
    const repo = repoWithRemote();
    const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim();
    const gh = new FakeGh();
    const a = agent('a', { worktreePath: repo, baseRef: 'main', review: { agentId: 'a', summary: 'Fix the follow-up review comments', checks: [], submittedAt: 1 } });
    const { svc } = service(a, gh);
    // No PR yet: refused, so Review offers Open pull request instead.
    await expect(svc.pushToPr('a')).rejects.toThrow(/no open pull request/);
    gh.prs.set('oide/a', { state: 'open', number: 12, url: URL1 });
    await svc.openPr('a', 'T', 'B');
    expect(git('rev-parse', 'HEAD')).toBe(git('rev-parse', 'origin/oide/a'));

    // Follow-up work after the PR: one commit by the agent, one new file it did not commit.
    writeFileSync(join(repo, 'g.txt'), 'g\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'agent follow-up');
    writeFileSync(join(repo, 'new-file.txt'), 'new\n');
    expect(await svc.pushToPr('a')).toEqual({ url: URL1, number: 12, state: 'open', committed: true, pushed: 2 });
    expect(git('status', '--porcelain')).toBe('');
    expect(git('rev-parse', 'HEAD')).toBe(git('rev-parse', 'origin/oide/a'));
    expect(git('log', '-1', '--format=%s%n%b')).toMatch(/^Fix the follow-up review comments\n[\s\S]*Oide-Agent: Agent a/);
    expect(gh.created).toEqual([]);

    // Nothing new: still fine, nothing pushed.
    expect(await svc.pushToPr('a')).toMatchObject({ committed: false, pushed: 0 });
    await svc.dispose();
  });

  it('Push to PR waits for a working agent before committing its files', async () => {
    const repo = repoWithRemote();
    const gh = new FakeGh();
    gh.prs.set('oide/a', { state: 'open', number: 12, url: URL1 });
    const { svc } = service(agent('a', { status: 'running', worktreePath: repo, baseRef: 'main' }), gh);
    writeFileSync(join(repo, 'half-written.txt'), 'h\n');
    await expect(svc.pushToPr('a')).rejects.toThrow(/still working/);
    await svc.dispose();
  });
});
