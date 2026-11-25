import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentSummary } from '../../packages/protocol/src/index.js';
import { setConfirmOverride } from '../../apps/desktop/src/main/security/confirm.js';
import { cleanup, git, makeRepo, startHarness, tempDir, waitFor, type Harness } from './harness.js';

/**
 * Archived agents and restart recovery, through the real IPC router (Zod-validated both ways)
 * against tools/fake-claude: merge → archived with reason and merge commit, archive by hand,
 * unarchive and resume, delete permanently, "Interrupted" after a restart or a crash, and one
 * agent with a bad summary never hiding the others.
 */

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

const strategy = { kind: 'single' as const, lead: { model: 'sonnet' } };

async function agent(h: Harness, id: string): Promise<AgentSummary | undefined> {
  return (await h.call('agents.list', undefined)).find((a) => a.id === id);
}
const status = (h: Harness, id: string, s: AgentSummary['status'], ms?: number) =>
  waitFor(async () => {
    const a = await agent(h, id);
    return a?.status === s && a;
  }, `${id} → ${s}`, ms);

async function project(h: Harness, flags: string, patch: Record<string, unknown> = {}) {
  const repo = makeRepo();
  dirs.push(repo);
  await h.call('settings.update', { patch: { claude: { extraFlags: flags }, ...patch } });
  h.allowOpen(repo);
  return { repo, project: (await h.call('projects.open', { path: repo }))! };
}

describe('archived agents (main services, fake-claude)', () => {
  it('merge archives the agent with reason, merge commit, diff and cost; it opens read-only; delete permanently needs a confirm', async () => {
    const h = await harness();
    const { repo, project: p } = await project(h, '--fake-scenario commit-work', { agents: { cleanup: 'right-away' } });
    const [a] = await h.call('agents.spawn', { projectId: p.id, title: 'Add feature', goal: 'Add feature.txt', mode: 'acceptEdits', strategy });
    // Allow each tool call it asks for, until it has submitted its work.
    const ready = await waitFor(async () => {
      const s = await agent(h, a!.id);
      if (s?.status === 'needs-permission' && s.pendingPermission) {
        await h.call('agents.answerPermission', { agentId: a!.id, answer: { requestId: s.pendingPermission.requestId, behavior: 'allow' } }).catch(() => undefined);
        return false;
      }
      return s?.status === 'ready-for-review' && s.diff && s;
    }, 'work submitted', 30_000);
    const merged = await h.call('git.mergeLocal', { agentId: a!.id });
    expect(merged.ok).toBe(true);
    const head = git(repo, 'rev-parse', 'HEAD');

    // Off the Wall (no counter sees it), into the Archived view with why and when.
    expect(await agent(h, a!.id)).toBeUndefined();
    expect((await h.call('usage.summary', undefined)).sessions).toBe(0);
    const page = await h.call('agents.listArchived', { projectId: p.id });
    expect(page.total).toBe(1);
    const arch = page.items[0]!;
    expect(arch).toMatchObject({ id: a!.id, title: 'Add feature', branch: ready.branch, archived: { reason: 'merged', mergeCommit: head, worktreeRemoved: true } });
    expect(arch.diff).toEqual(ready.diff);
    expect(arch.costUsd).toBeGreaterThan(0);
    expect(arch.resumeBlocked).toMatch(/cannot be resumed/);
    expect(existsSync(ready.worktreePath!)).toBe(false);
    expect(await h.call('agents.getArchived', { agentId: a!.id })).toMatchObject({ id: a!.id, archived: { reason: 'merged' } });
    // The transcript stays: Focus reads it from the database.
    expect((await h.call('agents.events', { agentId: a!.id, limit: 500 })).some((e) => e.type === 'user-text')).toBe(true);
    expect(await h.call('git.diff', { agentId: a!.id })).toEqual([]);
    // Not an orphan in Source control, and other projects' lists are empty.
    expect((await h.call('git.worktrees', { projectId: p.id })).filter((w) => w.orphaned)).toEqual([]);
    expect((await h.call('agents.listArchived', { projectId: 'other-project' })).total).toBe(0);

    // Unarchive: back on the Wall, but Resume is blocked (its worktree is gone).
    const back = await h.call('agents.unarchive', { agentId: a!.id });
    expect(back.archived).toBeUndefined();
    expect(back.resumeBlocked).toMatch(/cannot be resumed/);
    expect(await agent(h, a!.id)).toBeDefined();
    expect(await h.fails('agents.resume', { agentId: a!.id })).toBe('conflict');
    expect((await h.call('agents.listArchived', {})).total).toBe(0);
    await h.call('agents.archive', { agentId: a!.id });

    // Delete permanently: row and events gone, after main's native confirmation.
    expect(await h.call('agents.deletePermanently', { agentId: a!.id })).toEqual({ deleted: true });
    expect(h.eventsOf('agents.removed').some((e) => e.agentId === a!.id)).toBe(true);
    expect((await h.call('agents.listArchived', {})).total).toBe(0);
    expect(await h.fails('agents.getArchived', { agentId: a!.id })).toBe('not_found');
    expect(await h.call('agents.events', { agentId: a!.id, limit: 5 }).catch(() => 'gone')).toBe('gone');
    expect(h.emitErrors).toEqual([]);
  }, 60_000);

  it('archive by hand only when not working; unarchive resumes the same session; discard archives too; Cancel keeps it', async () => {
    const h = await harness();
    const record = join(tempDir('oide-int-rec-'), 'argv.jsonl');
    dirs.push(join(record, '..'));
    const { project: p } = await project(h, `--fake-scenario basic --fake-record ${JSON.stringify(record)}`);
    const [a] = await h.call('agents.spawn', { projectId: p.id, title: 'Count things', goal: 'Count [fake-scenario:slow]', mode: 'acceptEdits', strategy });
    await status(h, a!.id, 'running');
    expect(await h.fails('agents.archive', { agentId: a!.id })).toBe('conflict');
    const idle = await status(h, a!.id, 'has-question');

    const arch = await h.call('agents.archive', { agentId: a!.id });
    expect(arch.archived).toMatchObject({ reason: 'archived-by-user', worktreeRemoved: false });
    expect(h.eventsOf('agents.archived').map((s) => s.id)).toContain(a!.id);
    expect(await agent(h, a!.id)).toBeUndefined();
    expect(existsSync(idle.worktreePath!)).toBe(true);
    // Its kept worktree is not offered as an orphan to prune.
    expect((await h.call('git.worktrees', { projectId: p.id })).some((w) => w.orphaned)).toBe(false);
    expect((await h.call('git.pruneOrphans', { projectId: p.id })).removed).toEqual([]);
    expect((await h.call('agents.listArchived', { query: 'COUNT' })).items.map((x) => x.id)).toEqual([a!.id]);
    expect((await h.call('agents.listArchived', { query: 'nothing like it' })).total).toBe(0);

    const back = await h.call('agents.unarchive', { agentId: a!.id });
    expect(back.resumeBlocked).toBeUndefined();
    await h.call('agents.send', { agentId: a!.id, message: { kind: 'text', text: 'where were we?' } });
    await waitFor(async () => (await agent(h, a!.id))?.lastMessage === `Resumed session ${idle.sessionId}.`, 'resumed after unarchive');
    const launches = readFileSync(record, 'utf8').trim().split(/\r?\n/).map((l) => JSON.parse(l) as { argv?: string[] }).filter((l) => l.argv);
    expect(launches.at(-1)!.argv!.join(' ')).toContain(`--resume ${idle.sessionId}`);

    // Discard (Source control › Remove worktree) archives with reason "discarded" and deletes the worktree.
    await status(h, a!.id, 'has-question');
    await h.call('agents.remove', { agentId: a!.id, deleteWorktree: true });
    expect((await h.call('agents.getArchived', { agentId: a!.id })).archived).toMatchObject({ reason: 'discarded', worktreeRemoved: true });
    expect(existsSync(idle.worktreePath!)).toBe(false);

    // Cancel in the native confirmation keeps everything.
    setConfirmOverride(() => false);
    expect(await h.call('agents.deletePermanently', { agentId: a!.id })).toEqual({ deleted: false });
    setConfirmOverride(() => true);
    expect((await h.call('agents.getArchived', { agentId: a!.id })).id).toBe(a!.id);
  }, 60_000);

  it('restart: agents that were working come back Interrupted (MCP down) and resume once it is back; a crash resumes them', async () => {
    const h1 = await harness();
    const { project: p } = await project(h1, '--fake-scenario slow');
    const [b] = await h1.call('agents.spawn', { projectId: p.id, title: 'Finished job', goal: 'Say hi [fake-scenario:basic]', mode: 'acceptEdits', strategy });
    await status(h1, b!.id, 'has-question', 30_000);
    await h1.call('agents.archive', { agentId: b!.id });
    const [a] = await h1.call('agents.spawn', { projectId: p.id, title: 'Long job', goal: 'Count', mode: 'acceptEdits', strategy });
    const running = await status(h1, a!.id, 'running');
    open.splice(open.indexOf(h1), 1);
    await h1.close();

    // MCP server down: the working agent is on the Wall, Interrupted, not resumed. The archived one stays archived.
    const h2 = await harness({ userData: h1.userData, mcpFails: true });
    const list = await h2.call('agents.list', undefined);
    expect(list.map((x) => x.id)).toEqual([a!.id]);
    expect(list[0]).toMatchObject({ status: 'stopped', interrupted: { reason: 'mcp-down' }, sessionId: running.sessionId });
    expect((await h2.call('agents.listArchived', {})).items.map((x) => x.id)).toEqual([b!.id]);
    open.splice(open.indexOf(h2), 1);
    await h2.close();

    // Crash while working: the database still says running and nothing was marked at quit.
    const db = new DatabaseSync(join(h1.userData, 'oide.db'));
    const row = db.prepare('SELECT summary FROM agents WHERE id = ?').get(a!.id) as { summary: string };
    db.prepare("UPDATE agents SET status = 'running', summary = ? WHERE id = ?").run(JSON.stringify({ ...JSON.parse(row.summary), status: 'running', backgroundTasks: 1, planUsage: { status: 'allowed', window: 'seven_day', utilization: 0.03 } }), a!.id);
    db.prepare("DELETE FROM ui_state WHERE key = 'agents:resume-on-start'").run();
    db.close();
    const h3 = await harness({ userData: h1.userData });
    // The user's case (2026-11-25): a row still "running" with background tasks comes back on the Wall.
    expect(await agent(h3, a!.id)).toBeDefined();
    expect(h3.eventsOf('agents.summary').find((s) => s.id === a!.id && s.interrupted)?.interrupted?.reason).toBe('crash');
    // Resumed automatically with --resume; once it runs, it is no longer "Interrupted".
    const resumed = await waitFor(async () => {
      const s = await agent(h3, a!.id);
      return s && ['running', 'has-question'].includes(s.status) && !s.interrupted && s;
    }, 'resumed after crash', 30_000);
    expect(resumed.sessionId).toBe(running.sessionId);
  }, 90_000);

  it('one agent whose live summary breaks the contract never hides the others', async () => {
    const h = await harness();
    const { project: p } = await project(h, '--fake-scenario basic');
    const [a] = await h.call('agents.spawn', { projectId: p.id, title: 'Good', goal: 'hi', mode: 'acceptEdits', strategy });
    const [b] = await h.call('agents.spawn', { projectId: p.id, title: 'Bad', goal: 'hi', mode: 'acceptEdits', strategy });
    await status(h, a!.id, 'has-question');
    await status(h, b!.id, 'has-question');
    // A reducer bug: values the contract rejects, in memory only (the database copy is fine).
    const live = h.services.agents.supervisor.get(b!.id)!;
    live.contextWindow = 0;
    live.activity = ['ok', 42 as unknown as string];
    const list = await h.call('agents.list', undefined);
    expect(list.map((x) => x.id).sort()).toEqual([a!.id, b!.id].sort());
    const bad = list.find((x) => x.id === b!.id)!;
    expect(bad.activity).toEqual(['ok']);
    expect(bad.contextWindow).toBeGreaterThan(0);
    // Unrepairable (a required field): left out, the others still listed.
    (live as { status: string }).status = 'exploded';
    expect((await h.call('agents.list', undefined)).map((x) => x.id)).toEqual([a!.id]);
  }, 60_000);
});
