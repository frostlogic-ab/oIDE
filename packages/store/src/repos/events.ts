import { z } from 'zod';
import { AgentEvent, TokenUsage, type AgentEventDraft } from '@oide/protocol';
import { fromJson, type Database } from '../db.js';
import { num, type Row } from '../util.js';

/** What a range of compacted events turns into. */
export const EventSummary = z.object({
  agentId: z.string(),
  fromSeq: z.number().int(),
  toSeq: z.number().int(),
  fromTs: z.number(),
  toTs: z.number(),
  count: z.number().int(),
  byType: z.record(z.string(), z.number().int()),
  tools: z.record(z.string(), z.number().int()),
  usage: TokenUsage,
  lastAssistantText: z.string().optional(),
  lastResult: z.string().optional(),
});
export type EventSummary = z.infer<typeof EventSummary>;

export interface EventPage {
  /** Ascending by seq. */
  events: AgentEvent[];
  /** True when older events exist before the first one returned. */
  hasMore: boolean;
}

/** Events never persisted (streaming deltas). */
const TRANSIENT = new Set(['partial']);
const DAY = 24 * 60 * 60 * 1000;

function parseEvent(r: Row): AgentEvent {
  const data = fromJson<Record<string, unknown>>(r.data) ?? {};
  const parsed = AgentEvent.safeParse(data);
  if (parsed.success) return parsed.data;
  // An event written by an older/newer parser: keep the timeline intact, mark it unknown.
  return AgentEvent.parse({ agentId: r.agent_id, seq: num(r.seq), ts: num(r.ts), type: 'unknown', rawType: String(r.type) });
}

export class EventsRepo {
  private readonly seqCache = new Map<string, number>();

  constructor(private readonly d: Database) {}

  /** Highest stored seq for an agent, or -1. */
  lastSeq(agentId: string): number {
    const r = this.d.db.prepare('SELECT MAX(seq) AS s FROM events WHERE agent_id = ?').get(agentId) as Row;
    const s = this.d.db.prepare('SELECT MAX(to_seq) AS s FROM event_summaries WHERE agent_id = ?').get(agentId) as Row;
    return Math.max(num(r.s) ?? -1, num(s.s) ?? -1);
  }

  /** Next seq to use. Cached in memory after the first call. */
  nextSeq(agentId: string): number {
    const cached = this.seqCache.get(agentId);
    const next = cached ?? this.lastSeq(agentId) + 1;
    this.seqCache.set(agentId, next + 1);
    return next;
  }

  /** Store a fully-formed event (with its own seq) and the raw CLI JSON it came from. Partial deltas are skipped. */
  append(event: AgentEvent, raw?: unknown): boolean {
    const e = AgentEvent.parse(event);
    if (TRANSIENT.has(e.type)) return false;
    this.d.db
      .prepare('INSERT INTO events (agent_id, seq, type, ts, data, raw) VALUES (?, ?, ?, ?, ?, ?)')
      .run(e.agentId, e.seq, e.type, e.ts, JSON.stringify(e), raw === undefined ? null : JSON.stringify(raw));
    const cached = this.seqCache.get(e.agentId);
    if (cached !== undefined && e.seq >= cached) this.seqCache.set(e.agentId, e.seq + 1);
    return true;
  }

  /** Assign seq and ts, store, and return the event (also returned for transient types, unstored). */
  appendDraft(agentId: string, draft: AgentEventDraft, raw?: unknown, ts = Date.now()): AgentEvent {
    const e = AgentEvent.parse({ ...draft, agentId, seq: TRANSIENT.has(draft.type) ? 0 : this.nextSeq(agentId), ts });
    if (!TRANSIENT.has(e.type)) this.append(e, raw);
    return e;
  }

  /** Store many events in one transaction. */
  appendMany(items: Array<{ event: AgentEvent; raw?: unknown }>): number {
    return this.d.transaction(() => items.reduce((n, it) => n + (this.append(it.event, it.raw) ? 1 : 0), 0));
  }

  /**
   * Paged read, ascending by seq. With `beforeSeq`, returns the `limit` newest events older than it
   * (for scrolling back); with `afterSeq`, the oldest `limit` newer than it (for catching up).
   */
  page(agentId: string, opts: { beforeSeq?: number; afterSeq?: number; limit?: number } = {}): EventPage {
    const limit = Math.max(1, Math.min(opts.limit ?? 500, 5000));
    if (opts.afterSeq !== undefined) {
      const rows = this.d.db.prepare('SELECT * FROM events WHERE agent_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?').all(agentId, opts.afterSeq, limit) as Row[];
      const events = rows.map(parseEvent);
      return { events, hasMore: this.hasBefore(agentId, events[0]?.seq ?? opts.afterSeq + 1) };
    }
    const before = opts.beforeSeq ?? Number.MAX_SAFE_INTEGER;
    const rows = this.d.db.prepare('SELECT * FROM events WHERE agent_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?').all(agentId, before, limit + 1) as Row[];
    const hasMore = rows.length > limit;
    const events = rows.slice(0, limit).reverse().map(parseEvent);
    return { events, hasMore };
  }

  /** Convenience for the `agents.events` IPC command. */
  list(agentId: string, opts: { beforeSeq?: number; afterSeq?: number; limit?: number } = {}): AgentEvent[] {
    return this.page(agentId, opts).events;
  }

  private hasBefore(agentId: string, seq: number): boolean {
    return !!this.d.db.prepare('SELECT 1 FROM events WHERE agent_id = ? AND seq < ? LIMIT 1').get(agentId, seq);
  }

  /** The raw CLI JSON stored with an event, for re-parsing with a newer parser. */
  raw(agentId: string, seq: number): unknown {
    const r = this.d.db.prepare('SELECT raw FROM events WHERE agent_id = ? AND seq = ?').get(agentId, seq) as Row | undefined;
    return r ? fromJson(r.raw) : undefined;
  }

  count(agentId: string): number {
    return num((this.d.db.prepare('SELECT COUNT(*) AS n FROM events WHERE agent_id = ?').get(agentId) as Row).n) ?? 0;
  }

  summaries(agentId: string): EventSummary[] {
    return (this.d.db.prepare('SELECT data FROM event_summaries WHERE agent_id = ? ORDER BY from_seq').all(agentId) as Row[]).map((r) => EventSummary.parse(fromJson(r.data)));
  }

  /**
   * Retention, run at startup. Events older than `days` (default 30):
   *
   * - Agents on the Wall: turned into one summary row per agent (counts by type, tools used, token
   *   totals, last assistant text and result) and deleted, as before.
   * - Archived agents keep a readable transcript (Focus opens them read-only): their old events are
   *   compacted, not deleted. Bookkeeping events nobody reads back (usage, context and plan meters,
   *   background-task counts, stderr, unknown) go into a summary row and are deleted; the rest stay
   *   without their raw CLI JSON, and tool output is cut to TRIMMED_TOOL_OUTPUT characters.
   */
  compactOlderThan(days = 30, now = Date.now()): { agents: number; removed: number; trimmed: number } {
    const cutoff = now - days * DAY;
    return this.d.transaction(() => {
      const agents = (
        this.d.db.prepare('SELECT DISTINCT e.agent_id AS agent_id, a.archived_at AS archived_at FROM events e JOIN agents a ON a.id = e.agent_id WHERE e.ts < ?').all(cutoff) as Row[]
      ).map((r) => ({ id: String(r.agent_id), archived: r.archived_at !== null && r.archived_at !== undefined }));
      let removed = 0;
      let trimmed = 0;
      let touched = 0;
      for (const { id: agentId, archived } of agents) {
        if (archived) {
          const r = this.compactArchived(agentId, cutoff);
          removed += r.removed;
          trimmed += r.trimmed;
          if (r.removed || r.trimmed) touched++;
          continue;
        }
        const rows = this.d.db.prepare('SELECT * FROM events WHERE agent_id = ? AND ts < ? ORDER BY seq ASC').all(agentId, cutoff) as Row[];
        if (!rows.length) continue;
        this.insertSummary(summarize(agentId, rows.map(parseEvent)));
        removed += Number(this.d.db.prepare('DELETE FROM events WHERE agent_id = ? AND ts < ?').run(agentId, cutoff).changes);
        touched++;
      }
      return { agents: touched, removed, trimmed };
    });
  }

  private insertSummary(summary: EventSummary): void {
    this.d.db
      .prepare('INSERT INTO event_summaries (agent_id, from_seq, to_seq, from_ts, to_ts, count, data) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(summary.agentId, summary.fromSeq, summary.toSeq, summary.fromTs, summary.toTs, summary.count, JSON.stringify(summary));
  }

  /** See compactOlderThan. Idempotent: a second run finds nothing left to do. */
  private compactArchived(agentId: string, cutoff: number): { removed: number; trimmed: number } {
    const noiseList = [...ARCHIVE_NOISE].map(() => '?').join(',');
    const noise = this.d.db.prepare(`SELECT * FROM events WHERE agent_id = ? AND ts < ? AND type IN (${noiseList}) ORDER BY seq ASC`).all(agentId, cutoff, ...ARCHIVE_NOISE) as Row[];
    let removed = 0;
    if (noise.length) {
      this.insertSummary(summarize(agentId, noise.map(parseEvent)));
      removed = Number(this.d.db.prepare(`DELETE FROM events WHERE agent_id = ? AND ts < ? AND type IN (${noiseList})`).run(agentId, cutoff, ...ARCHIVE_NOISE).changes);
    }
    const heavy = this.d.db
      .prepare("SELECT seq, type, data FROM events WHERE agent_id = ? AND ts < ? AND (raw IS NOT NULL OR (type = 'tool-result' AND length(data) > ?))")
      .all(agentId, cutoff, TRIMMED_TOOL_OUTPUT + 200) as Row[];
    const update = this.d.db.prepare('UPDATE events SET raw = NULL, data = ? WHERE agent_id = ? AND seq = ?');
    for (const r of heavy) {
      let data = String(r.data);
      if (r.type === 'tool-result') {
        const ev = fromJson<Record<string, unknown>>(data);
        if (ev && typeof ev.content === 'string' && ev.content.length > TRIMMED_TOOL_OUTPUT) {
          data = JSON.stringify({ ...ev, content: `${ev.content.slice(0, TRIMMED_TOOL_OUTPUT)}
… (trimmed after 30 days)` });
        }
      }
      update.run(data, agentId, num(r.seq)!);
    }
    return { removed, trimmed: heavy.length };
  }
}

/** Event types of archived agents that compaction deletes (into a summary row) after the retention period. */
export const ARCHIVE_NOISE: readonly string[] = ['usage', 'context-usage', 'background-tasks', 'plan-usage', 'stderr', 'unknown'];
/** Tool output kept per tool-result event of an archived agent after the retention period. */
export const TRIMMED_TOOL_OUTPUT = 4000;

export function summarize(agentId: string, events: AgentEvent[]): EventSummary {
  const byType: Record<string, number> = {};
  const tools: Record<string, number> = {};
  const usage = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
  let lastAssistantText: string | undefined;
  let lastResult: string | undefined;
  for (const e of events) {
    byType[e.type] = (byType[e.type] ?? 0) + 1;
    if (e.type === 'tool-use') tools[e.name] = (tools[e.name] ?? 0) + 1;
    if (e.type === 'assistant-text') lastAssistantText = e.text.slice(0, 2000);
    if (e.type === 'result' && e.text) lastResult = e.text.slice(0, 2000);
    if (e.type === 'usage') {
      usage.input += e.usage.input;
      usage.output += e.usage.output;
      usage.cacheRead += e.usage.cacheRead;
      usage.cacheCreation += e.usage.cacheCreation;
    }
  }
  const first = events[0]!;
  const last = events[events.length - 1]!;
  return EventSummary.parse({ agentId, fromSeq: first.seq, toSeq: last.seq, fromTs: first.ts, toTs: last.ts, count: events.length, byType, tools, usage, lastAssistantText, lastResult });
}
