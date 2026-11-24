/**
 * In-memory OideBridge for running the renderer in a plain browser (`pnpm dev:web`).
 * Dev-only: main.tsx imports this module dynamically behind `import.meta.env.DEV`.
 *
 * Implements the commands the shell needs; anything else rejects with `[not_implemented]`,
 * exactly like main does for commands without a handler. Add cases as you build screens.
 */
import {
  AgentEvent,
  Commands,
  Events,
  type AgentSummary,
  type CommandInput,
  type CommandName,
  type CommandOutput,
  type EventName,
  type EventPayload,
  type OideBridge,
  type Scope,
} from '@oide/protocol';
import * as fx from './fixtures';

type Listener = (payload: unknown) => void;

export interface MockBridgeOptions {
  /** Emit a little fake activity on running agents (default true). */
  live?: boolean;
  /** Simulated latency in ms (default 40). */
  latency?: number;
}

export function createMockBridge(opts: MockBridgeOptions = {}): OideBridge & { emit: <K extends EventName>(e: K, p: EventPayload<K>) => void } {
  const listeners = new Map<string, Set<Listener>>();
  const agents = new Map<string, AgentSummary>(fx.agents.map((a) => [a.id, structuredClone(a)]));
  const events = new Map<string, AgentEvent[]>(Object.entries(fx.events).map(([k, v]) => [k, [...v]]));
  let scope: Scope = 'all';
  let settings = structuredClone(fx.settings);
  const latency = opts.latency ?? 40;

  const emit = <K extends EventName>(event: K, payload: EventPayload<K>) => {
    const parsed = Events[event].parse(payload);
    for (const fn of listeners.get(event) ?? []) fn(parsed);
  };

  const updateAgent = (id: string, patch: Partial<AgentSummary>) => {
    const a = agents.get(id);
    if (!a) throw new Error(`[not_found] No agent ${id}`);
    const next = { ...a, ...patch, updatedAt: Date.now() };
    agents.set(id, next);
    emit('agents.summary', next);
    return next;
  };

  const handlers: { [K in CommandName]?: (input: CommandInput<K>) => CommandOutput<K> | Promise<CommandOutput<K>> } = {
    'app.info': () => ({ version: '0.1.0-mock', platform: 'browser', userData: '/mock/userData' }),
    'cli.detect': () => fx.cli,
    'projects.list': () => fx.projects,
    'scope.get': () => scope,
    'scope.set': ({ scope: s }) => {
      scope = s;
      emit('scope.changed', s);
      return s;
    },
    'agents.list': () => [...agents.values()],
    'agents.events': ({ agentId, beforeSeq, limit }) => {
      const all = events.get(agentId) ?? [];
      const filtered = beforeSeq === undefined ? all : all.filter((e) => e.seq < beforeSeq);
      return filtered.slice(-(limit ?? 500));
    },
    'agents.answerPermission': ({ agentId, answer }) => {
      const a = agents.get(agentId);
      if (!a?.pendingPermission || a.pendingPermission.requestId !== answer.requestId) {
        throw new Error('[conflict] No pending permission request with that id');
      }
      const subagents = a.subagents.map((s) => (s.id === a.pendingPermission?.subagentId ? { ...s, status: answer.behavior === 'allow' ? ('running' as const) : ('error' as const) } : s));
      updateAgent(agentId, { pendingPermission: undefined, status: 'running', subagents });
      emit('notify', { level: 'info', message: answer.behavior === 'allow' ? 'Allowed. The agent continues.' : 'Denied.', agentId });
      return { ok: true as const };
    },
    'agents.send': ({ agentId, message }) => {
      const a = agents.get(agentId);
      if (!a) throw new Error(`[not_found] No agent ${agentId}`);
      if (message.kind === 'command' && message.command === '/compact') {
        emit('notify', { level: 'info', message: `Sent /compact to ${a.title}. Compacting…`, agentId });
      }
      if (a.status === 'has-question') updateAgent(agentId, { status: 'running', lastMessage: undefined });
      return { ok: true as const };
    },
    'agents.compact': ({ agentId }) => {
      const a = agents.get(agentId);
      emit('notify', { level: 'info', message: `Sent /compact to ${a?.title ?? agentId}. Compacting…`, agentId });
      return { ok: true as const };
    },
    'agents.pause': ({ agentId }) => (updateAgent(agentId, { status: 'paused' }), { ok: true as const }),
    'agents.resume': ({ agentId }) => (updateAgent(agentId, { status: 'running' }), { ok: true as const }),
    'agents.stop': ({ agentId }) => (updateAgent(agentId, { status: 'stopped' }), { ok: true as const }),
    'agents.setMode': ({ agentId, mode }) => (updateAgent(agentId, { mode }), { ok: true as const }),
    'git.diff': ({ agentId }) => fx.diffs[agentId] ?? [],
    'git.log': () => fx.commits,
    'artifacts.list': ({ projectId, kind }) => fx.artifacts.filter((a) => (!projectId || a.projectId === projectId) && (!kind || a.kind === kind)),
    'settings.get': () => settings,
    'settings.update': ({ patch }) => {
      settings = deepMerge(settings, patch) as typeof settings;
      emit('settings.changed', settings);
      return settings;
    },
    'usage.summary': () => fx.usage,
    'extensions.installed': () => [],
    'shell.openExternal': ({ url }) => {
      window.open(url, '_blank', 'noopener');
      return { ok: true as const };
    },
    'dialog.pickFolder': () => null,
  };

  if (opts.live ?? true) {
    let n = 0;
    setInterval(() => {
      const running = [...agents.values()].filter((a) => a.status === 'running');
      const a = running[n++ % Math.max(1, running.length)];
      if (!a) return;
      const list = events.get(a.id) ?? [];
      const ev = AgentEvent.parse({ type: 'thinking', agentId: a.id, seq: list.length, ts: Date.now(), text: 'Thinking…' });
      list.push(ev);
      events.set(a.id, list);
      emit('agents.batch', { events: [ev] });
    }, 4000);
  }

  return {
    platform: /Mac/i.test(navigator.platform) ? 'darwin' : /Win/i.test(navigator.platform) ? 'win32' : 'linux',
    emit,
    async invoke(command, input) {
      await new Promise((r) => setTimeout(r, latency));
      if (!Object.prototype.hasOwnProperty.call(Commands, command)) throw new Error(`[not_implemented] Unknown command: ${command}`);
      const handler = handlers[command] as ((i: unknown) => unknown) | undefined;
      if (!handler) throw new Error(`[not_implemented] Mock bridge has no handler for ${command}`);
      const parsedInput = Commands[command].input.parse(input);
      const out = await handler(parsedInput);
      return Commands[command].output.parse(out) as CommandOutput<typeof command>;
    },
    on(event, listener) {
      let set = listeners.get(event);
      if (!set) listeners.set(event, (set = new Set()));
      set.add(listener as Listener);
      return () => set.delete(listener as Listener);
    },
  };
}

function deepMerge(base: unknown, patch: unknown): unknown {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch) || !base || typeof base !== 'object') return patch;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) out[k] = deepMerge(out[k], v);
  return out;
}
