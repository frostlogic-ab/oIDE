import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OideMcpServer } from '@oide/mcp-server';
import type { AgentEvent, AgentSpecInput, AgentSummary, Settings } from '@oide/protocol';
import { fakeCli, tempDir, testSettings, waitFor } from '../test/helpers.js';
import type { EventSink, SettingsProvider, WorktreeProvider } from './ports.js';
import { Supervisor } from './supervisor.js';

interface Harness {
  sup: Supervisor;
  mcp: OideMcpServer;
  settings: Settings;
  events: AgentEvent[];
  raw: string[];
  rules: Array<[string, string]>;
  saved: Map<string, AgentSummary>;
  get: (id: string) => AgentSummary;
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function harness(opts: { extraFlags: string; maxRunning?: number; runSetup?: WorktreeProvider['runSetup'] }): Promise<Harness> {
  const settings = testSettings({ extraFlags: opts.extraFlags, maxRunning: opts.maxRunning ?? 3 });
  const mcp = new OideMcpServer({ appDataDir: tempDir('oide-app-') });
  await mcp.start();
  const events: AgentEvent[] = [];
  const raw: string[] = [];
  const rules: Array<[string, string]> = [];
  const saved = new Map<string, AgentSummary>();
  const worktrees: WorktreeProvider = {
    create: async ({ slug }) => {
      const path = tempDir(`oide-wt-${slug}-`);
      writeFileSync(join(path, 'README.md'), '# fixture\n');
      return { path, branch: `oide/${slug}`, baseRef: 'main' };
    },
    ...(opts.runSetup ? { runSetup: opts.runSetup } : {}),
  };
  const sink: EventSink = {
    append: (e, r) => {
      events.push(e);
      if (r) raw.push(r);
    },
    saveSummary: (s) => void saved.set(s.id, s),
  };
  const provider: SettingsProvider = {
    get: () => settings,
    cli: () => fakeCli,
    project: () => ({ path: '/repo', trusted: true, rules: { allow: [], deny: [] } }),
    addAllowRule: (p, r) => void rules.push([p, r]),
  };
  const sup = new Supervisor({ worktrees, sink, settings: provider, broker: mcp });
  cleanups.push(async () => {
    await sup.shutdown();
    await mcp.close();
  });
  return { sup, mcp, settings, events, raw, rules, saved, get: (id) => sup.get(id)! };
}

const spec = (patch: Partial<AgentSpecInput> = {}): AgentSpecInput => ({
  projectId: 'p1',
  title: 'Fix tests',
  goal: 'Make the tests pass.',
  mode: 'default',
  strategy: { kind: 'single', lead: { model: 'sonnet' } },
  ...patch,
});

const status = (h: Harness, id: string, s: string, ms = 10_000) => waitFor(() => h.get(id).status === s && h.get(id), ms, `${id} → ${s} (now ${h.get(id)?.status})`);

describe('Supervisor with fake-claude and the oIDE MCP server', () => {
  it('queues beyond Max running and does the full permission round trip (allow + Always, deny)', async () => {
    const h = await harness({ extraFlags: '--fake-scenario permission', maxRunning: 1 });
    const [a, b] = await h.sup.spawn(spec({ attempts: 2 }));
    expect(a!.attemptGroup).toBeDefined();
    expect(b!.attemptGroup).toBe(a!.attemptGroup);
    expect([a!.title, b!.title]).toEqual(['Fix tests #1', 'Fix tests #2']);

    const s1 = await status(h, a!.id, 'needs-permission');
    expect(h.get(b!.id).status).toBe('queued');
    expect(s1.pendingPermission).toMatchObject({ toolName: 'Bash', summary: 'Run npm test', suggestedRule: 'Bash(npm test)' });
    expect(s1.branch).toBe('oide/fix-tests-1');
    expect(await h.sup.answerPermission(a!.id, { requestId: 'perm-bogus', behavior: 'allow', always: false })).toBe(false);
    expect(await h.sup.answerPermission(b!.id, { requestId: s1.pendingPermission!.requestId, behavior: 'allow', always: false })).toBe(false);
    expect(await h.sup.answerPermission(a!.id, { requestId: s1.pendingPermission!.requestId, behavior: 'allow', always: true })).toBe(true);
    expect(h.rules).toEqual([['p1', 'Bash(npm test)']]);
    const done1 = await status(h, a!.id, 'has-question');
    expect(done1.lastMessage).toMatch(/Tests ran/);

    const s2 = await status(h, b!.id, 'needs-permission');
    await h.sup.answerPermission(b!.id, { requestId: s2.pendingPermission!.requestId, behavior: 'deny', message: 'Not now' });
    expect((await status(h, b!.id, 'has-question')).lastMessage).toMatch(/could not run the tests: Not now/);
    expect(h.events.some((e) => e.type === 'permission-resolved' && e.behavior === 'deny')).toBe(true);
    expect(h.raw.some((r) => r.includes('"subtype":"init"'))).toBe(true);
    expect(h.saved.get(a!.id)?.status).toBe('has-question');
  });

  it('a queued spawn publishes its summary before it starts (m1)', async () => {
    const h = await harness({ extraFlags: '--fake-scenario permission', maxRunning: 1 });
    const published: AgentSummary[] = [];
    h.sup.on('summary', (s) => published.push(s));
    const [a, b] = await h.sup.spawn(spec({ attempts: 2 }));
    expect(published.filter((s) => s.id === b!.id && s.status === 'queued')).toHaveLength(1);
    expect(h.saved.get(b!.id)?.status).toBe('queued');
    await status(h, a!.id, 'needs-permission');
  });

  it('"Setup: running .oide/setup" only when the provider has a setup to run (m3)', async () => {
    const setupDetail = (h: Harness, id: string) => h.events.some((e) => e.agentId === id && e.type === 'status' && e.detail === 'Setup: running .oide/setup');
    const none = await harness({ extraFlags: '--fake-scenario permission', runSetup: async () => ({ ok: true }) });
    const [a] = await none.sup.spawn(spec());
    await status(none, a!.id, 'needs-permission');
    expect(setupDetail(none, a!.id)).toBe(false);

    const lines: string[] = [];
    const some = await harness({
      extraFlags: '--fake-scenario permission',
      runSetup: async ({ onStart, onOutput }) => {
        onStart?.();
        onOutput?.('installed');
        lines.push('ran');
        return { ok: true };
      },
    });
    const [b] = await some.sup.spawn(spec());
    await status(some, b!.id, 'needs-permission');
    expect(setupDetail(some, b!.id)).toBe(true);
    expect(lines).toEqual(['ran']);
  });

  it('a prompt still pending at quit is denied with reason "quit" and remembered on the summary', async () => {
    const h = await harness({ extraFlags: '--fake-scenario permission' });
    const [a] = await h.sup.spawn(spec());
    await status(h, a!.id, 'needs-permission');
    await h.mcp.close();
    await waitFor(() => h.events.some((e) => e.agentId === a!.id && e.type === 'permission-resolved' && e.reason === 'quit'), 5000, 'quit deny');
    expect(h.get(a!.id).pendingPermission).toBeUndefined();
    expect(h.get(a!.id).interruptedPermission).toMatchObject({ toolName: 'Bash', summary: 'Run npm test' });
    expect(h.saved.get(a!.id)?.interruptedPermission?.toolName).toBe('Bash');
  });

  it('review submission: submit_for_review → ready-for-review with structured checks', async () => {
    const h = await harness({ extraFlags: '--fake-scenario review' });
    const [a] = await h.sup.spawn(spec({ mode: 'acceptEdits' }));
    const p = await status(h, a!.id, 'needs-permission');
    await h.sup.answerPermission(a!.id, { requestId: p.pendingPermission!.requestId, behavior: 'allow', always: false });
    const s = await status(h, a!.id, 'ready-for-review');
    await waitFor(() => h.events.some((e) => e.agentId === a!.id && e.type === 'result'), 5000, 'result');
    expect(h.get(a!.id).status).toBe('ready-for-review');
    expect(s.review).toMatchObject({ agentId: a!.id, summary: 'Added feature.txt.', checks: [{ name: 'npm test', status: 'passed' }] });
    expect(existsSync(join(s.worktreePath!, 'feature.txt'))).toBe(true);
    // Feedback starts a new turn and clears ready-for-review until the agent submits again.
    h.sup.send(a!.id, { kind: 'review-feedback', comments: [{ path: 'feature.txt', line: 1, body: 'Say more' }] });
    await waitFor(() => h.get(a!.id).status !== 'ready-for-review', 5000, 'leaves review');
  });

  it('stop then resume respawns with --resume and the same session id; restore after restart', async () => {
    const h = await harness({ extraFlags: '--fake-scenario basic' });
    const [a] = await h.sup.spawn(spec());
    const first = await status(h, a!.id, 'has-question');
    const sessionId = first.sessionId!;
    await h.sup.stop(a!.id);
    expect(h.get(a!.id).status).toBe('stopped');
    await h.sup.resume(a!.id);
    await status(h, a!.id, 'has-question');
    h.sup.send(a!.id, { kind: 'text', text: 'where were we?' });
    await waitFor(() => h.get(a!.id).lastMessage === `Resumed session ${sessionId}.`, 10_000, 'resumed reply');
    expect(h.get(a!.id).sessionId).toBe(sessionId);

    // App restart: a new supervisor restores the persisted summary; a live status becomes stopped.
    const persisted = { ...h.get(a!.id), status: 'running' as const };
    const h2 = await harness({ extraFlags: '--fake-scenario basic' });
    const [restored] = h2.sup.restore([{ spec: h.sup.spec(a!.id)!, summary: persisted, lastSeq: 500 }]);
    expect(restored!.status).toBe('stopped');
    h2.sup.send(a!.id, { kind: 'text', text: 'hello again' });
    await waitFor(() => h2.get(a!.id).lastMessage === `Resumed session ${sessionId}.`, 10_000, 'restored reply');
    expect(h2.events.every((e) => e.seq >= 501)).toBe(true);
  });

  it('crash → error with exit code; rate limit → rate-limited with reset time and no retry', async () => {
    const h = await harness({ extraFlags: '--fake-scenario crash --fake-exit-code 3' });
    const [a] = await h.sup.spawn(spec());
    const s = await status(h, a!.id, 'error');
    expect(s.exitCode).toBe(3);
    expect(s.error).toMatch(/code 3.*simulated crash/);

    h.settings.claude.extraFlags = '--fake-scenario rate-limit';
    const [b] = await h.sup.spawn(spec());
    const r = await status(h, b!.id, 'rate-limited');
    expect(r.rateLimitResetAt).toBeGreaterThan(Date.now());
    await waitFor(() => h.events.some((e) => e.agentId === b!.id && e.type === 'result'), 5000, 'limit result');
    expect(h.get(b!.id).status).toBe('rate-limited');
    const count = h.events.filter((e) => e.agentId === b!.id).length;
    await new Promise((res) => setTimeout(res, 300));
    expect(h.events.filter((e) => e.agentId === b!.id && e.type === 'init')).toHaveLength(1);
    expect(h.events.filter((e) => e.agentId === b!.id).length).toBe(count);
  });

  it('routed subagents: tracker, tiers, permission attributed to the subagent, token share', async () => {
    const h = await harness({ extraFlags: '--fake-scenario subagents' });
    const [a] = await h.sup.spawn(
      spec({ strategy: { kind: 'routed', lead: { model: 'opus' }, simple: { model: 'haiku' }, standard: { model: 'sonnet' }, complex: { model: 'opus', effort: 'high' } } }),
    );
    const p = await status(h, a!.id, 'needs-permission');
    const sub = p.subagents.find((s) => s.id === p.pendingPermission!.subagentId)!;
    expect(sub).toMatchObject({ subagentType: 'complex-task', tier: 'complex', model: 'opus', effort: 'high', status: 'needs-permission' });
    expect(p.subagents.find((s) => s.subagentType === 'simple-task')).toMatchObject({ status: 'done', tier: 'simple', report: 'The first line is "# fixture".' });
    expect(p.backgroundTasks).toBe(1);
    await h.sup.answerPermission(a!.id, { requestId: p.pendingPermission!.requestId, behavior: 'allow', always: false });
    const done = await status(h, a!.id, 'has-question');
    expect(done.subagents.map((s) => s.status)).toEqual(['done', 'done']);
    expect(done.lastMessage).toMatch(/Both subagents are done/);
    expect(h.sup.subagentTranscript(a!.id, sub.id).some((e) => e.type === 'tool-use' && e.name === 'Bash')).toBe(true);
    expect(h.sup.subagentTokenShare(a!.id)).toBeGreaterThan(0);
    expect(h.events.some((e) => e.type === 'subagent' && e.subagent.id === sub.id && e.subagent.status === 'done')).toBe(true);
  });

  it('stop subagent: its next tool call is denied with a stop message', async () => {
    const h = await harness({ extraFlags: '--fake-scenario subagents' });
    const [a] = await h.sup.spawn(spec());
    const p = await status(h, a!.id, 'needs-permission');
    expect(h.sup.stopSubagent(a!.id, p.pendingPermission!.subagentId!)).toBe(true);
    const done = await status(h, a!.id, 'has-question');
    expect(done.lastMessage).toMatch(/Stopped by the user/);
  });

  it('setMode via control request, and the interrupt + --resume fallback when unsupported', async () => {
    const h = await harness({ extraFlags: '--fake-scenario basic' });
    const [a] = await h.sup.spawn(spec());
    await status(h, a!.id, 'has-question');
    await h.sup.setMode(a!.id, 'acceptEdits');
    await waitFor(() => h.get(a!.id).mode === 'acceptEdits', 5000, 'mode acceptEdits');

    h.settings.claude.extraFlags = '--fake-scenario basic --fake-no-control';
    const [b] = await h.sup.spawn(spec());
    await status(h, b!.id, 'has-question');
    const inits = () => h.events.filter((e) => e.agentId === b!.id && e.type === 'exit').length;
    await h.sup.setMode(b!.id, 'plan');
    await waitFor(() => inits() === 1, 10_000, 'old process exited');
    await status(h, b!.id, 'has-question');
    expect(h.get(b!.id).mode).toBe('plan');
    h.sup.send(b!.id, { kind: 'text', text: 'continue' });
    await waitFor(() => h.get(b!.id).lastMessage?.startsWith('Resumed session'), 10_000, 'resumed with new mode');
  }, 30_000);

  it('pause holds messages until resume; compact sends /compact; remove fires removed', async () => {
    const h = await harness({ extraFlags: '--fake-scenario slow,basic' });
    const [a] = await h.sup.spawn(spec());
    await waitFor(() => h.events.some((e) => e.agentId === a!.id && e.type === 'partial'), 10_000, 'streaming');
    await h.sup.pause(a!.id);
    expect(h.get(a!.id).status).toBe('paused');
    await waitFor(() => h.events.some((e) => e.agentId === a!.id && e.type === 'result'), 5000, 'interrupted');
    expect(h.get(a!.id).status).toBe('paused');
    h.sup.send(a!.id, { kind: 'text', text: 'held message' });
    await new Promise((r) => setTimeout(r, 100));
    expect(h.events.filter((e) => e.agentId === a!.id && e.type === 'result')).toHaveLength(1);
    await h.sup.resume(a!.id);
    await waitFor(() => h.get(a!.id).lastMessage?.includes('held message'), 10_000, 'held message delivered');
    await status(h, a!.id, 'has-question');
    h.sup.compact(a!.id);
    await waitFor(() => h.events.some((e) => e.agentId === a!.id && e.type === 'compact' && e.phase === 'done'), 10_000, 'compacted');
    const removed: string[] = [];
    h.sup.on('removed', (id) => removed.push(id));
    await h.sup.remove(a!.id);
    expect(removed).toEqual([a!.id]);
    expect(h.sup.get(a!.id)).toBeUndefined();
  }, 30_000);
});
