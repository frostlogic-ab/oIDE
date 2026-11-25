import { z } from 'zod';
import { AgentSpec, AgentStatus, AgentSummary, ArchiveReason, Id, SubagentInfo, repairAgentSummary, type AgentSpecInput } from '@oide/protocol';
import { fromJson, toJson, type Database } from '../db.js';
import { num, opt, type Row } from '../util.js';

/** One row of `agents`: the spec it was spawned with plus where it runs and its latest summary. */
export const AgentRecord = z.object({
  id: Id,
  projectId: Id,
  title: z.string(),
  spec: AgentSpec,
  status: AgentStatus,
  branch: z.string().optional(),
  worktreePath: z.string().optional(),
  baseRef: z.string().optional(),
  sessionId: z.string().optional(),
  attemptGroup: Id.optional(),
  summary: AgentSummary.optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
  endedAt: z.number().optional(),
  /** Set while the agent is in the Archived view (migration 3). */
  archivedAt: z.number().optional(),
  archiveReason: ArchiveReason.optional(),
  mergeCommit: z.string().optional(),
});
export type AgentRecord = z.infer<typeof AgentRecord>;
export type NewAgent = Omit<z.input<typeof AgentRecord>, 'spec' | 'createdAt' | 'updatedAt' | 'title'> & {
  spec: AgentSpecInput;
  title?: string;
  createdAt?: number;
  updatedAt?: number;
};
export type AgentPatch = Partial<Omit<AgentRecord, 'id' | 'projectId' | 'createdAt' | 'spec'>>;

const ENDED: ReadonlySet<AgentStatus> = new Set(['stopped', 'error', 'done']);

/** A row that could not be read (bad spec JSON, a spec from a newer build, …); `list()` skips it. */
export interface SkippedAgentRow {
  id: string;
  error: string;
}

/** A row whose stored summary no longer matched the contract and was repaired on read. */
export interface RepairedAgentRow {
  id: string;
  dropped: string[];
  issues: string[];
}

function toRecord(r: Row, onRepair?: (rep: RepairedAgentRow) => void): AgentRecord {
  let summary: unknown = fromJson(r.summary);
  if (summary !== undefined) {
    const rep = repairAgentSummary(summary);
    if (rep.issues.length) onRepair?.({ id: String(r.id), dropped: rep.dropped, issues: rep.issues });
    // Unrepairable: keep the row (spec and columns) without its summary rather than lose the agent.
    summary = rep.summary;
  }
  return AgentRecord.parse({
    id: r.id,
    projectId: r.project_id,
    title: r.title,
    spec: fromJson(r.spec),
    status: r.status,
    branch: opt(r.branch),
    worktreePath: opt(r.worktree_path),
    baseRef: opt(r.base_ref),
    sessionId: opt(r.session_id),
    attemptGroup: opt(r.attempt_group),
    summary,
    createdAt: num(r.created_at),
    updatedAt: num(r.updated_at),
    endedAt: opt(num(r.ended_at)),
    archivedAt: opt(num(r.archived_at)),
    archiveReason: opt(r.archive_reason),
    mergeCommit: opt(r.merge_commit),
  });
}

const COLS: Record<keyof AgentPatch, string> = {
  title: 'title',
  status: 'status',
  branch: 'branch',
  worktreePath: 'worktree_path',
  baseRef: 'base_ref',
  sessionId: 'session_id',
  attemptGroup: 'attempt_group',
  summary: 'summary',
  updatedAt: 'updated_at',
  endedAt: 'ended_at',
  archivedAt: 'archived_at',
  archiveReason: 'archive_reason',
  mergeCommit: 'merge_commit',
};

/** Escape `%`, `_` and `!` for a LIKE pattern with ESCAPE '!'. */
function likeEscape(s: string): string {
  return s.replace(/[!%_]/g, (c) => `!${c}`);
}

export interface ArchivedPage {
  records: AgentRecord[];
  /** Matching archived agents in all pages. */
  total: number;
  nextCursor?: { at: number; id: string };
}

export class AgentsRepo {
  /** Rows the last `list()` / `listArchived()` could not read, and summaries it had to repair. */
  skipped: SkippedAgentRow[] = [];
  repaired: RepairedAgentRow[] = [];

  constructor(private readonly d: Database) {}

  /** Read rows one by one: one unreadable agent must never hide the others (2026-11-25). */
  private readRows(rows: Row[]): AgentRecord[] {
    this.skipped = [];
    this.repaired = [];
    const out: AgentRecord[] = [];
    for (const r of rows) {
      try {
        out.push(toRecord(r, (rep) => this.repaired.push(rep)));
      } catch (err) {
        this.skipped.push({ id: String(r.id), error: err instanceof z.ZodError ? err.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') : (err as Error).message });
      }
    }
    return out;
  }

  insert(input: NewAgent): AgentRecord {
    const now = Date.now();
    const spec = AgentSpec.parse(input.spec);
    const rec = AgentRecord.parse({ ...input, spec, title: input.title ?? spec.title, attemptGroup: input.attemptGroup ?? spec.attemptGroup, createdAt: input.createdAt ?? now, updatedAt: input.updatedAt ?? now });
    this.d.db
      .prepare(
        `INSERT INTO agents (id, project_id, title, spec, status, branch, worktree_path, base_ref, session_id, attempt_group, summary, created_at, updated_at, ended_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        rec.id,
        rec.projectId,
        rec.title,
        JSON.stringify(rec.spec),
        rec.status,
        rec.branch ?? null,
        rec.worktreePath ?? null,
        rec.baseRef ?? null,
        rec.sessionId ?? null,
        rec.attemptGroup ?? null,
        toJson(rec.summary),
        rec.createdAt,
        rec.updatedAt,
        rec.endedAt ?? null,
      );
    return rec;
  }

  get(id: string): AgentRecord | undefined {
    const r = this.d.db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as Row | undefined;
    if (!r) return undefined;
    try {
      return toRecord(r);
    } catch {
      return undefined;
    }
  }

  /** `archived`: true = only archived agents, false = only those on the Wall, unset = both. */
  list(filter: { projectId?: string; statuses?: AgentStatus[]; attemptGroup?: string; archived?: boolean } = {}): AgentRecord[] {
    const where: string[] = [];
    const args: Array<string | number> = [];
    if (filter.archived !== undefined) where.push(filter.archived ? 'archived_at IS NOT NULL' : 'archived_at IS NULL');
    if (filter.projectId) {
      where.push('project_id = ?');
      args.push(filter.projectId);
    }
    if (filter.attemptGroup) {
      where.push('attempt_group = ?');
      args.push(filter.attemptGroup);
    }
    if (filter.statuses?.length) {
      where.push(`status IN (${filter.statuses.map(() => '?').join(',')})`);
      args.push(...filter.statuses);
    }
    const sql = `SELECT * FROM agents ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at ASC`;
    return this.readRows(this.d.db.prepare(sql).all(...args) as Row[]);
  }

  /**
   * Archived agents, most recently archived first. `query` matches the title (case-insensitive for
   * ASCII); `cursor` is the last item of the previous page.
   */
  listArchived(opts: { projectId?: string; query?: string; limit?: number; cursor?: { at: number; id: string } } = {}): ArchivedPage {
    const where = ['archived_at IS NOT NULL'];
    const args: Array<string | number> = [];
    if (opts.projectId) {
      where.push('project_id = ?');
      args.push(opts.projectId);
    }
    const q = opts.query?.trim();
    if (q) {
      where.push("title LIKE ? ESCAPE '!'");
      args.push(`%${likeEscape(q)}%`);
    }
    const total = num((this.d.db.prepare(`SELECT COUNT(*) AS n FROM agents WHERE ${where.join(' AND ')}`).get(...args) as Row).n) ?? 0;
    const pageWhere = [...where];
    const pageArgs = [...args];
    if (opts.cursor) {
      pageWhere.push('(archived_at < ? OR (archived_at = ? AND id < ?))');
      pageArgs.push(opts.cursor.at, opts.cursor.at, opts.cursor.id);
    }
    const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
    const rows = this.d.db.prepare(`SELECT * FROM agents WHERE ${pageWhere.join(' AND ')} ORDER BY archived_at DESC, id DESC LIMIT ?`).all(...pageArgs, limit + 1) as Row[];
    const records = this.readRows(rows.slice(0, limit));
    const last = rows.length > limit ? rows[limit - 1] : undefined;
    return { records, total, ...(last ? { nextCursor: { at: num(last.archived_at)!, id: String(last.id) } } : {}) };
  }

  /** Worktree folders still held by archived agents of a project (not orphans: they can be unarchived). */
  archivedWorktrees(projectId: string): string[] {
    const rows = this.d.db.prepare('SELECT worktree_path FROM agents WHERE project_id = ? AND archived_at IS NOT NULL AND worktree_path IS NOT NULL').all(projectId) as Row[];
    return rows.map((r) => String(r.worktree_path));
  }

  update(id: string, patch: AgentPatch): AgentRecord {
    const p: AgentPatch = { ...patch, updatedAt: patch.updatedAt ?? Date.now() };
    if (p.status && ENDED.has(p.status) && p.endedAt === undefined) p.endedAt = p.updatedAt;
    const sets: string[] = [];
    const args: Array<string | number | null> = [];
    for (const [k, v] of Object.entries(p) as Array<[keyof AgentPatch, unknown]>) {
      const col = COLS[k];
      if (!col) continue;
      sets.push(`${col} = ?`);
      if (k === 'summary') args.push(v === undefined ? null : JSON.stringify(AgentSummary.parse(v)));
      else args.push(v === undefined ? null : (v as string | number));
    }
    if (!sets.length) return this.get(id)!;
    const r = this.d.db.prepare(`UPDATE agents SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);
    if (!r.changes) throw new Error(`Unknown agent ${id}`);
    return this.get(id)!;
  }

  /** Replace the stored spec (it changed while the agent ran, e.g. it named its task); mirrors the title column. */
  saveSpec(id: string, spec: AgentSpecInput): AgentRecord {
    const { attachments: _, ...s } = AgentSpec.parse(spec);
    const r = this.d.db.prepare('UPDATE agents SET spec = ?, title = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(s), s.title, Date.now(), id);
    if (!r.changes) throw new Error(`Unknown agent ${id}`);
    return this.get(id)!;
  }

  /** Persist the reduced tile state; also mirrors status, session, branch and worktree into columns. */
  saveSummary(summary: z.input<typeof AgentSummary>): AgentRecord {
    const s = AgentSummary.parse(summary);
    // The archive columns follow the summary: set while archived, cleared (NULL) once it is back on the Wall.
    const patch: AgentPatch = { summary: s, status: s.status, updatedAt: s.updatedAt, archivedAt: s.archived?.at, archiveReason: s.archived?.reason, mergeCommit: s.archived?.mergeCommit };
    // Only overwrite columns the summary knows about.
    if (s.title) patch.title = s.title;
    if (s.sessionId !== undefined) patch.sessionId = s.sessionId;
    if (s.branch !== undefined) patch.branch = s.branch;
    if (s.worktreePath !== undefined) patch.worktreePath = s.worktreePath;
    if (s.baseRef !== undefined) patch.baseRef = s.baseRef;
    return this.update(s.id, patch);
  }

  summaries(projectId?: string): AgentSummary[] {
    return this.list({ projectId }).flatMap((a) => (a.summary ? [a.summary] : []));
  }

  remove(id: string): boolean {
    return this.d.db.prepare('DELETE FROM agents WHERE id = ?').run(id).changes > 0;
  }
}

export class SubagentsRepo {
  constructor(private readonly d: Database) {}

  upsert(info: SubagentInfo): SubagentInfo {
    const s = SubagentInfo.parse(info);
    this.d.db
      .prepare(
        `INSERT INTO subagents (agent_id, id, status, tier, model, started_at, ended_at, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (agent_id, id) DO UPDATE SET status = excluded.status, tier = excluded.tier, model = excluded.model,
           started_at = excluded.started_at, ended_at = excluded.ended_at, data = excluded.data`,
      )
      .run(s.agentId, s.id, s.status, s.tier ?? null, s.model ?? null, s.startedAt ?? null, s.endedAt ?? null, JSON.stringify(s));
    return s;
  }

  list(agentId: string): SubagentInfo[] {
    return (this.d.db.prepare('SELECT data FROM subagents WHERE agent_id = ? ORDER BY COALESCE(started_at, 0), id').all(agentId) as Row[]).map((r) => SubagentInfo.parse(fromJson(r.data)));
  }

  get(agentId: string, id: string): SubagentInfo | undefined {
    const r = this.d.db.prepare('SELECT data FROM subagents WHERE agent_id = ? AND id = ?').get(agentId, id) as Row | undefined;
    return r ? SubagentInfo.parse(fromJson(r.data)) : undefined;
  }

  /** Subagents currently running across all agents (status bar). */
  activeCount(): number {
    const r = this.d.db.prepare("SELECT COUNT(*) AS n FROM subagents WHERE status IN ('running', 'needs-permission')").get() as Row;
    return num(r.n) ?? 0;
  }
}
