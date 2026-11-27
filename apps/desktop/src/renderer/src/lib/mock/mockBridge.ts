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
import { focusDiffs, focusEvents, focusHandlers, patchFocusAgent, startFocusDemo } from './focus';
import { libraryHandlers, seedLibrarySettings } from './library';
import { createScmHandlers } from './scm';
import { mockUsageStats } from './usage';
import { seedAgents, seedArchived, seedProjects, wallHandlers, wallMockMode } from './wall';

type Listener = (payload: unknown) => void;

export interface MockBridgeOptions {
  /** Emit a little fake activity on running agents (default true). */
  live?: boolean;
  /** Simulated latency in ms (default 40). */
  latency?: number;
}

export function createMockBridge(opts: MockBridgeOptions = {}): OideBridge & { emit: <K extends EventName>(e: K, p: EventPayload<K>) => void } {
  const listeners = new Map<string, Set<Listener>>();
  // `?wall=states|empty|no-projects` in the dev URL switches the Wall fixtures (see ./wall.ts).
  const wallMode = wallMockMode();
  const agents = new Map<string, AgentSummary>(seedAgents(fx.agents, wallMode).map((a) => [a.id, structuredClone(patchFocusAgent(a))]));
  const events = new Map<string, AgentEvent[]>(Object.entries({ ...fx.events, ...focusEvents }).map(([k, v]) => [k, [...v]]));
  // Wall › Archived: a few finished agents (dev:web), newest first.
  const archived = new Map<string, AgentSummary>(seedArchived(fx.agents).map((a) => [a.id, a]));
  let scope: Scope = 'all';
  let settings = seedLibrarySettings(structuredClone(fx.settings));
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
    // Source control, Review, Files (git.*, review.*, files.*): see ./scm.ts. Later keys override.
    ...createScmHandlers({ agents, emit, fallbackDiffs: { ...fx.diffs, ...focusDiffs }, artifacts: fx.artifacts }),
    'app.info': () => ({ version: '0.1.0-mock', platform: 'browser', userData: '/mock/userData' }),
    'app.diagnostics': () => {
      const checks = [
        { id: 'cli', label: 'Claude Code CLI', status: 'ok' as const, value: '2.1.325 · ~/.local/bin/claude', detail: 'In the tested range.' },
        { id: 'git', label: 'git', status: 'ok' as const, value: '2.45.1 · /usr/bin/git' },
        { id: 'gh', label: 'GitHub CLI (gh)', status: 'warn' as const, value: 'Not found', detail: 'Optional. Opening pull requests from Review needs gh.' },
        { id: 'mcp', label: 'oIDE MCP server', status: 'ok' as const, value: '127.0.0.1:51234' },
      ];
      return { generatedAt: new Date().toISOString(), checks, report: checks.map((c) => `${c.label}: ${c.value}`).join('\n') };
    },
    'app.openLogsFolder': () => ({ ok: true as const }),
    'app.pendingCleanups': () => [],
    'app.retryCleanup': () => ({ removed: [], stillPending: [], gaveUp: [] }),
    'app.cleanupHolders': () => ({ supported: false, holders: [] }),
    'app.reportError': () => ({ ok: true as const }),
    'cli.detect': () => fx.cli,
    'projects.list': () => seedProjects(fx.projects, wallMode),
    'scope.get': () => scope,
    'scope.set': ({ scope: s }) => {
      scope = s;
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
      // Echo text messages into the transcript (with pasted images and files) so dev:web shows them.
      if (message.kind === 'text') {
        const list = events.get(agentId) ?? [];
        const ev = AgentEvent.parse({ type: 'user-text', agentId, seq: (list[list.length - 1]?.seq ?? -1) + 1, ts: Date.now(), text: message.text, ...(message.attachments?.length ? { attachments: message.attachments } : {}) });
        list.push(ev);
        events.set(agentId, list);
        emit('agents.batch', { events: [ev] });
      }
      return { ok: true as const };
    },
    // The Wall toasts "Sent /compact to …" itself after this resolves.
    'agents.compact': () => ({ ok: true as const }),
    'agents.pause': ({ agentId }) => (updateAgent(agentId, { status: 'paused' }), { ok: true as const }),
    'agents.resume': ({ agentId }) => (updateAgent(agentId, { status: 'running' }), { ok: true as const }),
    'agents.stop': ({ agentId }) => (updateAgent(agentId, { status: 'stopped' }), { ok: true as const }),
    'agents.setMode': ({ agentId, mode }) => (updateAgent(agentId, { mode }), { ok: true as const }),
    // Like main: refused for a custom model; the next message uses the new model and effort.
    'agents.setModel': ({ agentId, model, effort }) => {
      const a = agents.get(agentId);
      if (!a) throw new Error(`[not_found] No agent ${agentId}`);
      if (!/haiku|sonnet|opus|fable/i.test(a.model)) throw new Error('[conflict] This agent runs on a custom model; start a new agent to change it.');
      updateAgent(agentId, { model, effort });
      return { ok: true as const };
    },
    'agents.archive': ({ agentId }) => {
      const a = agents.get(agentId);
      if (!a) throw new Error(`[not_found] No agent ${agentId}`);
      if (['running', 'starting', 'needs-permission', 'queued'].includes(a.status)) throw new Error(`[conflict] "${a.title}" is still working. Stop it first, then archive it.`);
      const s: AgentSummary = { ...a, archived: { at: Date.now(), reason: a.status === 'done' ? 'completed' : 'archived-by-user', worktreeRemoved: false }, updatedAt: Date.now() };
      agents.delete(agentId);
      archived.set(agentId, s);
      emit('agents.archived', s);
      return s;
    },
    'agents.unarchive': ({ agentId }) => {
      const a = archived.get(agentId);
      if (!a) throw new Error(`[not_found] No archived agent ${agentId}`);
      const { archived: info, ...rest } = a;
      const s: AgentSummary = { ...rest, status: 'stopped', ...(info?.worktreeRemoved ? { resumeBlocked: 'Its worktree was deleted, so this session cannot be resumed. Open it to read the transcript.' } : {}), updatedAt: Date.now() };
      archived.delete(agentId);
      agents.set(agentId, s);
      emit('agents.summary', s);
      return s;
    },
    'agents.listArchived': ({ projectId, query, limit = 50, cursor }) => {
      const q = query?.trim().toLowerCase();
      const all = [...archived.values()]
        .filter((a) => (!projectId || a.projectId === projectId) && (!q || a.title.toLowerCase().includes(q)))
        .sort((a, b) => b.archived!.at - a.archived!.at || (b.id < a.id ? -1 : 1));
      const start = cursor ? all.findIndex((a) => a.id === cursor.id) + 1 : 0;
      const items = all.slice(start, start + limit);
      const last = items[items.length - 1];
      return { items, total: all.length, ...(start + limit < all.length && last ? { nextCursor: { at: last.archived!.at, id: last.id } } : {}) };
    },
    'agents.getArchived': ({ agentId }) => {
      const a = archived.get(agentId);
      if (!a) throw new Error(`[not_found] No archived agent ${agentId}`);
      return a;
    },
    'agents.deletePermanently': ({ agentId }) => {
      if (!window.confirm('Delete this agent permanently? Its transcript is deleted from oIDE.')) return { deleted: false };
      archived.delete(agentId);
      agents.delete(agentId);
      emit('agents.removed', { agentId });
      return { deleted: true };
    },
    'artifacts.list': ({ projectId, kind }) => fx.artifacts.filter((a) => (!projectId || a.projectId === projectId) && (!kind || a.kind === kind)),
    'settings.get': () => settings,
    'settings.update': ({ patch }) => {
      settings = deepMerge(settings, patch) as typeof settings;
      emit('settings.changed', settings);
      return settings;
    },
    'usage.summary': () => fx.usage,
    'usage.stats': ({ range }) => mockUsageStats(range),
    'updates.status': () => ({ state: 'disabled', currentVersion: '0.1.0-mock', channel: settings.updates.channel, disabledReason: 'Updates are off in development builds.', canInstall: false }),
    'extensions.installed': () => [],
    'shell.openExternal': ({ url }) => {
      window.open(url, '_blank', 'noopener');
      return { ok: true as const };
    },
    'dialog.pickFolder': () => null,
    // Attach file: the mock has no files on disk; it returns one pretend file.
    'dialog.pickFiles': () => ({ attachments: [{ kind: 'file' as const, path: '/Users/you/Downloads/requirements.pdf', name: 'requirements.pdf', size: 248_000 }], rejected: [] }),
    // Focus: Terminal tab shell, Stop subagent (lib/mock/focus.ts).
    ...focusHandlers(emit),
    // Wall and Spawn: agents.spawn, projects.open (lib/mock/wall.ts).
    ...wallHandlers({ agents, emit, getSettings: () => settings }),
    // Artifacts, Marketplace and Settings screens (lib/mock/library.ts). Spread last: overrides the
    // simpler artifacts.list / extensions.installed above.
    ...libraryHandlers({
      emit,
      getSettings: () => settings,
      setSettings: (s) => {
        settings = s;
        emit('settings.changed', s);
      },
      putAgent: (a) => {
        agents.set(a.id, a);
        emit('agents.summary', a);
      },
      getAgent: (id) => agents.get(id),
      addEvents: (agentId, raw) => {
        const list = events.get(agentId) ?? [];
        const parsed = raw.map((e, i) => AgentEvent.parse({ ...e, agentId, seq: (list[list.length - 1]?.seq ?? -1) + 1 + i, ts: Date.now() }));
        list.push(...parsed);
        events.set(agentId, list);
        emit('agents.batch', { events: parsed });
      },
    }),
  };

  if (opts.live ?? true) {
    startFocusDemo(emit, events);
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
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    // Like main's store: `null` removes the key so the default comes back.
    if (v === null) delete out[k];
    else out[k] = deepMerge(out[k], v);
  }
  return out;
}
