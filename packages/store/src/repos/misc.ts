import { z } from 'zod';
import { CustomServer, InstalledExtension, ReviewComment, Scope, TokenUsage } from '@oide/protocol';
import { fromJson, type Database } from '../db.js';
import { newId, num, opt, type Row } from '../util.js';

/* ------------------------------------------------------------------ usage */

export const UsageSample = z.object({
  agentId: z.string().optional(),
  subagentId: z.string().optional(),
  ts: z.number(),
  model: z.string().optional(),
  usage: TokenUsage,
});
export type UsageSample = z.infer<typeof UsageSample>;

export class UsageRepo {
  constructor(private readonly d: Database) {}

  add(sample: z.input<typeof UsageSample>): void {
    const s = UsageSample.parse(sample);
    this.d.db
      .prepare('INSERT INTO usage_samples (agent_id, subagent_id, ts, model, input, output, cache_read, cache_creation) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(s.agentId ?? null, s.subagentId ?? null, s.ts, s.model ?? null, s.usage.input, s.usage.output, s.usage.cacheRead, s.usage.cacheCreation);
  }

  /** Token totals since `ts` (e.g. start of today for the status bar), optionally for one agent. */
  totals(opts: { since?: number; agentId?: string } = {}): TokenUsage & { total: number } {
    const where: string[] = ['ts >= ?'];
    const args: Array<string | number> = [opts.since ?? 0];
    if (opts.agentId) {
      where.push('agent_id = ?');
      args.push(opts.agentId);
    }
    const r = this.d.db
      .prepare(`SELECT COALESCE(SUM(input),0) AS i, COALESCE(SUM(output),0) AS o, COALESCE(SUM(cache_read),0) AS cr, COALESCE(SUM(cache_creation),0) AS cc FROM usage_samples WHERE ${where.join(' AND ')}`)
      .get(...args) as Row;
    const u = { input: num(r.i) ?? 0, output: num(r.o) ?? 0, cacheRead: num(r.cr) ?? 0, cacheCreation: num(r.cc) ?? 0 };
    return { ...u, total: u.input + u.output + u.cacheRead + u.cacheCreation };
  }

  /**
   * Token totals since `ts` per Claude Code account (ADR 0021): the agent's `spec.accountId`, or
   * `default` for agents without one and samples without an agent.
   */
  totalsByAccount(since: number): Map<string, number> {
    const rows = this.d.db
      .prepare(
        `SELECT COALESCE(json_extract(a.spec, '$.accountId'), 'default') AS acc, COALESCE(SUM(u.input + u.output + u.cache_read + u.cache_creation), 0) AS t
         FROM usage_samples u LEFT JOIN agents a ON a.id = u.agent_id WHERE u.ts >= ? GROUP BY acc`,
      )
      .all(since) as Row[];
    return new Map(rows.map((r) => [String(r.acc), num(r.t) ?? 0]));
  }

  /** Per-subagent token share of one agent (Subagents tab). */
  bySubagent(agentId: string): Array<{ subagentId: string | undefined; total: number }> {
    return (this.d.db
      .prepare('SELECT subagent_id, SUM(input + output + cache_read + cache_creation) AS t FROM usage_samples WHERE agent_id = ? GROUP BY subagent_id ORDER BY t DESC')
      .all(agentId) as Row[]).map((r) => ({ subagentId: opt(r.subagent_id as string | null), total: num(r.t) ?? 0 }));
  }

  deleteOlderThan(ts: number): number {
    return Number(this.d.db.prepare('DELETE FROM usage_samples WHERE ts < ?').run(ts).changes);
  }

  /**
   * Retention without losing history: samples older than `ts` are summed into `usage_daily` (one
   * row per local day, project and model; `offsetMs` is the local UTC offset) and then deleted, in
   * one transaction. Returns the number of samples removed.
   */
  compactOlderThan(ts: number, offsetMs = localOffsetMs()): number {
    return this.d.transaction(() => {
      this.d.db
        .prepare(
          `INSERT INTO usage_daily (day, project_id, model, input, output, cache_read, cache_creation)
           SELECT CAST((u.ts + ?) / ${DAY_MS} AS INTEGER) AS d, COALESCE(a.project_id, ''), COALESCE(u.model, ''),
                  SUM(u.input), SUM(u.output), SUM(u.cache_read), SUM(u.cache_creation)
           FROM usage_samples u LEFT JOIN agents a ON a.id = u.agent_id
           WHERE u.ts < ?
           GROUP BY d, COALESCE(a.project_id, ''), COALESCE(u.model, '')
           ON CONFLICT (day, project_id, model) DO UPDATE SET
             input = input + excluded.input, output = output + excluded.output,
             cache_read = cache_read + excluded.cache_read, cache_creation = cache_creation + excluded.cache_creation`,
        )
        .run(offsetMs, ts);
      return this.deleteOlderThan(ts);
    });
  }

  /**
   * Token use per local day (days since 1970-01-01 at `offsetMs`), project and model from `sinceDay`
   * on: live samples plus the `usage_daily` rollup of older ones (each sample is in exactly one).
   */
  daily(opts: { sinceDay: number; offsetMs?: number }): UsageDay[] {
    const off = opts.offsetMs ?? localOffsetMs();
    const sinceTs = opts.sinceDay * DAY_MS - off;
    const rows = this.d.db
      .prepare(
        `SELECT d, p, m, SUM(i) AS i, SUM(o) AS o, SUM(cr) AS cr, SUM(cc) AS cc FROM (
           SELECT CAST((u.ts + ?) / ${DAY_MS} AS INTEGER) AS d, COALESCE(a.project_id, '') AS p, COALESCE(u.model, '') AS m,
                  u.input AS i, u.output AS o, u.cache_read AS cr, u.cache_creation AS cc
           FROM usage_samples u LEFT JOIN agents a ON a.id = u.agent_id WHERE u.ts >= ?
           UNION ALL
           SELECT day, project_id, model, input, output, cache_read, cache_creation FROM usage_daily WHERE day >= ?
         ) GROUP BY d, p, m ORDER BY d, p, m`,
      )
      .all(off, sinceTs, opts.sinceDay) as Row[];
    return rows.map((r) => ({
      day: num(r.d) ?? 0,
      ...(r.p ? { projectId: String(r.p) } : {}),
      ...(r.m ? { model: String(r.m) } : {}),
      usage: { input: num(r.i) ?? 0, output: num(r.o) ?? 0, cacheRead: num(r.cr) ?? 0, cacheCreation: num(r.cc) ?? 0 },
    }));
  }
}

const DAY_MS = 86_400_000;

/** The local UTC offset in ms (east positive), as `daily` and `compactOlderThan` bucket days. */
export function localOffsetMs(at = Date.now()): number {
  return -new Date(at).getTimezoneOffset() * 60_000;
}

/** Tokens of one local day, project and model (`UsageRepo.daily`). */
export interface UsageDay {
  day: number;
  projectId?: string;
  model?: string;
  usage: TokenUsage;
}

/* ----------------------------------------------------------------- review */

function toComment(r: Row): ReviewComment {
  return ReviewComment.parse({ id: r.id, agentId: r.agent_id, path: r.path, line: opt(num(r.line)), side: r.side === 'old' ? 'old' : 'new', body: r.body, sent: num(r.sent) === 1, createdAt: num(r.created_at) });
}

export class ReviewRepo {
  constructor(private readonly d: Database) {}

  comments(agentId: string): ReviewComment[] {
    return (this.d.db.prepare('SELECT * FROM review_comments WHERE agent_id = ? ORDER BY created_at, rowid').all(agentId) as Row[]).map(toComment);
  }

  /** `side: 'old'` for a comment on a removed line (its `line` is the old-side number). */
  addComment(input: { agentId: string; path: string; line?: number; side?: 'old' | 'new'; body: string }, now = Date.now()): ReviewComment {
    const c = ReviewComment.parse({ id: newId(), ...input, sent: false, createdAt: now });
    this.d.db
      .prepare('INSERT INTO review_comments (id, agent_id, path, line, side, body, sent, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)')
      .run(c.id, c.agentId, c.path, c.line ?? null, c.side, c.body, c.createdAt);
    return c;
  }

  deleteComment(id: string): boolean {
    return this.d.db.prepare('DELETE FROM review_comments WHERE id = ?').run(id).changes > 0;
  }

  /** Unsent comments, marked sent in the same transaction (what "Send feedback" bundles). */
  takeUnsent(agentId: string): ReviewComment[] {
    return this.d.transaction(() => {
      const list = this.comments(agentId).filter((c) => !c.sent);
      this.d.db.prepare('UPDATE review_comments SET sent = 1 WHERE agent_id = ? AND sent = 0').run(agentId);
      return list;
    });
  }

  viewed(agentId: string): string[] {
    return (this.d.db.prepare('SELECT path FROM review_viewed WHERE agent_id = ? ORDER BY path').all(agentId) as Row[]).map((r) => String(r.path));
  }

  setViewed(agentId: string, path: string, viewed: boolean, now = Date.now()): void {
    if (viewed) this.d.db.prepare('INSERT INTO review_viewed (agent_id, path, viewed_at) VALUES (?, ?, ?) ON CONFLICT DO UPDATE SET viewed_at = excluded.viewed_at').run(agentId, path, now);
    else this.d.db.prepare('DELETE FROM review_viewed WHERE agent_id = ? AND path = ?').run(agentId, path);
  }
}

/* -------------------------------------------------------- key/value docs */

/** Small JSON documents keyed by name (`settings`, `ui_state`). */
export class KvRepo {
  constructor(
    private readonly d: Database,
    private readonly table: 'settings' | 'ui_state',
  ) {}

  get<T = unknown>(key: string, schema?: z.ZodType<T>): T | undefined {
    const r = this.d.db.prepare(`SELECT data FROM ${this.table} WHERE key = ?`).get(key) as Row | undefined;
    if (!r) return undefined;
    const v = fromJson(r.data);
    if (!schema) return v as T;
    const p = schema.safeParse(v);
    return p.success ? p.data : undefined;
  }

  set(key: string, value: unknown, now = Date.now()): void {
    this.d.db.prepare(`INSERT INTO ${this.table} (key, data, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`).run(key, JSON.stringify(value), now);
  }

  delete(key: string): boolean {
    return this.d.db.prepare(`DELETE FROM ${this.table} WHERE key = ?`).run(key).changes > 0;
  }

  keys(): string[] {
    return (this.d.db.prepare(`SELECT key FROM ${this.table} ORDER BY key`).all() as Row[]).map((r) => String(r.key));
  }
}

/** UI state: the project scope per window, plus any small renderer preferences. */
export class UiStateRepo {
  readonly kv: KvRepo;
  constructor(d: Database) {
    this.kv = new KvRepo(d, 'ui_state');
  }

  scope(windowKey = 'main'): Scope {
    return this.kv.get(`scope:${windowKey}`, Scope) ?? 'all';
  }

  setScope(scope: Scope, windowKey = 'main'): Scope {
    const s = Scope.parse(scope);
    this.kv.set(`scope:${windowKey}`, s);
    return s;
  }
}

/* --------------------------------------------- extensions & custom servers */

class JsonDocRepo<S extends z.ZodType<{ id: string; name: string }>> {
  constructor(
    protected readonly d: Database,
    private readonly table: 'extensions' | 'custom_servers',
    private readonly schema: S,
  ) {}

  list(): Array<z.output<S>> {
    return (this.d.db.prepare(`SELECT data FROM ${this.table} ORDER BY name`).all() as Row[]).map((r) => this.schema.parse(fromJson(r.data)));
  }

  get(id: string): z.output<S> | undefined {
    const r = this.d.db.prepare(`SELECT data FROM ${this.table} WHERE id = ?`).get(id) as Row | undefined;
    return r ? this.schema.parse(fromJson(r.data)) : undefined;
  }

  byName(name: string): z.output<S> | undefined {
    const r = this.d.db.prepare(`SELECT data FROM ${this.table} WHERE name = ?`).get(name) as Row | undefined;
    return r ? this.schema.parse(fromJson(r.data)) : undefined;
  }

  upsert(value: z.input<S>, now = Date.now()): z.output<S> {
    const v = this.schema.parse(value);
    this.d.db
      .prepare(`INSERT INTO ${this.table} (id, name, data, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET name = excluded.name, data = excluded.data, updated_at = excluded.updated_at`)
      .run(v.id, v.name, JSON.stringify(v), now);
    return v;
  }

  remove(id: string): boolean {
    return this.d.db.prepare(`DELETE FROM ${this.table} WHERE id = ?`).run(id).changes > 0;
  }
}

export class ExtensionsRepo extends JsonDocRepo<typeof InstalledExtension> {
  constructor(d: Database) {
    super(d, 'extensions', InstalledExtension);
  }
}

/** Custom MCP servers saved to "My settings". (Project `.mcp.json` ones live in the repo.) */
export class CustomServersRepo extends JsonDocRepo<typeof CustomServer> {
  constructor(d: Database) {
    super(d, 'custom_servers', CustomServer);
  }
}
