import { existsSync } from 'node:fs';
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  ArtifactMeta,
  ArtifactUse,
  ArtifactVersion,
  classifyClaudeLink,
  designEntryFor,
  HTML_DESIGN_ENTRY,
  IMPORT_NEEDS_CONTENT,
  inferKindFromContent,
  isDesignContent,
  isEmptyOideBoard,
  isImportStubContent,
  LEGACY_IMPORT_STUB_MAX_BYTES,
  REACT_DESIGN_ENTRY,
  titleFromContent,
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
 *     index.html | App.jsx | doc.md | board.excalidraw   the entry file (App.jsx: a React design)
 *     .versions/versions.json          ArtifactVersion[]
 *     .versions/<n>/<entry>            snapshot of each version
 *
 * Numbered snapshots are used for both locations (ADR 0004). SQLite keeps an index (for fast
 * listing and the uses log); the folder is the source of truth for content and meta.
 */

export const ENTRY_FILES: Record<ArtifactKind, string> = { design: 'index.html', doc: 'doc.md', whiteboard: 'board.excalidraw' };
const MAX_IMPORT_BYTES = 10 * 1024 * 1024;
const VERSIONS_DIR = '.versions';

/**
 * Entry file of an artifact: always one of a fixed set, never a name taken from `artifact.json` (a
 * cloned repo could point it outside the folder). Designs are `index.html` or, for React, `App.jsx`.
 */
export function entryFileOf(kind: ArtifactKind, entry?: string): string {
  return kind === 'design' && entry === REACT_DESIGN_ENTRY ? REACT_DESIGN_ENTRY : ENTRY_FILES[kind];
}

export interface ArtifactStoreOptions {
  db: Database;
  /** Electron `userData`; personal artifacts go to `<appDataDir>/artifacts/`. */
  appDataDir: string;
  /** Main checkout of a project, for repo artifacts. */
  projectPath: (projectId: string) => string | undefined;
  now?: () => number;
  /** Called after any change (main forwards it as the `artifacts.changed` event). */
  onChange?: (id?: string, info?: ArtifactChange) => void;
}

/** What changed, passed to `onChange` (the `artifacts.changed` event payload minus the id). */
export interface ArtifactChange {
  change: 'created' | 'saved' | 'renamed' | 'deleted';
  version?: number;
  author?: string;
}

export interface SaveOptions {
  author?: string;
  note?: string;
  /** The version the editor started from; refuse (code `conflict`) when the artifact is past it. */
  baseVersion?: number;
}

export const MAX_TITLE_LENGTH = 200;

/** Why an import was refused (a telemetry reason; never the link or the content). */
export type ImportRefusal = 'no_content' | 'bad_link' | 'wrong_kind' | 'too_large' | 'stub_content';

/** Error with a machine-readable code (`conflict`, `invalid_input`), mapped to an IPC error code by main. */
export class ArtifactError extends Error {
  readonly code: 'conflict' | 'invalid_input';
  /** Set when an import is refused before anything is created. */
  readonly reason: ImportRefusal | undefined;
  constructor(message: string, code: 'conflict' | 'invalid_input', reason?: ImportRefusal) {
    super(message);
    this.name = 'ArtifactError';
    this.code = code;
    this.reason = reason;
  }
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
  if (ext === '.html' || ext === '.htm' || ext === '.jsx' || ext === '.tsx' || ext === '.svg') return 'design';
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
      throw new Error(`Whiteboard content must be Excalidraw JSON: ${(e as Error).message}`, { cause: e });
    }
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('Whiteboard content must be an Excalidraw JSON object.');
  }
}

/**
 * A claude.ai / claude.site artifact link, normalised; anything else (another host, a chat link, a
 * page that is not an artifact) is refused (`invalid_input`) with the reason from classifyClaudeLink.
 */
export function claudeImportUrl(raw: string): string {
  const link = classifyClaudeLink(raw);
  if (!link.ok) throw new ArtifactError(link.reason, 'invalid_input', 'bad_link');
  return link.url;
}

function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

function checkImportSize(content: string): void {
  if (Buffer.byteLength(content, 'utf8') > MAX_IMPORT_BYTES) throw new ArtifactError('The content is larger than 10 MB.', 'invalid_input', 'too_large');
}

/**
 * Imported content must be real and fit its kind, checked before anything is created: never the
 * placeholder older oIDE versions stored for a link-only import; a design is an HTML page or React
 * component source (previewed offline); a whiteboard is Excalidraw JSON.
 */
function checkImportContent(kind: ArtifactKind, content: string): void {
  if (!content.trim()) throw new ArtifactError(IMPORT_NEEDS_CONTENT, 'invalid_input', 'no_content');
  if (isImportStubContent(content)) {
    throw new ArtifactError(
      "This is oIDE's old placeholder notice, not the artifact. Open the link on claude.ai and copy the artifact's own code, or download it.",
      'invalid_input',
      'stub_content',
    );
  }
  if (kind === 'design' && !isDesignContent(content)) {
    throw new ArtifactError(
      "This isn't an HTML page or a React component, so it can't be a design. Copy the artifact's code on claude.ai, or import this as a doc.",
      'invalid_input',
      'wrong_kind',
    );
  }
  if (kind === 'whiteboard') {
    try {
      validateContent(kind, content);
    } catch (e) {
      throw new ArtifactError((e as Error).message, 'invalid_input', 'wrong_kind');
    }
  }
}

async function writeAtomic(path: string, content: string): Promise<void> {
  const tmp = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(tmp, content, 'utf8');
  await rename(tmp, path);
}

const VersionsFile = z.array(ArtifactVersion);

/** Only a never-edited claude.ai import can still hold the old link-only placeholder. */
function mayBeBrokenImport(meta: ArtifactMeta): boolean {
  return !!meta.importedFrom && meta.version === 1;
}

/**
 * `brokenImport` is derived from the content each time it is read, never stored: the placeholder older
 * versions wrote for a link-only import (designs and docs), or their empty board (whiteboards).
 */
function withBrokenFlag(meta: ArtifactMeta, content: string): ArtifactMeta {
  const { brokenImport: _stored, ...rest } = meta;
  void _stored;
  if (!mayBeBrokenImport(rest)) return rest;
  const broken = rest.kind === 'whiteboard' ? isEmptyOideBoard(content) : isImportStubContent(content);
  return broken ? { ...rest, brokenImport: true } : rest;
}

/** The other design entry (a design is `index.html` or `App.jsx`). */
function otherDesignEntry(entry: string): string {
  return entry === REACT_DESIGN_ENTRY ? HTML_DESIGN_ENTRY : REACT_DESIGN_ENTRY;
}

export class ArtifactStore {
  private readonly d: Database;
  private readonly appDataDir: string;
  private readonly projectPath: (projectId: string) => string | undefined;
  private readonly now: () => number;
  private readonly onChange: ((id?: string, info?: ArtifactChange) => void) | undefined;
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

  /**
   * Path of an artifact's entry file (or a version snapshot of it). The file name is one of the fixed
   * entry names (`entryFileOf`), never a name from `artifact.json`, and must stay inside the folder.
   */
  private async contentPath(id: string, meta: ArtifactMeta, version?: number, entry = meta.entry): Promise<string> {
    const dir = resolve(this.dirOf(id));
    const name = entryFileOf(meta.kind, entry);
    const parts = version === undefined ? [name] : [VERSIONS_DIR, String(version), name];
    const file = resolve(join(dir, ...parts));
    const rel = relative(dir, file);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('Artifact path escapes its folder');
    // Symlinks (a cloned repo can commit them) must not redirect reads or writes elsewhere:
    // the artifact folder must be a real directory and no component below it may be a link.
    if ((await lstat(dir)).isSymbolicLink()) throw new Error('Artifact folder is a symbolic link');
    const realDir = await realpath(dir);
    let cur = dir;
    for (const part of parts) {
      cur = join(cur, part);
      const st = await lstat(cur).catch(() => undefined);
      if (!st) break; // not created yet; parents checked so far are real
      if (st.isSymbolicLink()) throw new Error('Artifact path contains a symbolic link');
    }
    const parentReal = await realpath(dirname(file)).catch(() => undefined);
    if (parentReal) {
      const r = relative(realDir, parentReal);
      if (r.startsWith('..') || isAbsolute(r)) throw new Error('Artifact path escapes its folder');
    }
    return file;
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
          // Never trust `entry` from disk (a cloned repo could point it outside the folder): one of the fixed
          // names. `brokenImport` is derived when read, so a value on disk is dropped.
          const { brokenImport: _derived, ...onDisk } = parsed.data;
          void _derived;
          let entry = entryFileOf(onDisk.kind, onDisk.entry);
          // A design whose entry file is missing but has the other one (an interrupted format switch,
          // or a teammate's oIDE that wrote the other format): use the file that is there.
          if (onDisk.kind === 'design' && !existsSync(join(dir, entry)) && existsSync(join(dir, otherDesignEntry(entry)))) entry = otherDesignEntry(entry);
          const meta: ArtifactMeta = { ...onDisk, entry, slug: name, location, projectId: location === 'repo' ? projectId : parsed.data.projectId };
          // An id already indexed at a different folder keeps its folder; a copied artifact.json can't hijack it.
          const sameId = this.d.db.prepare('SELECT dir_key FROM artifacts WHERE id = ?').get(meta.id) as Row | undefined;
          if (sameId && String(sameId.dir_key) !== pathKey(dir) && existsSync(join(this.dirOf(meta.id), 'artifact.json'))) continue;
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
    const metas = rows.map((r) => ArtifactMeta.parse(fromJson(r.meta)));
    return Promise.all(metas.map((m) => this.flagBroken(m)));
  }

  /**
   * `withBrokenFlag` without reading big files: only a never-edited import can be a broken one, and
   * the placeholder was small, so a bigger entry file is real content and is not read.
   */
  private async flagBroken(meta: ArtifactMeta): Promise<ArtifactMeta> {
    if (!mayBeBrokenImport(meta)) return meta;
    try {
      const path = await this.contentPath(meta.id, meta);
      if ((await stat(path)).size > LEGACY_IMPORT_STUB_MAX_BYTES) return meta;
      return withBrokenFlag(meta, await readFile(path, 'utf8'));
    } catch {
      return meta;
    }
  }

  async read(id: string, agentId?: string): Promise<ArtifactContent> {
    let meta = this.metaFromIndex(id);
    let content: string;
    try {
      content = await readFile(await this.contentPath(id, meta), 'utf8');
    } catch (e) {
      // A design whose entry is missing but has the other format's file (an interrupted switch).
      if (meta.kind !== 'design' || (e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      const other = otherDesignEntry(entryFileOf('design', meta.entry));
      content = await readFile(await this.contentPath(id, meta, undefined, other), 'utf8');
      meta = { ...meta, entry: other };
    }
    if (agentId) this.recordUse(id, agentId, 'read');
    return { meta: withBrokenFlag(meta, content), content };
  }

  /** Meta from the index, without reading files (the preview scheme needs the entry file). */
  metaOf(id: string): ArtifactMeta {
    return this.metaFromIndex(id);
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

  /** Content of an older version (History). A design's version is HTML or React (`App.jsx`). */
  async readVersion(id: string, version: number): Promise<string> {
    const meta = this.metaFromIndex(id);
    if (!Number.isInteger(version) || version < 1) throw new Error('Bad version');
    const current = entryFileOf(meta.kind, meta.entry);
    const entries = meta.kind === 'design' ? [current, current === REACT_DESIGN_ENTRY ? HTML_DESIGN_ENTRY : REACT_DESIGN_ENTRY] : [current];
    let last: unknown;
    for (const entry of entries) {
      try {
        return await readFile(await this.contentPath(id, meta, version, entry), 'utf8');
      } catch (e) {
        last = e;
      }
    }
    throw last;
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
      entry: input.kind === 'design' && input.content !== undefined ? designEntryFor(input.content) : ENTRY_FILES[input.kind],
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
    this.onChange?.(meta.id, { change: 'created', version: 1, author });
    return meta;
  }

  /** Save new content as the next numbered version. */
  async save(id: string, content: string, opts: SaveOptions = {}): Promise<ArtifactMeta> {
    return this.withLock(id, async () => {
      const cur = this.metaFromIndex(id);
      if (opts.baseVersion !== undefined && opts.baseVersion !== cur.version) {
        throw new ArtifactError(`${cur.title} changed since you opened it (now v${cur.version}, you started from v${opts.baseVersion}).`, 'conflict');
      }
      validateContent(cur.kind, content);
      const dir = this.dirOf(id);
      const ts = this.now();
      const version = cur.version + 1;
      // A design follows its content: React source is stored as App.jsx, HTML as index.html.
      const entry = cur.kind === 'design' ? designEntryFor(content) : entryFileOf(cur.kind);
      const oldEntry = entryFileOf(cur.kind, cur.entry);
      const meta = ArtifactMeta.parse({ ...cur, entry, version, updatedAt: ts });
      await this.contentPath(id, meta, version); // refuse symlinked .versions before creating anything
      await mkdir(join(dir, VERSIONS_DIR, String(version)), { recursive: true });
      await writeFile(await this.contentPath(id, meta, version), content, 'utf8');
      await writeAtomic(await this.contentPath(id, meta), content);
      const versions = await this.versions(id);
      versions.push(ArtifactVersion.parse({ version, ts, author: opts.author ?? 'user', note: opts.note }));
      versions.sort((a, b) => a.version - b.version);
      await writeAtomic(join(dir, VERSIONS_DIR, 'versions.json'), JSON.stringify(versions, null, 2) + '\n');
      await writeAtomic(join(dir, 'artifact.json'), JSON.stringify(meta, null, 2) + '\n');
      this.index(meta, dir);
      // Only once meta and index point at the new entry: the other format's file goes, so the preview
      // never serves a stale page (a failure before this leaves both files, never neither).
      if (entry !== oldEntry) await rm(await this.contentPath(id, cur), { force: true }).catch(() => undefined);
      this.onChange?.(id, { change: 'saved', version, author: opts.author ?? 'user' });
      return meta;
    });
  }

  /**
   * New title. The folder (slug) stays as it is, so repo links, git history and agents that hold the
   * id keep working; only `artifact.json` and the index change. Does not create a version.
   */
  async rename(id: string, title: string): Promise<ArtifactMeta> {
    const next = title.replace(/\s+/g, ' ').trim();
    if (!next) throw new ArtifactError('Give the artifact a title.', 'invalid_input');
    if (next.length > MAX_TITLE_LENGTH) throw new ArtifactError(`Titles can be at most ${MAX_TITLE_LENGTH} characters.`, 'invalid_input');
    return this.withLock(id, async () => {
      const cur = this.metaFromIndex(id);
      if (cur.title === next) return this.flagBroken(cur);
      const meta = ArtifactMeta.parse({ ...cur, title: next, updatedAt: this.now() });
      await writeAtomic(join(this.dirOf(id), 'artifact.json'), JSON.stringify(meta, null, 2) + '\n');
      this.index(meta, this.dirOf(id));
      this.onChange?.(id, { change: 'renamed', version: meta.version });
      return this.flagBroken(meta);
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
      this.d.db.prepare('DELETE FROM artifact_uses WHERE artifact_id = ?').run(id);
      this.onChange?.(id, { change: 'deleted' });
      return true;
    });
  }

  /* ------------------------------------------------------------- import */

  /**
   * "Import from claude.ai" with a pasted link. claude.ai has no public API for artifact content, and
   * oIDE never uses the user's claude.ai sign-in, so main cannot fetch it: the user pastes the content
   * they copied on claude.ai (`content`), and the link is kept as `importedFrom` (Open in claude.ai).
   * The kind follows the content when none is given. Everything is checked before anything is
   * created: a link alone, a link that is not an artifact link, or content that does not fit is refused.
   */
  async importUrl(
    input: { url?: string; content?: string; title?: string; kind?: ArtifactKind; projectId?: string; location?: 'repo' | 'app-data' },
    author = 'user',
  ): Promise<ArtifactMeta> {
    // Without a link the pasted code is imported with no origin (an old import's link may no longer pass).
    const url = input.url !== undefined ? claudeImportUrl(input.url) : undefined;
    if (input.content === undefined || !input.content.trim()) throw new ArtifactError(IMPORT_NEEDS_CONTENT, 'invalid_input', 'no_content');
    const pasted = stripBom(input.content);
    checkImportSize(pasted);
    const kind = input.kind ?? inferKindFromContent(pasted);
    checkImportContent(kind, pasted);
    const title = input.title?.trim() || titleFromContent(kind, pasted) || 'Imported from claude.ai';
    return this.create({ title, kind, content: pasted, projectId: input.projectId, location: input.location, ...(url ? { importedFrom: url } : {}) }, author);
  }

  /**
   * Import a dropped or downloaded file (HTML, JSX/TSX or SVG → design, Markdown → doc, Excalidraw →
   * whiteboard), checked like pasted content before anything is created.
   * `url` is the claude.ai link the file was downloaded from, kept as `importedFrom` when given.
   */
  async importFile(
    input: { filePath: string; url?: string; title?: string; kind?: ArtifactKind; projectId?: string; location?: 'repo' | 'app-data' },
    author = 'user',
  ): Promise<ArtifactMeta> {
    const importedFrom = input.url ? claudeImportUrl(input.url) : undefined;
    const st = await stat(input.filePath);
    if (!st.isFile()) throw new Error('Not a file.');
    if (st.size > MAX_IMPORT_BYTES) throw new ArtifactError('The file is larger than 10 MB.', 'invalid_input', 'too_large');
    const content = stripBom(await readFile(input.filePath, 'utf8'));
    const kind = input.kind ?? inferKind(input.filePath, content);
    if (!kind) throw new ArtifactError('Unknown artifact type. Use an .html, .jsx, .tsx, .svg, .md or .excalidraw file.', 'invalid_input', 'wrong_kind');
    // An .html file is a page by its name (any content but empty or the old placeholder); other files
    // picked as a design must hold HTML or React.
    if (kind === 'design' && /\.html?$/i.test(input.filePath)) {
      if (!content.trim()) throw new ArtifactError('The file is empty.', 'invalid_input', 'no_content');
      if (isImportStubContent(content)) checkImportContent(kind, content);
    } else checkImportContent(kind, content);
    const title = input.title?.trim() || basename(input.filePath, extname(input.filePath));
    return this.create({ title, kind, content, projectId: input.projectId, location: input.location, ...(importedFrom ? { importedFrom } : {}) }, author);
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
