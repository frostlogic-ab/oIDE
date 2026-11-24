import { useEffect, useState } from 'react';
import type { AgentEvent } from '@oide/protocol';
import { oide } from '../../../lib/bridge';

/**
 * Live "Writing…" text from partial deltas (`--include-partial-messages`). Partials are not kept in
 * the agents store, so this listens to `agents.batch` itself and flushes at most once per
 * animation frame: a delta re-renders only this component, never the transcript rows.
 */
export interface StreamState {
  kind: 'text' | 'thinking' | 'tool-input';
  text: string;
  messageId?: string;
}

const ENDS: ReadonlySet<AgentEvent['type']> = new Set(['assistant-text', 'thinking', 'tool-use', 'result', 'error', 'exit', 'rate-limit']);

/** Pure reducer over one batch (exported for tests). */
export function reduceStream(prev: StreamState | null, events: readonly AgentEvent[], agentId: string, parent?: string): StreamState | null {
  let s = prev;
  for (const e of events) {
    if (e.agentId !== agentId || e.parentToolUseId !== parent) continue;
    if (e.type === 'partial') {
      if (!s || s.messageId !== e.messageId || s.kind !== e.kind) s = { kind: e.kind, text: '', messageId: e.messageId };
      s = { ...s, text: s.text + e.delta };
    } else if (ENDS.has(e.type)) s = null;
  }
  return s;
}

export function useStreaming(agentId: string, parent?: string): StreamState | null {
  const [state, setState] = useState<StreamState | null>(null);
  useEffect(() => {
    let buf: StreamState | null = null;
    let raf = 0;
    setState(null);
    const off = oide.on('agents.batch', ({ events }) => {
      const next = reduceStream(buf, events, agentId, parent);
      if (next === buf) return;
      buf = next;
      if (!raf) {
        raf = requestAnimationFrame(() => {
          raf = 0;
          setState(buf);
        });
      }
    });
    return () => {
      off();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [agentId, parent]);
  return state;
}

export function Streaming({ agentId, parent }: { agentId: string; parent?: string }) {
  const s = useStreaming(agentId, parent);
  if (!s) return null;
  if (s.kind !== 'text') {
    return <div className="pb-3.5 text-[12px] text-ink-3 italic">{s.kind === 'thinking' ? 'Thinking…' : 'Preparing a tool call…'}</div>;
  }
  return (
    <div className="pb-3.5 flex flex-col gap-1" aria-hidden="true">
      <span className="text-[11px] text-ink-3">Writing…</span>
      <div className="leading-[1.55] text-ink-prose whitespace-pre-wrap break-words">{s.text.length > 8000 ? `…${s.text.slice(-8000)}` : s.text}</div>
    </div>
  );
}
