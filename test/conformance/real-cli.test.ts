import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { AgentEvent, AgentSummary, CommandInput, CommandName, CommandOutput } from '../../packages/protocol/src/index.js';
import type { MainContext } from '../../apps/desktop/src/main/context.js';
import { registerDomainHandlers } from '../../apps/desktop/src/main/handlers/domain.js';
import { createAgentEventBatcher, createEmitter } from '../../apps/desktop/src/main/ipc/emit.js';
import { IpcRouter } from '../../apps/desktop/src/main/ipc/router.js';
import { AllowedRoots } from '../../apps/desktop/src/main/security/roots.js';
import { createCoreServices, type Services } from '../../apps/desktop/src/main/services/core.js';
import type { Platform } from '../../apps/desktop/src/main/services/platform.js';
import { TerminalService, type PtyLike } from '../../apps/desktop/src/main/services/terminals.js';
import { cleanup, makeRepo, tempDir, waitFor } from '../integration/harness.js';

/**
 * M1 gate against the user's REAL `claude` CLI (brief, Milestones: "With a real CLI: spawn, approve
 * a prompt in oIDE, stop, restart oIDE, resume"). Opt-in only, since it uses the user's plan:
 *
 *   $env:OIDE_REAL_CLI = '1'; node node_modules/vitest/vitest.mjs run test/conformance/real-cli.test.ts
 *
 * Uses `--model haiku`, two short turns. Builds the services layer in plain Node exactly like
 * test/integration/harness.ts, but with NO cliPathOverride, so `claude` is found on PATH.
 * Writes a transcript of what happened to $OIDE_REAL_CLI_OUT (default: a temp dir) for the review.
 */

const enabled = Boolean(process.env.OIDE_REAL_CLI);
const outDir = process.env.OIDE_REAL_CLI_OUT ?? tempDir('oide-real-cli-out-');
const log: string[] = [];
const openable: string[] = [];
const note =(m: string, d?: unknown) => log.push(`${new Date().toISOString()} ${m}${d === undefined ? '' : ' ' + JSON.stringify(d)}`);

interface H {
  services: Services;
  call<K extends CommandName>(command: K, input: CommandInput<K>): Promise<CommandOutput<K>>;
  close(): Promise<void>;
}

async function start(userData: string): Promise<H> {
  const emit = createEmitter(() => [{ isDestroyed: () => false, send: () => undefined }]);
  const ctx: MainContext = {
    isDev: true,
    platform: process.platform,
    appVersion: '0.0.0-conformance',
    userDataDir: userData,
    emit,
    agentEvents: createAgentEventBatcher(emit),
    roots: new AllowedRoots(),
    getWindow: () => null,
    log: { debug: (...a) => note('debug', a.map(String).join(' ').slice(0, 2000)), warn: (...a) => note('warn', a.map(String).join(' ')), error: (...a) => note('error', a.map(String).join(' ')) },
    onQuit: () => undefined,
  };
  const fakePty = (): PtyLike => ({ onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }), write() {}, resize() {}, kill() {} }) as unknown as PtyLike;
  const terminals = new TerminalService({ emit, spawn: fakePty });
  const platform: Platform = {
    cipher: { encrypt: (s) => Buffer.from(s, 'utf8').reverse(), decrypt: (b) => Buffer.from(b).reverse().toString('utf8'), available: () => true },
    pickFolder: async () => null,
    pickFile: async () => null,
    confirmTrust: async () => true,
    notify: () => undefined,
    openExternal: async () => {},
    builtinExtensionDirs: [],
    cliPathOverride: undefined,
    // Test-only stand-in for a folder-picker pick (SEC-08): tmp repos only.
    openablePaths: openable,
    terminals,
    background: false,
  };
  const services = await createCoreServices({ ctx, platform, terminals });
  const router = new IpcRouter({ validateOutput: true, log: ctx.log });
  registerDomainHandlers(router, services, ctx);
  return {
    services,
    async call(command, input) {
      const r = await router.dispatch({ command, input }, { senderId: 1, frameUrl: 'file:///app/index.html' });
      if (!r.ok) throw new Error(`[${r.error.code}] ${r.error.message}`);
      return r.value as never;
    },
    async close() {
      ctx.agentEvents.dispose();
      await services.dispose();
    },
  };
}

const find = async (h: H, id: string): Promise<AgentSummary | undefined> => (await h.call('agents.list', undefined)).find((a) => a.id === id);
const until = (h: H, id: string, ok: (a: AgentSummary) => boolean, what: string, ms = 180_000) =>
  waitFor(async () => {
    const a = await find(h, id);
    return a && ok(a) && a;
  }, what, ms);
const brief = (e: AgentEvent) => {
  const x = e as Record<string, unknown>;
  return { seq: x.seq, type: x.type, ...(x.name ? { name: x.name } : {}), ...(x.text ? { text: String(x.text).slice(0, 300) } : {}), ...(x.status ? { status: x.status } : {}), ...(x.content ? { content: String(typeof x.content === 'string' ? x.content : JSON.stringify(x.content)).slice(0, 300) } : {}) };
};

describe.skipIf(!enabled)('M1 gate with the real claude CLI (opt-in)', () => {
  const dirs: string[] = [];
  afterAll(() => {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'real-cli-log.txt'), log.join('\n'));
    cleanup(...dirs);
  });

  it('spawn → permission prompt in oIDE → allow → result → stop → restart → --resume → follow-up', async () => {
    const repo = makeRepo();
    openable.push(repo);
    const userData = tempDir('oide-real-data-');
    dirs.push(repo, userData);

    let h = await start(userData);
    const cli = await h.call('cli.detect', undefined);
    note('cli', { found: cli.found, version: cli.version, inTestedRange: cli.inTestedRange, path: cli.path, auto: cli.features?.['mode:auto'] });
    expect(cli.found).toBe(true);

    const project = (await h.call('projects.open', { path: repo }))!;
    const [a] = await h.call('agents.spawn', {
      projectId: project.id,
      title: 'Real CLI probe',
      goal: 'Use the Bash tool to run exactly this command: node -e "console.log(6*7)" . Then tell me the number it printed in one short sentence. Do nothing else and do not edit files.',
      mode: 'default',
      strategy: { kind: 'single', lead: { model: 'haiku' } },
    });
    note('spawned', { id: a!.id, status: a!.status, sessionId: a!.sessionId, worktree: a!.worktreePath });

    const asking = await until(h, a!.id, (s) => s.status === 'needs-permission' || ['has-question', 'ready-for-review', 'error'].includes(s.status), 'permission prompt');
    note('after spawn', { status: asking.status, pending: asking.pendingPermission, error: asking.error });
    expect(asking.status).toBe('needs-permission');
    expect(asking.pendingPermission?.toolName).toBe('Bash');

    await h.call('agents.answerPermission', { agentId: a!.id, answer: { requestId: asking.pendingPermission!.requestId, behavior: 'allow' } });
    const done = await until(h, a!.id, (s) => ['has-question', 'ready-for-review', 'error', 'stopped', 'done'].includes(s.status), 'turn end');
    const evs1 = await h.call('agents.events', { agentId: a!.id, limit: 500 });
    note('turn 1 done', { status: done.status, error: done.error, context: done.context, sessionId: done.sessionId });
    note('turn 1 events', evs1.map(brief));
    expect(JSON.stringify(evs1)).toContain('42');

    await h.call('agents.stop', { agentId: a!.id });
    const stopped = await until(h, a!.id, (s) => s.status === 'stopped', 'stopped', 30_000);
    note('stopped', { status: stopped.status, sessionId: stopped.sessionId });
    const sessionId = stopped.sessionId;
    await h.close();
    note('services closed (simulated quit)');

    // "Restart oIDE": a new services instance on the same userData.
    h = await start(userData);
    const restored = await find(h, a!.id);
    note('after restart', { status: restored?.status, sessionId: restored?.sessionId, storedEvents: (await h.call('agents.events', { agentId: a!.id, limit: 500 })).length });
    expect(restored?.sessionId).toBe(sessionId);

    const before = (await h.call('agents.events', { agentId: a!.id, limit: 5000 })).at(-1)?.seq ?? 0;
    await h.call('agents.send', { agentId: a!.id, message: { kind: 'text', text: 'What number did that command print earlier? Answer with only the number.' } });
    const replied = await until(h, a!.id, (s) => ['has-question', 'ready-for-review', 'error'].includes(s.status), 'follow-up reply');
    const evs2 = (await h.call('agents.events', { agentId: a!.id, limit: 5000 })).filter((e) => (e as { seq: number }).seq > before);
    note('turn 2 done', { status: replied.status, error: replied.error, sessionId: replied.sessionId });
    note('turn 2 events', evs2.map(brief));
    const reply = evs2.filter((e) => e.type === 'assistant-text').map((e) => (e as { text: string }).text).join(' ');
    expect(replied.sessionId).toBe(sessionId);
    expect(reply).toContain('42');

    await h.call('agents.stop', { agentId: a!.id });
    await h.close();
  }, 600_000);
});
