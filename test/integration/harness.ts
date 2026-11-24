import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CommandInput, CommandName, CommandOutput, EventName, EventPayload } from '../../packages/protocol/src/index.js';
import type { MainContext } from '../../apps/desktop/src/main/context.js';
import { registerDomainHandlers } from '../../apps/desktop/src/main/handlers/domain.js';
import { createAgentEventBatcher, createEmitter } from '../../apps/desktop/src/main/ipc/emit.js';
import { IpcRouter } from '../../apps/desktop/src/main/ipc/router.js';
import { AllowedRoots } from '../../apps/desktop/src/main/security/roots.js';
import { createCoreServices, type Services } from '../../apps/desktop/src/main/services/core.js';
import type { Platform } from '../../apps/desktop/src/main/services/platform.js';
import { TerminalService, type PtyLike } from '../../apps/desktop/src/main/services/terminals.js';

export const REPO = fileURLToPath(new URL('../../', import.meta.url));
export const FAKE_CLAUDE = join(REPO, 'tools', 'fake-claude', 'bin', 'fake-claude.mjs');

export function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).trim();
}

/** A temp repo on `main` with one commit. */
export function makeRepo(): string {
  const dir = tempDir('oide-int-repo-');
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'oIDE Test');
  git(dir, 'config', 'user.email', 'test@oide.invalid');
  git(dir, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'README.md'), '# fixture\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

export interface Harness {
  services: Services;
  ctx: MainContext;
  userData: string;
  events: Array<{ event: EventName; payload: unknown }>;
  notifications: string[];
  call<K extends CommandName>(command: K, input: CommandInput<K>): Promise<CommandOutput<K>>;
  /** Resolves with the command's error code (throws if it succeeded). */
  fails<K extends CommandName>(command: K, input: CommandInput<K>): Promise<string>;
  eventsOf<K extends EventName>(name: K): Array<EventPayload<K>>;
  close(): Promise<void>;
}

const quiet = { debug: () => {}, warn: () => {}, error: (...a: unknown[]) => console.error('[oide]', ...a) };

export async function startHarness(opts: { userData?: string; trust?: boolean } = {}): Promise<Harness> {
  const userData = opts.userData ?? tempDir('oide-int-data-');
  const events: Harness['events'] = [];
  const emit = createEmitter(() => [{ isDestroyed: () => false, send: (_ch: string, m: unknown) => void events.push(m as Harness['events'][number]) }]);
  const quitHooks: Array<() => void | Promise<void>> = [];
  const ctx: MainContext = {
    isDev: true,
    platform: process.platform,
    appVersion: '0.0.0-test',
    userDataDir: userData,
    emit,
    agentEvents: createAgentEventBatcher(emit),
    roots: new AllowedRoots(),
    getWindow: () => null,
    log: quiet,
    onQuit: (fn) => quitHooks.push(fn),
  };
  const fakePty = (): PtyLike => ({ onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }), write() {}, resize() {}, kill() {} }) as unknown as PtyLike;
  const terminals = new TerminalService({ emit, spawn: fakePty });
  const notifications: string[] = [];
  const platform: Platform = {
    // Reversible stand-in for safeStorage (tests only).
    cipher: { encrypt: (s) => Buffer.from(s, 'utf8').reverse(), decrypt: (b) => Buffer.from(b).reverse().toString('utf8'), available: () => true },
    pickFolder: async () => null,
    pickFile: async () => null,
    confirmTrust: async () => opts.trust ?? true,
    notify: (title) => void notifications.push(title),
    openExternal: async () => {},
    builtinExtensionDirs: [],
    cliPathOverride: FAKE_CLAUDE,
    terminals,
    background: false,
  };
  const services = await createCoreServices({ ctx, platform, terminals });
  const router = new IpcRouter({ validateOutput: true, log: quiet });
  registerDomainHandlers(router, services, ctx);
  const dispatch = (command: string, input: unknown) => router.dispatch({ command, input }, { senderId: 1, frameUrl: 'file:///app/index.html' });
  const h: Harness = {
    services,
    ctx,
    userData,
    events,
    notifications,
    async call(command, input) {
      const r = await dispatch(command, input);
      if (!r.ok) throw Object.assign(new Error(`[${r.error.code}] ${r.error.message}`), { code: r.error.code });
      return r.value as never;
    },
    async fails(command, input) {
      const r = await dispatch(command, input);
      if (r.ok) throw new Error(`${command} unexpectedly succeeded`);
      return r.error.code ?? 'internal';
    },
    eventsOf(name) {
      return events.filter((e) => e.event === name).map((e) => e.payload) as never;
    },
    async close() {
      ctx.agentEvents.dispose();
      await services.dispose();
    },
  };
  return h;
}

export async function waitFor<T>(fn: () => T | undefined | false | Promise<T | undefined | false>, what: string, timeoutMs = 20_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

export function cleanup(...dirs: string[]): void {
  for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
