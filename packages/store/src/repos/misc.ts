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

  /** Per-subagent token share of one agent (Subagents tab). */
  bySubagent(agentId: string): Array<{ subagentId: string | undefined; total: number }> {
    return (this.d.db
      .prepare('SELECT subagent_id, SUM(input + output + cache_read + cache_creation) AS t FROM usage_samples WHERE agent_id = ? GROUP BY subagent_id ORDER BY t DESC')
      .all(agentId) as Row[]).map((r) => ({ subagentId: opt(r.subagent_id as string | null), total: num(r.t) ?? 0 }));
  }

  deleteOlderThan(ts: number): number {
    return Number(this.d.db.prepare('DELETE FROM usage_samples WHERE ts < ?').run(ts).changes);
  }
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
