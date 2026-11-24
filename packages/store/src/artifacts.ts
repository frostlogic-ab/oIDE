import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import {
  ArtifactMeta,
  ArtifactUse,
  ArtifactVersion,
  type ArtifactContent,
  type ArtifactKind,
  type ArtifactsBackend,
} from '@oide/protocol';
import { z } from 'zod';
import { fromJson, type Database } from './db.js';
import { newId, num, pathKey, type Row } from './util.js';

/**
 * Local artifacts (v1 has no claude.ai sync). Each artifact is a folder:
 *
 *   <repo>/.oide/artifacts/<slug>/     shared with the team through git (location "repo")
 *   <app-data>/artifacts/<slug>/       personal (location "app-data")
 *     artifact.json                    ArtifactMeta
 *     index.html | doc.md | board.excalidraw   the entry file
 *     .versions/versions.json          ArtifactVersion[]
 *     .versions/<n>/<entry>            snapshot of each version
 *
 * Numbered snapshots are used for both locations (ADR 0004). SQLite keeps an index (for fast
 * listing and the uses log); the folder is the source of truth for content and meta.
 */

export const ENTRY_FILES: Record<ArtifactKind, string> = { design: 'index.html', doc: 'doc.md', whiteboard: 'board.excalidraw' };
const MAX_IMPORT_BYTES = 10 * 1024 * 1024;
const VERSIONS_DIR = '.versions';
const ALLOWED_IMPORT_HOSTS = [/^(.+\.)?claude\.ai$/i, /^(.+\.)?claude\.site$/i];

export interface ArtifactStoreOptions {
  db: Database;
  /** Electron `userData`; personal artifacts go to `<appDataDir>/artifacts/`. */
  appDataDir: string;
  /** Main checkout of a project, for repo artifacts. */
  projectPath: (projectId: string) => string | undefined;
  now?: () => number;
  /** Called after any change (main forwards it as the `artifacts.changed` event). */
  onChange?: (id?: string) => void;
}

export interface CreateArtifactInput {
  title: string;
  kind: ArtifactKind;
  projectId?: string;
  location?: 'repo' | 'app-data';
  content?: string;
  /** Set by importUrl: the claude.ai link this came from. */
  importedFrom?: string;
}

export interface ArtifactDetail extends ArtifactContent {
  uses: ArtifactUse[];
  versions: ArtifactVersion[];
}

export function slugifyTitle(title: string): string {
  const s = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return s || 'artifact';
}

export function inferKind(fileName: string, content?: string): ArtifactKind | undefined {
  const ext = extname(fileName).toLowerCase();
  if (ext === '.html' || ext === '.htm') return 'design';
  if (ext === '.md' || ext === '.markdown' || ext === '.txt') return 'doc';
  if (ext === '.excalidraw') return 'whiteboard';
  if (ext === '.json' && content) {
    try {
      if ((JSON.parse(content) as { type?: unknown }).type === 'excalidraw') return 'whiteboard';
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function defaultContent(kind: ArtifactKind, title: string): string {
  switch (kind) {
    case 'design':
      return `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>${escapeHtml(title)}</title>\n</head>\n<body>\n</body>\n</html>\n`;
    case 'doc':
      return '';
    case 'whiteboard':
      return JSON.stringify({ type: 'excalidraw', version: 2, source: 'oide', elements: [], appState: {}, files: {} }, null, 2) + '\n';
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Docs are Markdown with front matter; add it when the content has none. */
function withFrontMatter(content: string, meta: { title: string; importedFrom?: string }): string {
  if (/^---\r?\n/.test(content)) return content;
  const lines = ['---', `title: ${JSON.stringify(meta.title)}`, 'kind: doc'];
  if (meta.importedFrom) lines.push(`importedFrom: ${JSON.stringify(meta.importedFrom)}`);
  lines.push('---', '');
  return lines.join('\n') + '\n' + content;
}

function validateContent(kind: ArtifactKind, content: string): void {
  if (kind === 'whiteboard') {
    let v: unknown;
    try {
      v = JSON.parse(content);
    } catch (e) {
      throw new Error(`Whiteboard content must be Excalidraw JSON: ${(e as Error).message}`);
    }
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('Whiteboard content must be an Excalidraw JSON object.');
  }
}

async function writeAtomic(path: string, content: string): Promise<void> {
  const tmp = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(tmp, content, 'utf8');
  await rename(tmp, path);
}

const VersionsFile = z.array(ArtifactVersion);

export class ArtifactStore {
  private readonly d: Database;
  private readonly appDataDir: string;
  private readonly projectPath: (projectId: string) => string | undefined;
  private readonly now: () => number;
  private readonly onChange: ((id?: string) => void) | undefined;
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(opts: ArtifactStoreOptions) {
    this.d = opts.db;
    this.appDataDir = opts.appDataDir;
    this.projectPath = opts.projectPath;
    this.now = opts.now ?? Date.now;
    this.onChange = opts.onChange;
  }

  /* ---------------------------------------------------------- locations */

  /** Folder holding artifacts for a location (`<repo>/.oide/artifacts` or `<app-data>/artifacts`). */
  root(location: 'repo' | 'app-data', projectId?: string): string {
    if (location === 'app-data') return join(this.appDataDir, 'artifacts');
    if (!projectId) throw new Error('Repo artifacts need a project.');
    const repo = this.projectPath(projectId);
    if (!repo) throw new Error(`Unknown project ${projectId}`);
    return join(repo, '.oide', 'artifacts');
  }

  /** Absolute folder of an artifact (for preview and path checks). */
  dirOf(id: string): string {
    const r = this.d.db.prepare('SELECT dir FROM artifacts WHERE id = ?').get(id) as Row | undefined;
    if (!r) throw new Error(`Unknown artifact ${id}`);
    return String(r.dir);
  }

  /* -------------------------------------------------------------- index */

  private index(meta: ArtifactMeta, dir: string): void {
    const projectId = meta.projectId && this.projectExists(meta.projectId) ? meta.projectId : null;
    this.d.db
      .prepare(
        `INSERT INTO artifacts (id, slug, title, kind, project_id, location, dir, dir_key, version, meta, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET slug = excluded.slug, title = excluded.title, kind = excluded.kind, project_id = excluded.project_id,
           location = excluded.location, dir = excluded.dir, dir_key = excluded.dir_key, version = excluded.version, meta = excluded.meta, updated_at = excluded.updated_at`,
      )
      .run(meta.id, meta.slug, meta.title, meta.kind, projectId, meta.location, dir, pathKey(dir), meta.version, JSON.stringify(meta), meta.updatedAt);
  }

  private projectExists(id: string): boolean {
    return !!this.d.db.prepare('SELECT 1 FROM projects WHERE id = ?').get(id);
  }

  private metaFromIndex(id: string): ArtifactMeta {
    const r = this.d.db.prepare('SELECT meta FROM artifacts WHERE id = ?').get(id) as Row | undefined;
    if (!r) throw new Error(`Unknown artifact ${id}`);
    return ArtifactMeta.parse(fromJson(r.meta));
  }

  /** Re-index artifacts found on disk: app-data plus each project's `.oide/artifacts/` (teammates commit them). */
  async rescan(projects: Array<{ id: string; path: string }> = []): Promise<number> {
    let found = 0;
    const scan = async (root: string, location: 'repo' | 'app-data', projectId?: string) => {
      let names: string[];
      try {
        names = (await readdir(root, { withFileTypes: true })).filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name);
      } catch {
        return;
      }
      for (const name of names) {
        const dir = join(root, name);
        try {
          const parsed = ArtifactMeta.safeParse(JSON.parse(await readFile(join(dir, 'artifact.json'), 'utf8')));
          if (!parsed.success) continue;
          const meta: ArtifactMeta = { ...parsed.data, slug: name, location, projectId: location === 'repo' ? projectId : parsed.data.projectId };
          const clash = this.d.db.prepare('SELECT id FROM artifacts WHERE dir_key = ? AND id != ?').get(pathKey(dir), meta.id) as Row | undefined;
          if (clash) this.d.db.prepare('DELETE FROM artifacts WHERE id = ?').run(String(clash.id));
          this.index(meta, dir);
          found++;
        } catch {
          // Not an artifact folder.
        }
      }
    };
    await scan(this.root('app-data'), 'app-data');
    for (const p of projects) await scan(join(p.path, '.oide', 'artifacts'), 'repo', p.id);
    // Drop index rows whose folder is gone.
    for (const r of this.d.db.prepare('SELECT id, dir FROM artifacts').all() as Row[]) {
      if (!existsSync(join(String(r.dir), 'artifact.json'))) this.d.db.prepare('DELETE FROM artifacts WHERE id = ?').run(String(r.id));
    }
    this.onChange?.();
    return found;
  }

  /* --------------------------------------------------------------- read */

  async list(filter: { projectId?: string; kind?: ArtifactKind } = {}, agentId?: string): Promise<ArtifactMeta[]> {
    void agentId; // listing is not attributed to an artifact
    const where: string[] = [];
    const args: string[] = [];
    if (filter.projectId) {
      where.push('project_id = ?');
      args.push(filter.projectId);
    }
    if (filter.kind) {
      where.push('kind = ?');
      args.push(filter.kind);
    }
    const rows = this.d.db.prepare(`SELECT meta FROM artifacts ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY updated_at DESC`).all(...args) as Row[];
    return rows.map((r) => ArtifactMeta.parse(fromJson(r.meta)));
  }

  async read(id: string, agentId?: string): Promise<ArtifactContent> {
    const meta = this.metaFromIndex(id);
    const content = await readFile(join(this.dirOf(id), meta.entry), 'utf8');
    if (agentId) this.recordUse(id, agentId, 'read');
    return { meta, content };
  }

  async get(id: string): Promise<ArtifactDetail> {
    const { meta, content } = await this.read(id);
    return { meta, content, uses: this.uses(id), versions: await this.versions(id) };
  }

  async versions(id: string): Promise<ArtifactVersion[]> {
    try {
      const raw = JSON.parse(await readFile(join(this.dirOf(id), VERSIONS_DIR, 'versions.json'), 'utf8'));
      const r = VersionsFile.safeParse(raw);
      return r.success ? [...r.data].sort((a, b) => b.version - a.version) : [];
    } catch {
      return [];
    }
  }

  /** Content of an older version (History). */
  async readVersion(id: string, version: number): Promise<string> {
    const meta = this.metaFromIndex(id);
    if (!Number.isInteger(version) || version < 1) throw new Error('Bad version');
    return readFile(join(this.dirOf(id), VERSIONS_DIR, String(version), meta.entry), 'utf8');
  }

  /* -------------------------------------------------------------- write */

  async create(input: CreateArtifactInput, author = 'user'): Promise<ArtifactMeta> {
    const location = input.location ?? 'app-data';
    const title = input.title.trim() || 'Untitled';
    const root = this.root(location, input.projectId);
    await mkdir(root, { recursive: true });
    const base = slugifyTitle(title);
    let slug = base;
    for (let n = 2; existsSync(join(root, slug)); n++) slug = `${base}-${n}`;
    const dir = join(root, slug);
    await mkdir(join(dir, VERSIONS_DIR, '1'), { recursive: true });
    const ts = this.now();
    const meta = ArtifactMeta.parse({
      id: newId(),
      slug,
      title,
      kind: input.kind,
      projectId: input.projectId,
      location,
      version: 1,
      entry: ENTRY_FILES[input.kind],
      createdAt: ts,
      updatedAt: ts,
      importedFrom: input.importedFrom,
    });
    let content = input.content ?? defaultContent(input.kind, title);
    if (input.kind === 'doc') content = withFrontMatter(content, { title, importedFrom: meta.importedFrom });
    validateContent(input.kind, content);
    await writeAtomic(join(dir, meta.entry), content);
    await writeFile(join(dir, VERSIONS_DIR, '1', meta.entry), content, 'utf8');
    await writeAtomic(join(dir, VERSIONS_DIR, 'versions.json'), JSON.stringify([{ version: 1, ts, author, note: 'Created' }], null, 2) + '\n');
    await writeAtomic(join(dir, 'artifact.json'), JSON.stringify(meta, null, 2) + '\n');
    this.index(meta, dir);
    this.onChange?.(meta.id);
    return meta;
  }

  /** Save new content as the next numbered version. */
  async save(id: string, content: string, opts: { author?: string; note?: string } = {}): Promise<ArtifactMeta> {
    return this.withLock(id, async () => {
      const cur = this.metaFromIndex(id);
      validateContent(cur.kind, content);
      const dir = this.dirOf(id);
      const ts = this.now();
      const version = cur.version + 1;
      const meta = ArtifactMeta.parse({ ...cur, version, updatedAt: ts });
      await mkdir(join(dir, VERSIONS_DIR, String(version)), { recursive: true });
      await writeFile(join(dir, VERSIONS_DIR, String(version), meta.entry), content, 'utf8');
      await writeAtomic(join(dir, meta.entry), content);
      const versions = await this.versions(id);
      versions.push(ArtifactVersion.parse({ version, ts, author: opts.author ?? 'user', note: opts.note }));
      versions.sort((a, b) => a.version - b.version);
      await writeAtomic(join(dir, VERSIONS_DIR, 'versions.json'), JSON.stringify(versions, null, 2) + '\n');
      await writeAtomic(join(dir, 'artifact.json'), JSON.stringify(meta, null, 2) + '\n');
      this.index(meta, dir);
      this.onChange?.(id);
      return meta;
    });
  }

  async rename(id: string, title: string): Promise<ArtifactMeta> {
    return this.withLock(id, async () => {
      const meta = ArtifactMeta.parse({ ...this.metaFromIndex(id), title, updatedAt: this.now() });
      await writeAtomic(join(this.dirOf(id), 'artifact.json'), JSON.stringify(meta, null, 2) + '\n');
      this.index(meta, this.dirOf(id));
      this.onChange?.(id);
      return meta;
    });
  }

  async delete(id: string): Promise<boolean> {
    return this.withLock(id, async () => {
      let dir: string;
      try {
        dir = this.dirOf(id);
      } catch {
        return false;
      }
      await rm(dir, { recursive: true, force: true, maxRetries: 3 });
      this.d.db.prepare('DELETE FROM artifacts WHERE id = ?').run(id);
      this.onChange?.(id);
      return true;
    });
  }

  /* ------------------------------------------------------------- import */

  /**
   * "Import from claude.ai" with a pasted link. There is no public API to fetch the content, so
   * this stores a link-only stub marked `importedFrom`; the user can paste or drop the export later.
   */
  async importUrl(input: { url: string; title?: string; kind?: ArtifactKind; projectId?: string; location?: 'repo' | 'app-data' }, author = 'user'): Promise<ArtifactMeta> {
    let u: URL;
    try {
      u = new URL(input.url);
    } catch {
      throw new Error('Not a valid URL.');
    }
    if (u.protocol !== 'https:' || !ALLOWED_IMPORT_HOSTS.some((re) => re.test(u.hostname))) throw new Error('Only https://claude.ai links can be imported.');
    const kind = input.kind ?? 'doc';
    const title = input.title?.trim() || 'Imported from claude.ai';
    const url = u.toString();
    const note = `Imported from ${url}. oIDE cannot fetch claude.ai artifacts; paste or drop the exported content here to keep a local copy.`;
    const content =
      kind === 'doc'
        ? note + '\n'
        : kind === 'design'
          ? `<!doctype html>\n<html lang="en">\n<head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>\n<body>\n<p>${escapeHtml(note)}</p>\n</body>\n</html>\n`
          : undefined;
    return this.create({ title, kind, content, projectId: input.projectId, location: input.location, importedFrom: url }, author);
  }

  /** Import a dropped or exported file (HTML → design, Markdown → doc, Excalidraw → whiteboard). */
  async importFile(input: { filePath: string; title?: string; kind?: ArtifactKind; projectId?: string; location?: 'repo' | 'app-data' }, author = 'user'): Promise<ArtifactMeta> {
    const st = await stat(input.filePath);
    if (!st.isFile()) throw new Error('Not a file.');
    if (st.size > MAX_IMPORT_BYTES) throw new Error('File is larger than 10 MB.');
    const content = await readFile(input.filePath, 'utf8');
    const kind = input.kind ?? inferKind(input.filePath, content);
    if (!kind) throw new Error('Unknown artifact type. Use an .html, .md or .excalidraw file.');
    const title = input.title?.trim() || basename(input.filePath, extname(input.filePath));
    return this.create({ title, kind, content, projectId: input.projectId, location: input.location }, author);
  }

  /* --------------------------------------------------------------- uses */

  recordUse(artifactId: string, agentId: string, op: ArtifactUse['op'], ts = this.now()): ArtifactUse {
    const u = ArtifactUse.parse({ artifactId, agentId, op, ts });
    this.d.db.prepare('INSERT INTO artifact_uses (artifact_id, agent_id, op, ts) VALUES (?, ?, ?, ?)').run(u.artifactId, u.agentId, u.op, u.ts);
    return u;
  }

  uses(artifactId: string, limit = 200): ArtifactUse[] {
    return (this.d.db.prepare('SELECT * FROM artifact_uses WHERE artifact_id = ? ORDER BY ts DESC, id DESC LIMIT ?').all(artifactId, limit) as Row[]).map((r) =>
      ArtifactUse.parse({ artifactId: r.artifact_id, agentId: r.agent_id, op: r.op, ts: num(r.ts) }),
    );
  }

  /** Artifacts an agent touched (a tile's "1 doc artifact"). */
  usesByAgent(agentId: string): ArtifactUse[] {
    return (this.d.db.prepare('SELECT * FROM artifact_uses WHERE agent_id = ? ORDER BY ts DESC, id DESC').all(agentId) as Row[]).map((r) =>
      ArtifactUse.parse({ artifactId: r.artifact_id, agentId: r.agent_id, op: r.op, ts: num(r.ts) }),
    );
  }

  /* ------------------------------------------------- ArtifactsBackend (MCP) */

  async write(id: string, content: string, agentId: string): Promise<ArtifactMeta> {
    const meta = await this.save(id, content, { author: `agent:${agentId}` });
    this.recordUse(id, agentId, 'write');
    return meta;
  }

  /** `create` as called by the MCP tool: author is the agent; the use is logged. */
  async createForAgent(input: { title: string; kind: ArtifactKind; content?: string; projectId?: string }, agentId: string): Promise<ArtifactMeta> {
    const meta = await this.create({ ...input, location: 'app-data' }, `agent:${agentId}`);
    this.recordUse(meta.id, agentId, 'create');
    return meta;
  }

  /** The backend view the MCP server takes (`list`, `read`, `write`, `create` with agent attribution). */
  backend(): ArtifactsBackend {
    return {
      list: (filter, agentId) => this.list(filter, agentId),
      read: (id, agentId) => this.read(id, agentId),
      write: (id, content, agentId) => this.write(id, content, agentId),
      create: (input, agentId) => this.createForAgent(input, agentId),
    };
  }

  private withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(id) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const settled = next.catch(() => undefined);
    this.locks.set(id, settled);
    void settled.then(() => {
      if (this.locks.get(id) === settled) this.locks.delete(id);
    });
    return next;
  }
}
