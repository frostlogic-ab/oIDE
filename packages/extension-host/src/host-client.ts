import { fork as cpFork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { AgentInfo, ArtifactContent, SettingValue } from '@oide/extension-api';
import type { MaybePromise } from './interfaces.js';
import type { HostToMain, MainToHost } from './rpc.js';

/** A running host process, as either `child_process.fork` or Electron's `utilityProcess.fork` gives it. */
export interface HostChild {
  postMessage(msg: MainToHost): void;
  onMessage(cb: (msg: HostToMain) => void): void;
  onExit(cb: (code: number | null) => void): void;
  kill(): void;
}

export interface ForkOptions {
  /** Shown in task managers, e.g. `oIDE extension: @oide/ext-git`. */
  serviceName: string;
  env: Record<string, string>;
  cwd: string;
}

export type ForkFn = (modulePath: string, opts: ForkOptions) => HostChild;

/** Default path of the host process entry (TypeScript source; bundlers emit their own). */
export const HOST_PROCESS_ENTRY = fileURLToPath(new URL('./host-process.ts', import.meta.url));

/** `child_process.fork` adapter (tests, plain Node). */
export function nodeFork(opts: { execArgv?: string[]; onStderr?: (chunk: string) => void } = {}): ForkFn {
  return (modulePath, o) => {
    const child = cpFork(modulePath, [], { cwd: o.cwd, env: o.env, execArgv: opts.execArgv ?? [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'], serialization: 'advanced' });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (c: string) => opts.onStderr?.(c));
    return {
      postMessage: (m) => {
        if (child.connected) child.send(m);
      },
      onMessage: (cb) => child.on('message', (m) => cb(m as HostToMain)),
      onExit: (cb) => child.on('exit', (code) => cb(code)),
      kill: () => {
        child.kill();
      },
    };
  };
}

/** Structural type of Electron's `utilityProcess` module (no Electron import here). */
export interface UtilityProcessModule {
  fork(
    modulePath: string,
    args?: string[],
    options?: { env?: Record<string, string>; cwd?: string; serviceName?: string; stdio?: 'pipe' | 'ignore' | 'inherit' },
  ): {
    postMessage(message: unknown): void;
    on(event: 'message', cb: (message: unknown) => void): void;
    on(event: 'exit', cb: (code: number) => void): void;
    kill(): boolean;
  };
}

/** Electron adapter: `new ExtensionHostClient({ fork: utilityProcessFork(utilityProcess), … })`. */
export function utilityProcessFork(up: UtilityProcessModule): ForkFn {
  return (modulePath, o) => {
    const child = up.fork(modulePath, [], { env: o.env, cwd: o.cwd, serviceName: o.serviceName, stdio: 'ignore' });
    return {
      postMessage: (m) => child.postMessage(m),
      onMessage: (cb) => child.on('message', (m) => cb(m as HostToMain)),
      onExit: (cb) => child.on('exit', (code) => cb(code)),
      kill: () => {
        child.kill();
      },
    };
  };
}

/** What main implements for the extension API. `ext` is always the calling extension's name. */
export interface HostServices {
  settingsGet(ext: string, key: string): MaybePromise<SettingValue | undefined>;
  settingsSet(ext: string, key: string, value: SettingValue): MaybePromise<void>;
  /** Only agents in projects where `ext` is enabled. */
  listAgents(ext: string, filter: { projectId?: string }): MaybePromise<AgentInfo[]>;
  postMessage(ext: string, agentId: string, text: string): MaybePromise<void>;
  openPanel(ext: string, panelId: string, opts: { agentId?: string; projectId?: string }): MaybePromise<void>;
  postPanelMessage(ext: string, panelId: string, data: unknown): MaybePromise<void>;
  readArtifact(ext: string, id: string): MaybePromise<ArtifactContent>;
  /** Whether `ext` may see events of agents in `projectId`. */
  canSeeProject(ext: string, projectId: string): MaybePromise<boolean>;
  log(ext: string, level: 'debug' | 'info' | 'warn' | 'error', message: string): void;
}

export interface HostExtension {
  name: string;
  version: string;
  dir: string;
  /** Absolute path of the host module. */
  main: string;
  activation: string[];
  panelIds: string[];
  /** Commands from `contributes.commands`. */
  commandIds: string[];
}

export type HostState = 'stopped' | 'starting' | 'running' | 'reloading' | 'failed';

export interface HostStateChange {
  name: string;
  state: HostState;
  panelIds: string[];
  error?: string;
}

export interface BackoffOptions {
  initialMs?: number;
  maxMs?: number;
  /** Give up after this many crashes within `windowMs`. */
  maxRestarts?: number;
  windowMs?: number;
}

export interface HostClientOptions {
  fork: ForkFn;
  services: HostServices;
  /** Host process entry; defaults to HOST_PROCESS_ENTRY. */
  entry?: string;
  /** Extra env for host processes (built from an allow-list by the caller; never the full env). */
  env?: Record<string, string>;
  backoff?: BackoffOptions;
  /** Activation and command timeout (default 15 s). */
  timeoutMs?: number;
}

interface Runner {
  ext: HostExtension;
  child: HostChild | null;
  state: HostState;
  activatedBy: string | null;
  commands: Set<string>;
  subscribed: boolean;
  ready: Promise<void> | null;
  pending: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>;
  crashes: number[];
  stopping: boolean;
  restartTimer: NodeJS.Timeout | null;
  generation: number;
}

/** Env a host process inherits (an allow-list; never the whole environment). */
const BASE_ENV_KEYS = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'LANG'];

/** Event names that activate an extension for `event`. */
export function matchesActivation(activation: string[], event: string): boolean {
  return activation.includes('*') || activation.includes(event);
}

/**
 * Starts one host process per extension with host code, on its activation events; implements
 * the extension API over the channel; restarts crashed hosts with backoff.
 */
export class ExtensionHostClient {
  private runners = new Map<string, Runner>();
  private stateListeners = new Set<(s: HostStateChange) => void>();
  private nextReq = 1;
  private readonly timeoutMs: number;
  private readonly backoff: Required<BackoffOptions>;

  constructor(private readonly opts: HostClientOptions) {
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.backoff = { initialMs: 500, maxMs: 30_000, maxRestarts: 5, windowMs: 120_000, ...opts.backoff };
  }

  /** Replace the set of extensions with host code (enabled ones). Removed ones are stopped. */
  setExtensions(list: HostExtension[]): void {
    const names = new Set(list.map((e) => e.name));
    for (const [name, r] of this.runners) if (!names.has(name)) void this.stopRunner(r).then(() => this.runners.delete(name));
    for (const ext of list) {
      const r = this.runners.get(ext.name);
      if (r) r.ext = ext;
      else this.runners.set(ext.name, this.newRunner(ext));
    }
  }

  state(name: string): HostState {
    return this.runners.get(name)?.state ?? 'stopped';
  }

  onState(listener: (s: HostStateChange) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  /** Fire an activation event (`onStartup`, `onAgentSpawn`, `onCommand:<id>`). */
  async activate(event: string): Promise<void> {
    const jobs = [...this.runners.values()].filter((r) => matchesActivation(r.ext.activation, event)).map((r) => this.ensureStarted(r, event).catch(() => undefined));
    await Promise.all(jobs);
  }

  /** Run a command, activating its extension first (`onCommand:<id>`). */
  async runCommand(commandId: string, args: unknown[] = []): Promise<unknown> {
    const r = this.ownerOf(commandId);
    if (!r) throw new Error(`No extension provides command ${commandId}`);
    await this.ensureStarted(r, `onCommand:${commandId}`);
    if (!r.commands.has(commandId)) throw new Error(`${r.ext.name} did not register command ${commandId}`);
    return this.call(r, { t: 'run', commandId, args }, `command ${commandId}`);
  }

  /** Commands currently available (contributed plus registered at runtime). */
  commands(): Array<{ extension: string; commandId: string }> {
    const out: Array<{ extension: string; commandId: string }> = [];
    for (const r of this.runners.values()) for (const id of new Set([...r.ext.commandIds, ...r.commands])) out.push({ extension: r.ext.name, commandId: id });
    return out;
  }

  /** Forward an agent event to subscribed extensions allowed to see its project. */
  async dispatchAgentEvent(event: { agentId: string } & Record<string, unknown>, projectId: string): Promise<void> {
    for (const r of this.runners.values()) {
      if (!r.subscribed || r.state !== 'running' || !r.child) continue;
      if (!(await this.opts.services.canSeeProject(r.ext.name, projectId))) continue;
      r.child.postMessage({ t: 'event', event });
    }
  }

  /** Data a panel iframe posted to its host code. */
  sendPanelMessage(extension: string, panelId: string, data: unknown): void {
    const r = this.runners.get(extension);
    if (!r?.child || r.state !== 'running' || !r.ext.panelIds.includes(panelId)) return;
    r.child.postMessage({ t: 'panel', panelId, data });
  }

  /** Restart one extension's host code (developer mode). Keeps its activation event. */
  async restart(name: string, ext?: HostExtension): Promise<void> {
    const r = this.runners.get(name);
    if (!r) return;
    if (ext) r.ext = ext;
    const event = r.activatedBy;
    await this.stopRunner(r);
    r.crashes = [];
    if (event) await this.ensureStarted(r, event);
  }

  async stop(name: string): Promise<void> {
    const r = this.runners.get(name);
    if (r) await this.stopRunner(r);
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.runners.values()].map((r) => this.stopRunner(r)));
    this.runners.clear();
  }

  private newRunner(ext: HostExtension): Runner {
    return { ext, child: null, state: 'stopped', activatedBy: null, commands: new Set(), subscribed: false, ready: null, pending: new Map(), crashes: [], stopping: false, restartTimer: null, generation: 0 };
  }

  private ownerOf(commandId: string): Runner | undefined {
    for (const r of this.runners.values()) if (r.ext.commandIds.includes(commandId) || r.commands.has(commandId)) return r;
    return undefined;
  }

  private setState(r: Runner, state: HostState, error?: string): void {
    r.state = state;
    const change: HostStateChange = { name: r.ext.name, state, panelIds: r.ext.panelIds };
    if (error) change.error = error;
    for (const l of this.stateListeners) l(change);
  }

  private ensureStarted(r: Runner, event: string): Promise<void> {
    if (r.state === 'running' && r.child) return Promise.resolve();
    if (r.ready && (r.state === 'starting' || r.state === 'reloading')) return r.ready;
    if (r.state === 'failed' && r.activatedBy === event) return Promise.reject(new Error(`${r.ext.name} failed to start`));
    return this.start(r, event);
  }

  private buildEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const k of BASE_ENV_KEYS) {
      const v = process.env[k];
      if (v !== undefined) env[k] = v;
    }
    return { ...env, ...this.opts.env, OIDE_EXTENSION_HOST: '1' };
  }

  private start(r: Runner, event: string): Promise<void> {
    if (r.restartTimer) {
      clearTimeout(r.restartTimer);
      r.restartTimer = null;
    }
    r.activatedBy = event;
    r.stopping = false;
    r.commands = new Set();
    r.subscribed = false;
    const gen = ++r.generation;
    if (r.state !== 'reloading') this.setState(r, 'starting');
    const ready = new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve();
      };
      const timer = setTimeout(() => {
        settle(new Error(`${r.ext.name} did not activate within ${this.timeoutMs} ms`));
        this.setState(r, 'failed', 'activation timed out');
        r.stopping = true;
        r.child?.kill();
      }, this.timeoutMs);
      let child: HostChild;
      try {
        child = this.opts.fork(this.opts.entry ?? HOST_PROCESS_ENTRY, { serviceName: `oIDE extension: ${r.ext.name}`, env: this.buildEnv(), cwd: r.ext.dir });
      } catch (e) {
        settle(e as Error);
        this.setState(r, 'failed', (e as Error).message);
        return;
      }
      r.child = child;
      child.onMessage((msg) => {
        if (gen !== r.generation) return;
        if (msg.t === 'activated') {
          for (const c of msg.commands) r.commands.add(c);
          this.setState(r, 'running');
          settle();
        } else if (msg.t === 'activationFailed') {
          this.setState(r, 'failed', msg.error);
          r.stopping = true;
          child.kill();
          settle(new Error(`${r.ext.name} failed to activate: ${msg.error}`));
        } else {
          this.onMessage(r, child, msg);
        }
      });
      child.onExit((code) => {
        if (gen !== r.generation) return;
        r.child = null;
        for (const [, p] of r.pending) {
          clearTimeout(p.timer);
          p.reject(new Error(`${r.ext.name} host exited`));
        }
        r.pending.clear();
        if (r.stopping || r.state === 'failed') {
          if (r.state !== 'failed') this.setState(r, 'stopped');
          settle(new Error(`${r.ext.name} host stopped`));
          return;
        }
        settle(new Error(`${r.ext.name} host exited with code ${code}`));
        this.scheduleRestart(r, code);
      });
      child.postMessage({ t: 'init', ext: { name: r.ext.name, version: r.ext.version, dir: r.ext.dir, main: r.ext.main, activationEvent: event } });
    });
    r.ready = ready;
    return ready;
  }

  private scheduleRestart(r: Runner, code: number | null): void {
    const now = Date.now();
    r.crashes = r.crashes.filter((t) => now - t < this.backoff.windowMs);
    r.crashes.push(now);
    if (r.crashes.length > this.backoff.maxRestarts) {
      this.setState(r, 'failed', `crashed ${r.crashes.length} times (last exit code ${code})`);
      return;
    }
    const delay = Math.min(this.backoff.initialMs * 2 ** (r.crashes.length - 1), this.backoff.maxMs);
    this.setState(r, 'reloading', `exit code ${code}`);
    const event = r.activatedBy ?? 'onStartup';
    r.ready = new Promise<void>((resolve, reject) => {
      r.restartTimer = setTimeout(() => {
        r.restartTimer = null;
        this.start(r, event).then(resolve, reject);
      }, delay);
    });
    r.ready.catch(() => undefined);
  }

  private async stopRunner(r: Runner): Promise<void> {
    if (r.restartTimer) {
      clearTimeout(r.restartTimer);
      r.restartTimer = null;
    }
    const child = r.child;
    if (!child) {
      if (r.state !== 'stopped') this.setState(r, 'stopped');
      return;
    }
    r.stopping = true;
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        child.kill();
        resolve();
      }, 2000);
      child.onExit(() => {
        clearTimeout(t);
        resolve();
      });
      child.postMessage({ t: 'deactivate' });
    });
    r.child = null;
    if (r.state !== 'failed') this.setState(r, 'stopped');
  }

  private call(r: Runner, msg: { t: 'run'; commandId: string; args: unknown[] }, what: string): Promise<unknown> {
    const child = r.child;
    if (!child) return Promise.reject(new Error(`${r.ext.name} is not running`));
    const reqId = this.nextReq++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        r.pending.delete(reqId);
        reject(new Error(`${what} timed out`));
      }, this.timeoutMs);
      r.pending.set(reqId, { resolve, reject, timer });
      child.postMessage({ ...msg, reqId });
    });
  }

  private onMessage(r: Runner, child: HostChild, msg: HostToMain): void {
    const name = r.ext.name;
    const s = this.opts.services;
    switch (msg.t) {
      case 'commands':
        r.commands = new Set(msg.commands);
        break;
      case 'log':
        s.log(name, msg.level, String(msg.message).slice(0, 10_000));
        break;
      case 'result': {
        const p = r.pending.get(msg.reqId);
        if (!p) break;
        r.pending.delete(msg.reqId);
        clearTimeout(p.timer);
        if (msg.ok) p.resolve(msg.value);
        else p.reject(new Error(msg.error));
        break;
      }
      case 'request': {
        const reply = (v: Promise<unknown>) =>
          v.then(
            (value) => child.postMessage({ t: 'result', reqId: msg.reqId, ok: true, value }),
            (e: unknown) => child.postMessage({ t: 'result', reqId: msg.reqId, ok: false, error: e instanceof Error ? e.message : String(e) }),
          );
        const p = msg.params;
        const str = (i: number) => {
          const v = p[i];
          if (typeof v !== 'string') throw new Error('bad argument');
          return v;
        };
        const obj = (i: number) => (p[i] && typeof p[i] === 'object' ? (p[i] as Record<string, unknown>) : {});
        const optStr = (o: Record<string, unknown>, k: string) => (typeof o[k] === 'string' ? (o[k] as string) : undefined);
        void reply(
          (async () => {
            switch (msg.method) {
              case 'settings.get':
                return s.settingsGet(name, str(0));
              case 'settings.set': {
                const v = p[1];
                if (!(v === null || ['string', 'number', 'boolean'].includes(typeof v))) throw new Error('settings values must be string, number, boolean or null');
                return s.settingsSet(name, str(0), v as SettingValue);
              }
              case 'agents.list': {
                const f = obj(0);
                const projectId = optStr(f, 'projectId');
                return s.listAgents(name, projectId ? { projectId } : {});
              }
              case 'agents.postMessage':
                return s.postMessage(name, str(0), str(1));
              case 'agents.subscribe':
                r.subscribed = true;
                return true;
              case 'panels.open': {
                const id = str(0);
                if (!r.ext.panelIds.includes(id)) throw new Error(`unknown panel ${id}`);
                const o = obj(1);
                const opts: { agentId?: string; projectId?: string } = {};
                const a = optStr(o, 'agentId');
                const pr = optStr(o, 'projectId');
                if (a) opts.agentId = a;
                if (pr) opts.projectId = pr;
                return s.openPanel(name, id, opts);
              }
              case 'panels.postMessage': {
                const id = str(0);
                if (!r.ext.panelIds.includes(id)) throw new Error(`unknown panel ${id}`);
                return s.postPanelMessage(name, id, p[1]);
              }
              case 'artifacts.read':
                return s.readArtifact(name, str(0));
              default:
                throw new Error('unknown method');
            }
          })(),
        );
        break;
      }
      default:
        break;
    }
  }
}
