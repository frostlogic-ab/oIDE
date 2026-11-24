/**
 * The Focus transcript's own event log for the agent on screen: persisted history from
 * `agents.events` (newest page first, older pages on scroll-up) merged with the live tail from the
 * agents store. Kept separate from the store's tail because that tail is capped
 * (MAX_EVENTS_PER_AGENT) and would drop history the user has scrolled back to.
 * Only one agent is held at a time; switching agents resets it.
 */
import { useEffect } from 'react';
import { create } from 'zustand';
import type { AgentEvent } from '@oide/protocol';
import { invokeOr } from '../../../lib/bridge';
import { useAgentEvents, useAgents } from '../../../stores/agents';

export const PAGE_SIZE = 500;

interface HistoryState {
  agentId: string | null;
  events: AgentEvent[];
  hasMore: boolean;
  loading: boolean;
  /** Bumped on reset so stale fetches are dropped. */
  epoch: number;
  reset(agentId: string | null): number;
  /** Merge a page of older events under what is held. */
  prepend(epoch: number, older: AgentEvent[], hasMore: boolean): void;
  /** Append live events newer than the newest held. */
  appendTail(agentId: string, tail: readonly AgentEvent[]): void;
  setLoading(loading: boolean): void;
}

/** Older page + current, de-duplicated by seq (both sorted ascending). */
export function mergeOlder(older: readonly AgentEvent[], current: readonly AgentEvent[]): AgentEvent[] {
  const first = current[0]?.seq ?? Number.POSITIVE_INFINITY;
  const head = older.filter((e) => e.seq < first);
  return head.length ? [...head, ...current] : (current as AgentEvent[]);
}

/** Current + the tail events newer than the newest held. Returns `current` itself when nothing is new. */
export function mergeTail(current: readonly AgentEvent[], tail: readonly AgentEvent[]): AgentEvent[] {
  const last = current.length ? current[current.length - 1]!.seq : -1;
  let i = tail.length;
  while (i > 0 && tail[i - 1]!.seq > last) i--;
  if (i === tail.length) return current as AgentEvent[];
  return [...current, ...tail.slice(i)];
}

export const useFocusHistory = create<HistoryState>()((set, get) => ({
  agentId: null,
  events: [],
  hasMore: false,
  loading: false,
  epoch: 0,
  reset: (agentId) => {
    const epoch = get().epoch + 1;
    set({ agentId, events: [], hasMore: false, loading: agentId !== null, epoch });
    return epoch;
  },
  prepend: (epoch, older, hasMore) => {
    if (epoch !== get().epoch) return;
    set({ events: mergeOlder(older, get().events), hasMore, loading: false });
  },
  appendTail: (agentId, tail) => {
    if (get().agentId !== agentId) return;
    const next = mergeTail(get().events, tail);
    if (next !== get().events) set({ events: next });
  },
  setLoading: (loading) => set({ loading }),
}));

/** Load the newest page for `agentId` and keep following its live tail. */
export function useTranscriptHistory(agentId: string | undefined): void {
  const tail = useAgentEvents(agentId);
  useEffect(() => {
    const store = useFocusHistory.getState();
    const epoch = store.reset(agentId ?? null);
    if (!agentId) return;
    store.appendTail(agentId, useAgents.getState().events[agentId] ?? []);
    void invokeOr('agents.events', { agentId, limit: PAGE_SIZE }, [] as AgentEvent[]).then(
      (page) => useFocusHistory.getState().prepend(epoch, page, page.length >= PAGE_SIZE),
      () => useFocusHistory.getState().prepend(epoch, [], false),
    );
  }, [agentId]);
  useEffect(() => {
    if (agentId) useFocusHistory.getState().appendTail(agentId, tail);
  }, [agentId, tail]);
}

/** Fetch the page before the oldest held event. */
export async function loadOlder(): Promise<void> {
  const st = useFocusHistory.getState();
  if (!st.agentId || st.loading || !st.hasMore) return;
  const first = st.events[0];
  const epoch = st.epoch;
  st.setLoading(true);
  try {
    const page = await invokeOr('agents.events', { agentId: st.agentId, limit: PAGE_SIZE, ...(first ? { beforeSeq: first.seq } : {}) }, [] as AgentEvent[]);
    useFocusHistory.getState().prepend(epoch, page, page.length >= PAGE_SIZE);
  } catch {
    useFocusHistory.getState().prepend(epoch, [], false);
  }
}
