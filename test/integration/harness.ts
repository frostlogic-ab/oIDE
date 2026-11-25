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
import { setConfirmOverride } from '../../apps/desktop/src/main/security/confirm.js';
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
  /** Events the emitter dropped (failed their schema): should stay empty. */
  emitErrors: string[];
  call<K extends CommandName>(command: K, input: CommandInput<K>): Promise<CommandOutput<K>>;
  /** Resolves with the command's error code (throws if it succeeded). */
  fails<K extends CommandName>(command: K, input: CommandInput<K>): Promise<string>;
  eventsOf<K extends EventName>(name: K): Array<EventPayload<K>>;
  /**
   * Test-only stand-in for picking `path` in the native folder dialog, so `projects.open({ path })`
   * accepts it (SEC-08). Main has no IPC path to this; a packaged build has no equivalent.
   */
  allowOpen(path: string): void;
  close(): Promise<void>;
}

const quiet = { debug: () => {}, warn: () => {}, error: (...a: unknown[]) => console.error('[oide]', ...a) };

export interface HarnessOptions {
  userData?: string;
  trust?: boolean;
  /**
   * How native confirmations in main (security/confirm.ts) are answered. Default: no override,
   * which in plain Node means Cancel, so PoCs see the secure default.
   */
  confirm?: 'accept' | 'deny';
  /** Replaces parts of the fake Platform (built-in extension folders, a host-process fork, `fetch` for a local marketplace index). */
  platform?: Partial<Platform>;
  /** oIDE's MCP server fails to bind (every attempt), as when a security tool blocks loopback. */
  mcpFails?: boolean;
  /** Sees every event sent to the "renderer". */
  onEvent?: (event: EventName, payload: unknown) => void;
  /** Keep events in `events` (default true; long soak runs turn it off to measure memory). */
  keepEvents?: boolean;
  /** A fake GitHub CLI (pull request state) instead of the user's `gh`. */
  gh?: import('../../packages/git/src/index.js').GhCli;
  /** The folder-holder scan (off by default in plain Node). */
  findHolders?: import('../../apps/desktop/src/main/services/core.js').CoreOptions['findHolders'];
}

export async function startHarness(opts: HarnessOptions = {}): Promise<Harness> {
  if (opts.confirm) setConfirmOverride(() => opts.confirm === 'accept');
  const userData = opts.userData ?? tempDir('oide-int-data-');
  const events: Harness['events'] = [];
  const keep = opts.keepEvents ?? true;
  const emitErrors: string[] = [];
  const emitLog = { ...quiet, error: (...a: unknown[]) => void emitErrors.push(a.map(String).join(' ')) };
  const emit = createEmitter(() => [
    {
      isDestroyed: () => false,
      send: (_ch: string, m: unknown) => {
        const e = m as Harness['events'][number];
        if (keep) events.push(e);
        opts.onEvent?.(e.event, e.payload);
      },
    },
  ], emitLog);
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
    openablePaths: [],
    terminals,
    background: false,
    ...opts.platform,
  };
  const services = await createCoreServices({ ctx, platform, terminals, ...(opts.gh ? { gh: opts.gh } : {}), ...(opts.findHolders ? { findHolders: opts.findHolders } : {}), ...(opts.mcpFails ? { startMcp: () => Promise.reject(new Error('listen EACCES 127.0.0.1')) } : {}) });
  const router = new IpcRouter({ validateOutput: true, log: quiet });
  registerDomainHandlers(router, services, ctx);
  const dispatch = (command: string, input: unknown) => router.dispatch({ command, input }, { senderId: 1, frameUrl: 'file:///app/index.html' });
  const h: Harness = {
    services,
    ctx,
    userData,
    events,
    notifications,
    emitErrors,
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
    allowOpen(path) {
      platform.openablePaths!.push(path);
    },
    eventsOf(name) {
      return events.filter((e) => e.event === name).map((e) => e.payload) as never;
    },
    async close() {
      if (opts.confirm) setConfirmOverride(null);
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
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true, maxRetries: 15, retryDelay: 250 });
    } catch (err) {
      let ok = false;
      for (let i = 0; i < 40 && !ok; i++) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
        try {
          rmSync(d, { recursive: true, force: true });
          ok = true;
        } catch {
          /* still held */
        }
      }
      console.error(`[cleanup] ${d}: ${ok ? 'removed after a wait' : 'still held'}`);
      if (!ok) throw err;
    }
  }
}
