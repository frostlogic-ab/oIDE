import { useEffect, useMemo } from 'react';
import { create } from 'zustand';
import { NEEDS_YOU, type AgentEvent, type AgentSummary, type Scope } from '@oide/protocol';
import { invokeOr, oide } from '../lib/bridge';

/**
 * Agent state, fed by main:
 * - `agents.summary` (one AgentSummary per change) → `byId`
 * - `agents.batch` (normalized AgentEvents, one batch per ~16 ms) → `events[agentId]`, a live tail
 *   capped at MAX_EVENTS_PER_AGENT. Full history comes from `agents.events` (paged) in Focus.
 * - `agents.removed` → delete
 */
export const MAX_EVENTS_PER_AGENT = 2000;

export interface AgentCounts {
  total: number;
  running: number;
  needsYou: number;
  review: number;
  subagentsActive: number;
}

interface AgentsState {
  byId: Record<string, AgentSummary>;
  /** Display order (creation order). */
  order: string[];
  events: Record<string, AgentEvent[]>;
  loaded: boolean;
  load(): Promise<void>;
  applySummary(summary: AgentSummary): void;
  applyBatch(events: AgentEvent[]): void;
  remove(agentId: string): void;
  /** Prepend older events fetched with `agents.events` (Focus transcript paging). */
  prependHistory(agentId: string, events: AgentEvent[]): void;
}

function sortOrder(byId: Record<string, AgentSummary>): string[] {
  return Object.values(byId)
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
    .map((a) => a.id);
}

export const useAgents = create<AgentsState>()((set, get) => ({
  byId: {},
  order: [],
  events: {},
  loaded: false,
  load: async () => {
    const list = await invokeOr('agents.list', undefined, []);
    const byId = Object.fromEntries(list.map((a) => [a.id, a]));
    set({ byId, order: sortOrder(byId), loaded: true });
  },
  applySummary: (summary) => {
    const prev = get().byId;
    const isNew = !prev[summary.id];
    const byId = { ...prev, [summary.id]: summary };
    set(isNew ? { byId, order: sortOrder(byId) } : { byId });
  },
  applyBatch: (incoming) => {
    if (!incoming.length) return;
    const events = { ...get().events };
    const touched = new Set<string>();
    for (const ev of incoming) {
      if (ev.type === 'partial') continue; // streaming deltas are for live typing UIs, not the log
      if (!touched.has(ev.agentId)) {
        events[ev.agentId] = [...(events[ev.agentId] ?? [])];
        touched.add(ev.agentId);
      }
      events[ev.agentId]!.push(ev);
    }
    for (const id of touched) {
      const arr = events[id]!;
      if (arr.length > MAX_EVENTS_PER_AGENT) events[id] = arr.slice(arr.length - MAX_EVENTS_PER_AGENT);
    }
    set({ events });
  },
  remove: (agentId) => {
    const byId = { ...get().byId };
    delete byId[agentId];
    const events = { ...get().events };
    delete events[agentId];
    set({ byId, order: sortOrder(byId), events });
  },
  prependHistory: (agentId, older) => {
    const current = get().events[agentId] ?? [];
    const firstSeq = current[0]?.seq ?? Number.POSITIVE_INFINITY;
    const merged = [...older.filter((e) => e.seq < firstSeq), ...current];
    set({ events: { ...get().events, [agentId]: merged } });
  },
}));

// ---------- pure selectors ----------

export function agentsInScope(byId: Record<string, AgentSummary>, order: string[], scope: Scope): AgentSummary[] {
  const out: AgentSummary[] = [];
  for (const id of order) {
    const a = byId[id];
    if (a && (scope === 'all' || a.projectId === scope)) out.push(a);
  }
  return out;
}

export function isNeedsYou(a: AgentSummary): boolean {
  return NEEDS_YOU.has(a.status);
}

export function isRunning(a: AgentSummary): boolean {
  return a.status === 'running' || a.status === 'starting';
}

export function countAgents(agents: AgentSummary[]): AgentCounts {
  const c: AgentCounts = { total: agents.length, running: 0, needsYou: 0, review: 0, subagentsActive: 0 };
  for (const a of agents) {
    if (isRunning(a)) c.running++;
    if (isNeedsYou(a)) c.needsYou++;
    if (a.status === 'ready-for-review') c.review++;
    c.subagentsActive += a.subagents.filter((s) => s.status === 'running' || s.status === 'needs-permission').length;
  }
  return c;
}

/** Next agent (after `currentId`, wrapping) that needs the user, for N. */
export function nextNeedsYou(agents: AgentSummary[], currentId?: string): AgentSummary | undefined {
  const needs = agents.filter(isNeedsYou);
  if (!needs.length) return undefined;
  const idx = agents.findIndex((a) => a.id === currentId);
  return needs.find((a) => agents.indexOf(a) > idx) ?? needs[0];
}

/** Agent after/before `currentId` in `agents`, wrapping, for J/K. */
export function stepAgent(agents: AgentSummary[], currentId: string | undefined, dir: 1 | -1): AgentSummary | undefined {
  if (!agents.length) return undefined;
  const idx = agents.findIndex((a) => a.id === currentId);
  const next = idx < 0 ? (dir === 1 ? 0 : agents.length - 1) : (idx + dir + agents.length) % agents.length;
  return agents[next];
}

// ---------- hooks ----------

export function useAgent(agentId: string | undefined): AgentSummary | undefined {
  return useAgents((s) => (agentId ? s.byId[agentId] : undefined));
}

const EMPTY: AgentEvent[] = [];
export function useAgentEvents(agentId: string | undefined): AgentEvent[] {
  return useAgents((s) => (agentId ? (s.events[agentId] ?? EMPTY) : EMPTY));
}

/** Agents visible under a project scope, in display order. */
export function useAgentsInScope(scope: Scope): AgentSummary[] {
  const byId = useAgents((s) => s.byId);
  const order = useAgents((s) => s.order);
  return useMemo(() => agentsInScope(byId, order, scope), [byId, order, scope]);
}

export function useAgentCounts(scope: Scope = 'all'): AgentCounts {
  const agents = useAgentsInScope(scope);
  return useMemo(() => countAgents(agents), [agents]);
}

export function useNeedsYou(scope: Scope = 'all'): AgentSummary[] {
  const agents = useAgentsInScope(scope);
  return useMemo(() => agents.filter(isNeedsYou), [agents]);
}

/**
 * Load the persisted event log (`agents.events`, newest `limit`) for an agent once, merging it
 * under the live tail. Focus calls this; for older pages call `loadOlderEvents(agentId)`.
 */
export function useAgentHistory(agentId: string | undefined, limit = 500): void {
  useEffect(() => {
    if (!agentId) return;
    let cancelled = false;
    void invokeOr('agents.events', { agentId, limit }, []).then((events) => {
      if (!cancelled && events.length) useAgents.getState().prependHistory(agentId, events);
    }, () => {});
    return () => {
      cancelled = true;
    };
  }, [agentId, limit]);
}

/** Fetch the page of events before the oldest one held. Returns how many were added. */
export async function loadOlderEvents(agentId: string, limit = 500): Promise<number> {
  const first = useAgents.getState().events[agentId]?.[0];
  const older = await invokeOr('agents.events', { agentId, limit, beforeSeq: first?.seq }, []);
  useAgents.getState().prependHistory(agentId, older);
  return older.length;
}

/** Subscribe the store to main's agent events. Returns an unsubscribe. */
export function connectAgents(): () => void {
  const offs = [
    oide.on('agents.summary', (s) => useAgents.getState().applySummary(s)),
    oide.on('agents.batch', ({ events }) => useAgents.getState().applyBatch(events)),
    oide.on('agents.removed', ({ agentId }) => useAgents.getState().remove(agentId)),
  ];
  return () => offs.forEach((off) => off());
}
