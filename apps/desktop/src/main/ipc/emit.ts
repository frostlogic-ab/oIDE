import { Events, IPC_EVENT_CHANNEL, type AgentEvent, type EventName, type EventPayload } from '@oide/protocol';
import type { Logger } from './router.js';

/**
 * Main → renderer events. Every payload is validated against `Events` before it crosses IPC and
 * sent on `IPC_EVENT_CHANNEL` as `{ event, payload }`. Preload fans it out to `window.oide.on`.
 */

export type Emit = <K extends EventName>(event: K, payload: EventPayload<K>) => boolean;

export interface EventTarget {
  isDestroyed(): boolean;
  send(channel: string, message: unknown): void;
}

export function createEmitter(getTargets: () => EventTarget[], log?: Logger): Emit {
  return (event, payload) => {
    const schema = Events[event];
    if (!schema) {
      log?.error(`[ipc] emit of unknown event "${String(event)}"`);
      return false;
    }
    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      log?.error(`[ipc] dropped invalid "${event}" payload: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
      return false;
    }
    let sent = false;
    for (const target of getTargets()) {
      if (target.isDestroyed()) continue;
      target.send(IPC_EVENT_CHANNEL, { event, payload: parsed.data });
      sent = true;
    }
    return sent;
  };
}

/**
 * Collects items and flushes them at most once per frame (~16 ms). Main has no
 * requestAnimationFrame, so this uses a timer. Used for `agents.batch` and terminal output.
 */
export class FrameBatcher<T> {
  private items: T[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly onFlush: (items: T[]) => void,
    private readonly intervalMs = 16,
    private readonly maxItems = 1000,
  ) {}

  push(item: T): void {
    this.items.push(item);
    if (this.items.length >= this.maxItems) {
      this.flush();
      return;
    }
    if (!this.timer) this.timer = setTimeout(() => this.flush(), this.intervalMs);
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.items.length) return;
    const batch = this.items;
    this.items = [];
    this.onFlush(batch);
  }

  get pending(): number {
    return this.items.length;
  }

  dispose(): void {
    this.flush();
  }
}

/** Batches normalized agent events into one `agents.batch` event per frame. */
export function createAgentEventBatcher(emit: Emit, intervalMs = 16): FrameBatcher<AgentEvent> {
  return new FrameBatcher<AgentEvent>((events) => emit('agents.batch', { events }), intervalMs, 2000);
}
