import { basename } from 'node:path';
import { Project } from '@oide/protocol';
import type { Database } from '../db.js';
import { newId, num, pathKey, str, type Row } from '../util.js';

function toProject(r: Row): Project {
  return Project.parse({ id: r.id, name: r.name, path: r.path, trusted: num(r.trusted) === 1, createdAt: num(r.created_at) });
}

export class ProjectsRepo {
  constructor(private readonly d: Database) {}

  list(): Project[] {
    return (this.d.db.prepare('SELECT * FROM projects ORDER BY COALESCE(last_opened_at, created_at) DESC').all() as Row[]).map(toProject);
  }

  get(id: string): Project | undefined {
    const r = this.d.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Row | undefined;
    return r ? toProject(r) : undefined;
  }

  byPath(path: string): Project | undefined {
    const r = this.d.db.prepare('SELECT * FROM projects WHERE path_key = ?').get(pathKey(path)) as Row | undefined;
    return r ? toProject(r) : undefined;
  }

  /** Add a project, or return the existing one for the same folder (and mark it opened). */
  open(path: string, opts: { name?: string; trusted?: boolean; now?: number } = {}): Project {
    const now = opts.now ?? Date.now();
    const existing = this.byPath(path);
    if (existing) {
      this.d.db.prepare('UPDATE projects SET last_opened_at = ? WHERE id = ?').run(now, existing.id);
      return existing;
    }
    const id = newId();
    this.d.db
      .prepare('INSERT INTO projects (id, name, path, path_key, trusted, created_at, last_opened_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, opts.name ?? basename(path), path, pathKey(path), opts.trusted ? 1 : 0, now, now);
    return this.get(id)!;
  }

  setTrusted(id: string, trusted: boolean): Project {
    const r = this.d.db.prepare('UPDATE projects SET trusted = ? WHERE id = ?').run(trusted ? 1 : 0, id);
    if (!r.changes) throw new Error(`Unknown project ${id}`);
    return this.get(id)!;
  }

  rename(id: string, name: string): Project {
    this.d.db.prepare('UPDATE projects SET name = ? WHERE id = ?').run(name, id);
    const p = this.get(id);
    if (!p) throw new Error(`Unknown project ${id}`);
    return p;
  }

  /** Removes the project and (cascade) its agents, events and review threads. Files on disk are untouched. */
  remove(id: string): boolean {
    return this.d.db.prepare('DELETE FROM projects WHERE id = ?').run(id).changes > 0;
  }

  lastOpenedAt(id: string): number | undefined {
    const r = this.d.db.prepare('SELECT last_opened_at FROM projects WHERE id = ?').get(id) as Row | undefined;
    return r ? num(r.last_opened_at) : undefined;
  }

  pathOf(id: string): string | undefined {
    const r = this.d.db.prepare('SELECT path FROM projects WHERE id = ?').get(id) as Row | undefined;
    return r ? str(r.path) : undefined;
  }
}
