/**
 * Entry point of an extension host process (Electron `utilityProcess`, or `child_process.fork`
 * in tests). Runs one extension: imports its `main`, builds the `ExtensionContext` and forwards
 * every API call to the main process over the parent port.
 *
 * Self-contained on purpose (only `node:` imports and type-only imports), so Node can run this
 * file directly with type stripping and bundlers can emit it as its own entry.
 */
import { pathToFileURL } from 'node:url';
import { format } from 'node:util';
import type { AgentEventInfo, CommandHandler, Disposable, ExtensionContext, ExtensionModule, Logger } from '@oide/extension-api';
import type { HostInit, HostRequestMethod, HostToMain, MainToHost } from './rpc.js';

interface Port {
  send(msg: HostToMain): void;
  onMessage(cb: (msg: MainToHost) => void): void;
}

interface ParentPortLike {
  postMessage(msg: unknown): void;
  on(event: 'message', cb: (e: { data: unknown }) => void): void;
}

function connect(): Port {
  const pp = (process as unknown as { parentPort?: ParentPortLike }).parentPort;
  if (pp) {
    return {
      send: (m) => pp.postMessage(m),
      onMessage: (cb) => pp.on('message', (e) => cb(e.data as MainToHost)),
    };
  }
  if (typeof process.send === 'function') {
    return {
      send: (m) => process.send?.(m),
      onMessage: (cb) => process.on('message', (m) => cb(m as MainToHost)),
    };
  }
  throw new Error('extension host must be started as a utility or forked process');
}

const port = connect();
let nextReq = 1;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
const commands = new Map<string, CommandHandler>();
const panelListeners = new Map<string, Set<(data: unknown) => void>>();
const eventListeners = new Set<(e: AgentEventInfo) => void>();
let subscribed = false;
let mod: ExtensionModule | null = null;
let ctx: ExtensionContext | null = null;

function request(method: HostRequestMethod, ...params: unknown[]): Promise<unknown> {
  const reqId = nextReq++;
  return new Promise((resolve, reject) => {
    pending.set(reqId, { resolve, reject });
    port.send({ t: 'request', reqId, method, params });
  });
}

function toCloneable(v: unknown): unknown {
  if (v === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(v));
  } catch {
    return String(v);
  }
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function log(level: 'debug' | 'info' | 'warn' | 'error', args: unknown[]): void {
  port.send({ t: 'log', level, message: format(...args) });
}

// Extensions that use console.* still end up in oIDE's extension log.
console.log = (...a: unknown[]) => log('info', a);
console.info = (...a: unknown[]) => log('info', a);
console.debug = (...a: unknown[]) => log('debug', a);
console.warn = (...a: unknown[]) => log('warn', a);
console.error = (...a: unknown[]) => log('error', a);

const disposable = (fn: () => void): Disposable => {
  let done = false;
  return {
    dispose() {
      if (done) return;
      done = true;
      fn();
    },
  };
};

function buildContext(ext: HostInit): ExtensionContext {
  const logger: Logger = {
    debug: (...a) => log('debug', a),
    info: (...a) => log('info', a),
    warn: (...a) => log('warn', a),
    error: (...a) => log('error', a),
  };
  return {
    extension: { name: ext.name, version: ext.version, path: ext.dir },
    activationEvent: ext.activationEvent,
    subscriptions: [],
    log: logger,
    commands: {
      register(id, handler) {
        if (typeof id !== 'string' || !id) throw new Error('command id must be a non-empty string');
        commands.set(id, handler);
        port.send({ t: 'commands', commands: [...commands.keys()] });
        return disposable(() => {
          if (commands.get(id) === handler) commands.delete(id);
          port.send({ t: 'commands', commands: [...commands.keys()] });
        });
      },
    },
    settings: {
      get: (key) => request('settings.get', key) as never,
      set: async (key, value) => {
        await request('settings.set', key, value);
      },
    },
    agents: {
      list: (filter) => request('agents.list', filter ?? {}) as never,
      postMessage: async (agentId, text) => {
        await request('agents.postMessage', agentId, text);
      },
      onEvent(listener) {
        eventListeners.add(listener);
        if (!subscribed) {
          subscribed = true;
          void request('agents.subscribe').catch(() => {
            subscribed = false;
          });
        }
        return disposable(() => eventListeners.delete(listener));
      },
    },
    panels: {
      open: async (panelId, options) => {
        await request('panels.open', panelId, options ?? {});
      },
      postMessage: async (panelId, data) => {
        await request('panels.postMessage', panelId, toCloneable(data));
      },
      onMessage(panelId, listener) {
        let set = panelListeners.get(panelId);
        if (!set) panelListeners.set(panelId, (set = new Set()));
        set.add(listener);
        return disposable(() => set.delete(listener));
      },
    },
    artifacts: {
      read: (id) => request('artifacts.read', id) as never,
    },
  };
}

async function activate(ext: HostInit): Promise<void> {
  try {
    ctx = buildContext(ext);
    mod = (await import(pathToFileURL(ext.main).href)) as ExtensionModule & { default?: ExtensionModule };
    const m = mod as ExtensionModule & { default?: ExtensionModule };
    const activateFn = m.activate ?? m.default?.activate;
    if (m.default && !m.activate) mod = m.default;
    if (activateFn) await activateFn.call(mod, ctx);
    port.send({ t: 'activated', commands: [...commands.keys()] });
  } catch (e) {
    port.send({ t: 'activationFailed', error: errorText(e) });
  }
}

async function deactivate(): Promise<void> {
  try {
    await mod?.deactivate?.();
  } catch (e) {
    log('error', ['deactivate failed:', errorText(e)]);
  }
  for (const d of ctx?.subscriptions ?? []) {
    try {
      d.dispose();
    } catch {
      /* ignore */
    }
  }
  port.send({ t: 'deactivated' });
  setTimeout(() => process.exit(0), 20);
}

port.onMessage((msg) => {
  switch (msg.t) {
    case 'init':
      void activate(msg.ext);
      break;
    case 'run': {
      const handler = commands.get(msg.commandId);
      if (!handler) {
        port.send({ t: 'result', reqId: msg.reqId, ok: false, error: `command not registered: ${msg.commandId}` });
        break;
      }
      Promise.resolve()
        .then(() => handler(...msg.args))
        .then(
          (value) => port.send({ t: 'result', reqId: msg.reqId, ok: true, value: toCloneable(value) }),
          (e: unknown) => port.send({ t: 'result', reqId: msg.reqId, ok: false, error: errorText(e) }),
        );
      break;
    }
    case 'event':
      for (const l of eventListeners) {
        try {
          l(msg.event as AgentEventInfo);
        } catch (e) {
          log('error', ['agent event listener failed:', errorText(e)]);
        }
      }
      break;
    case 'panel':
      for (const l of panelListeners.get(msg.panelId) ?? []) {
        try {
          l(msg.data);
        } catch (e) {
          log('error', ['panel listener failed:', errorText(e)]);
        }
      }
      break;
    case 'result': {
      const p = pending.get(msg.reqId);
      if (!p) break;
      pending.delete(msg.reqId);
      if (msg.ok) p.resolve(msg.value);
      else p.reject(new Error(msg.error));
      break;
    }
    case 'deactivate':
      void deactivate();
      break;
  }
});

// A forked child outlives a dead parent unless it leaves when the IPC channel closes.
process.on('disconnect', () => process.exit(0));

process.on('uncaughtException', (e) => {
  log('error', ['uncaught:', e instanceof Error ? (e.stack ?? e.message) : String(e)]);
  process.exit(1);
});
process.on('unhandledRejection', (e) => {
  log('error', ['unhandled rejection:', errorText(e)]);
});
