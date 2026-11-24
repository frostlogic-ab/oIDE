import { z } from 'zod';
import { AgentSpec, AgentStatus, AgentSummary, Id, SubagentInfo, type AgentSpecInput } from '@oide/protocol';
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

function toRecord(r: Row): AgentRecord {
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
    summary: fromJson(r.summary),
    createdAt: num(r.created_at),
    updatedAt: num(r.updated_at),
    endedAt: opt(num(r.ended_at)),
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
};

export class AgentsRepo {
  constructor(private readonly d: Database) {}

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
    return r ? toRecord(r) : undefined;
  }

  list(filter: { projectId?: string; statuses?: AgentStatus[]; attemptGroup?: string } = {}): AgentRecord[] {
    const where: string[] = [];
    const args: Array<string | number> = [];
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
    return (this.d.db.prepare(sql).all(...args) as Row[]).map(toRecord);
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

  /** Persist the reduced tile state; also mirrors status, session, branch and worktree into columns. */
  saveSummary(summary: z.input<typeof AgentSummary>): AgentRecord {
    const s = AgentSummary.parse(summary);
    const patch: AgentPatch = { summary: s, status: s.status, updatedAt: s.updatedAt };
    // Only overwrite columns the summary knows about.
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
