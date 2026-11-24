import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Commands, type AgentSummary } from '../../packages/protocol/src/index.js';
import { cleanup, git, makeRepo, startHarness, tempDir, waitFor, type Harness } from './harness.js';

/**
 * The main-process services layer in plain Node (no Electron) against tools/fake-claude, driven
 * through the real IPC router (Zod-validated input and output), exactly as the renderer calls it.
 */

const open: Harness[] = [];
const dirs: string[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close().catch(() => undefined);
  cleanup(...dirs.splice(0));
});

async function harness(opts: Parameters<typeof startHarness>[0] = {}): Promise<Harness> {
  const h = await startHarness(opts);
  open.push(h);
  dirs.push(h.userData);
  return h;
}

const strategy = { kind: 'single' as const, lead: { model: 'sonnet' } };

async function agent(h: Harness, id: string): Promise<AgentSummary | undefined> {
  return (await h.call('agents.list', undefined)).find((a) => a.id === id);
}
const status = (h: Harness, id: string, s: AgentSummary['status'], ms?: number) =>
  waitFor(async () => {
    const a = await agent(h, id);
    return a?.status === s && a;
  }, `${id} → ${s}`, ms);

describe('main services (plain Node, fake-claude)', () => {
  it('registers a handler for every command in the IPC contract', async () => {
    const h = await harness();
    const missing: string[] = [];
    for (const name of Object.keys(Commands)) {
      const code = await h.fails(name as never, Symbol('bad') as never).catch(() => 'ok');
      if (code === 'not_implemented') missing.push(name);
    }
    // shell.* need Electron's shell module and are registered by handlers/shell.ts in the app.
    expect(missing.filter((m) => !m.startsWith('shell.'))).toEqual([]);
  });

  it('project → spawn in a worktree → permission → review → diff → feedback → merge → cleanup', async () => {
    const repo = makeRepo();
    dirs.push(repo);
    const h = await harness();
    await h.call('settings.update', { patch: { claude: { extraFlags: '--fake-scenario review' }, agents: { cleanup: 'right-away' } } });

    expect(await h.fails('projects.open', { path: tempDir('oide-int-notrepo-') })).toBe('not_a_repo');
    const project = (await h.call('projects.open', { path: repo }))!;
    expect(project.trusted).toBe(true);
    expect(h.eventsOf('projects.changed').at(-1)?.map((p) => p.id)).toContain(project.id);
    expect((await h.call('projects.open', { path: join(repo) }))!.id).toBe(project.id);
    expect(await h.call('scope.set', { scope: project.id })).toBe(project.id);
    expect(await h.call('scope.get', undefined)).toBe(project.id);

    const [a] = await h.call('agents.spawn', { projectId: project.id, title: 'Add feature', goal: 'Add feature.txt', mode: 'acceptEdits', strategy });
    const asking = await status(h, a!.id, 'needs-permission');
    expect(asking.worktreePath && existsSync(asking.worktreePath)).toBeTruthy();
    expect(asking.worktreePath!.startsWith(join(h.userData, 'worktrees'))).toBe(true);
    expect(asking.branch).toBe('oide/add-feature');
    expect(asking.pendingPermission).toMatchObject({ toolName: 'Bash', summary: 'Run npm test' });
    expect(h.notifications.some((n) => /needs permission/.test(n))).toBe(true);
    // The renderer retires this toast when exactly this prompt resolves.
    expect(h.eventsOf('notify').find((n) => n.kind === 'needs-permission')).toMatchObject({ agentId: a!.id, requestId: asking.pendingPermission!.requestId });
    // A repo without a remote cannot open a pull request (m6).
    expect(await h.call('git.prAvailable', { projectId: project.id })).toMatchObject({ available: false, reason: expect.stringMatching(/no git remote/) });

    // Only the exact pending id is accepted.
    expect(await h.fails('agents.answerPermission', { agentId: a!.id, answer: { requestId: 'perm-bogus', behavior: 'allow' } })).toBe('not_found');
    await h.call('agents.answerPermission', { agentId: a!.id, answer: { requestId: asking.pendingPermission!.requestId, behavior: 'allow', always: true } });
    const ready = await status(h, a!.id, 'ready-for-review');
    expect(ready.review).toMatchObject({ summary: 'Added feature.txt.', checks: [{ name: 'npm test', status: 'passed' }] });
    // "Always in <project>" wrote the rule to .oide/permissions.json.
    expect((await h.call('settings.projectPermissions', { projectId: project.id })).allow).toContain('Bash(npm test)');

    const diff = await h.call('git.diff', { agentId: a!.id });
    expect(diff.map((d) => d.path)).toEqual(['feature.txt']);
    expect(diff[0]).toMatchObject({ status: 'added', additions: 1 });
    await waitFor(async () => (await agent(h, a!.id))?.diff?.files === 1 && true, 'tile diff counts');
    const wts = await h.call('git.worktrees', { projectId: project.id });
    expect(wts).toHaveLength(1);
    expect(wts[0]).toMatchObject({ agentId: a!.id, branch: 'oide/add-feature', changedFiles: ['feature.txt'], orphaned: false });

    // Files: tree/read through the worktree root, path guard, editing agents.
    const tree = await h.call('files.tree', { root: ready.worktreePath!, dir: '' });
    expect(tree.map((n) => n.name)).toEqual(expect.arrayContaining(['README.md', 'feature.txt']));
    expect(tree.some((n) => n.name === '.git')).toBe(false);
    expect((await h.call('files.read', { root: ready.worktreePath!, path: 'feature.txt' })).content).toBe('feature\n');
    expect(await h.fails('files.read', { root: ready.worktreePath!, path: '../../../../etc/passwd' })).toBe('forbidden_path');
    expect(await h.fails('files.tree', { root: tempDir('oide-int-outside-'), dir: '' })).toBe('forbidden_path');

    // Review comments → one review-feedback message with file:line refs; comments marked sent.
    const c = await h.call('review.addComment', { agentId: a!.id, path: 'feature.txt', line: 1, body: 'Say more' });
    expect(c.side).toBe('new');
    const old = await h.call('review.addComment', { agentId: a!.id, path: 'feature.txt', line: 1, side: 'old', body: 'Was fine' });
    expect((await h.call('review.comments', { agentId: a!.id })).find((x) => x.id === old.id)).toMatchObject({ line: 1, side: 'old' });
    await h.call('review.sendFeedback', { agentId: a!.id, note: 'Thanks' });
    expect((await h.call('review.comments', { agentId: a!.id })).find((x) => x.id === c.id)?.sent).toBe(true);
    const userTexts = await waitFor(async () => {
      const evs = await h.call('agents.events', { agentId: a!.id, limit: 500 });
      return evs.filter((e) => e.type === 'user-text').length >= 2 && evs;
    }, 'feedback delivered');
    expect(JSON.stringify(userTexts)).toContain('Review feedback');
    // The second turn runs the same scenario (the live process keeps its launch-time allow rules).
    const again = await status(h, a!.id, 'needs-permission');
    expect(again.pendingPermission!.requestId).not.toBe(asking.pendingPermission!.requestId);
    await h.call('agents.answerPermission', { agentId: a!.id, answer: { requestId: again.pendingPermission!.requestId, behavior: 'allow' } });
    await waitFor(async () => {
      const s = await agent(h, a!.id);
      return s?.status === 'ready-for-review' && (s.review?.submittedAt ?? 0) > ready.review!.submittedAt && s;
    }, 'second review');

    // The agent's work is committed in its worktree (as agents do), then merged locally.
    git(ready.worktreePath!, 'add', '-A');
    git(ready.worktreePath!, 'commit', '-q', '-m', 'Add feature', '-m', 'Oide-Agent: Add feature');
    const merged = await h.call('git.mergeLocal', { agentId: a!.id });
    expect(merged).toEqual({ ok: true, conflicts: [] });
    expect(readFileSync(join(repo, 'feature.txt'), 'utf8')).toBe('feature\n');
    const log = await h.call('git.log', { projectId: project.id, ref: 'HEAD', limit: 5 });
    expect(log.some((l) => l.agent === 'Add feature')).toBe(true);
    // Cleanup "Right away": worktree and branch removed, agent gone.
    await waitFor(() => !existsSync(ready.worktreePath!) && true, 'worktree removed');
    expect(git(repo, 'branch', '--list', 'oide/add-feature')).toBe('');
    expect(await agent(h, a!.id)).toBeUndefined();
    expect(h.eventsOf('agents.removed').some((e) => e.agentId === a!.id)).toBe(true);
    expect(h.eventsOf('agents.batch').length).toBeGreaterThan(0);
    const usage = await h.call('usage.summary', undefined);
    expect(usage.projectsOpen).toBe(1);
    expect(usage.tokensToday).toBeGreaterThan(0);
  });

  it('untrusted projects never run .oide/setup; trusted ones do', async () => {
    const repo = makeRepo();
    dirs.push(repo);
    const { writeFileSync, mkdirSync } = await import('node:fs');
    mkdirSync(join(repo, '.oide'), { recursive: true });
    writeFileSync(join(repo, '.oide', 'config.json'), JSON.stringify({ version: 1, setup: 'node -e "require(\'fs\').writeFileSync(\'setup-ran.txt\',\'1\')"' }));
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'setup');
    const h = await harness({ trust: false });
    await h.call('settings.update', { patch: { claude: { extraFlags: '--fake-scenario basic' } } });
    const project = (await h.call('projects.open', { path: repo }))!;
    expect(project.trusted).toBe(false);
    const [a] = await h.call('agents.spawn', { projectId: project.id, title: 'Untrusted', goal: 'hi', mode: 'acceptEdits', strategy });
    const done = await status(h, a!.id, 'has-question');
    expect(existsSync(join(done.worktreePath!, 'setup-ran.txt'))).toBe(false);

    await h.call('projects.trust', { projectId: project.id, trusted: true });
    const [b] = await h.call('agents.spawn', { projectId: project.id, title: 'Trusted', goal: 'hi', mode: 'acceptEdits', strategy });
    const done2 = await status(h, b!.id, 'has-question');
    expect(existsSync(join(done2.worktreePath!, 'setup-ran.txt'))).toBe(true);

    // Bypass: refused while Allow Bypass is off, and always refused in the project folder.
    expect(await h.fails('agents.spawn', { projectId: project.id, title: 'B', goal: 'x', mode: 'bypassPermissions', strategy })).toBe('forbidden');
    await h.call('settings.update', { patch: { claude: { allowBypass: true } } });
    expect(await h.fails('agents.spawn', { projectId: project.id, title: 'B', goal: 'x', mode: 'bypassPermissions', workIn: 'project-folder', strategy })).toBe('forbidden');
  });

  it('queues agents beyond Max running', async () => {
    const repo = makeRepo();
    dirs.push(repo);
    const h = await harness();
    await h.call('settings.update', { patch: { claude: { extraFlags: '--fake-scenario permission' }, agents: { maxRunning: 1 } } });
    const project = (await h.call('projects.open', { path: repo }))!;
    const [a, b] = await h.call('agents.spawn', { projectId: project.id, title: 'Q', goal: 'Run tests', mode: 'default', attempts: 2, strategy });
    expect(b!.attemptGroup).toBe(a!.attemptGroup);
    const first = await status(h, a!.id, 'needs-permission');
    expect((await agent(h, b!.id))?.status).toBe('queued');
    await h.call('agents.answerPermission', { agentId: a!.id, answer: { requestId: first.pendingPermission!.requestId, behavior: 'deny', message: 'no' } });
    await status(h, a!.id, 'has-question');
    const second = await status(h, b!.id, 'needs-permission');
    expect(second.worktreePath).not.toBe(first.worktreePath);
  });

  it('resumes a working agent with --resume after a restart', async () => {
    const repo = makeRepo();
    dirs.push(repo);
    const record = join(tempDir('oide-int-rec-'), 'argv.jsonl');
    dirs.push(join(record, '..'));
    const h1 = await harness();
    await h1.call('settings.update', { patch: { claude: { extraFlags: `--fake-scenario slow --fake-record ${JSON.stringify(record)}` } } });
    const project = (await h1.call('projects.open', { path: repo }))!;
    const [a] = await h1.call('agents.spawn', { projectId: project.id, title: 'Long job', goal: 'Count', mode: 'acceptEdits', strategy });
    const running = await status(h1, a!.id, 'running');
    await waitFor(() => existsSync(record) && true, 'first launch recorded');
    // Simulated quit: pending prompts denied, processes stopped, the session stays resumable.
    open.splice(open.indexOf(h1), 1);
    await h1.close();

    const h2 = await harness({ userData: h1.userData });
    const restored = await waitFor(async () => {
      const s = await agent(h2, a!.id);
      return s && s.status === 'has-question' && s;
    }, 'resumed and idle');
    expect(restored.sessionId).toBe(running.sessionId);
    const readLaunches = () =>
      readFileSync(record, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as { argv?: string[] })
        .filter((l): l is { argv: string[] } => Array.isArray(l.argv));
    const launches = await waitFor(() => readLaunches().length >= 2 && readLaunches(), 'second launch recorded');
    expect(launches).toHaveLength(2);
    expect(launches[0]!.argv).toContain('--session-id');
    const i = launches[1]!.argv.indexOf('--resume');
    expect(launches[1]!.argv[i + 1]).toBe(running.sessionId);
    // Events from before the restart are still paged from the store.
    expect((await h2.call('agents.events', { agentId: a!.id, limit: 50 })).length).toBeGreaterThan(0);
  });

  it('artifacts: create, preview URL, custom model keys never cross IPC', async () => {
    const h = await harness();
    const art = await h.call('artifacts.create', { title: 'Landing', kind: 'design', content: '<h1>Hi</h1>' });
    expect((await h.call('artifacts.previewUrl', { id: art.id })).url).toBe(`oide-artifact://${art.id}/index.html`);
    const { resolveArtifactUrl } = await import('../../apps/desktop/src/main/services/core.js');
    expect(resolveArtifactUrl(h.services.artifacts, `oide-artifact://${art.id}/index.html`)?.mime).toMatch(/text\/html/);
    expect(resolveArtifactUrl(h.services.artifacts, `oide-artifact://${art.id}/../../oide.db`)).toBeNull();
    expect(resolveArtifactUrl(h.services.artifacts, `oide-artifact://${art.id}/artifact.json`)).toBeNull();
    expect(await h.fails('artifacts.import', { filePath: join(h.userData, 'oide.db') })).toBe('forbidden_path');

    const saved = await h.call('settings.saveCustomModel', { model: { id: 'm1', name: 'Local', provider: 'local', baseUrl: 'http://127.0.0.1:9', model: 'x', extraEnv: {} }, apiKey: 'sk-secret-123' });
    expect(saved.hasKey).toBe(true);
    const s = await h.call('settings.get', undefined);
    expect(JSON.stringify(s)).not.toContain('sk-secret-123');
    expect(h.services.secrets.get('model:m1')).toBe('sk-secret-123');
    const anth = await h.call('settings.saveCustomModel', { model: { id: 'm2', name: 'A', provider: 'compatible-api', baseUrl: 'https://api.anthropic.com', model: 'x', extraEnv: {} } });
    expect((await h.call('settings.testCustomModel', { id: anth.id })).ok).toBe(false);
  });
});
