import { constants, existsSync } from 'node:fs';
import { copyFile, lstat, mkdir, open, readdir, readFile, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import {
  applyBoardOps,
  ARTIFACT_LIMITS,
  ArtifactMeta,
  defaultBoard,
  describeBoardOps,
  parseBoard,
  serializeBoard,
  type BoardOp,
  type BoardOpContext,
  type BoardOpResult,
  type KanbanBoard,
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
  isSafeArtifactPath,
  LEGACY_IMPORT_STUB_MAX_BYTES,
  REACT_DESIGN_ENTRY,
  titleFromContent,
  type ArtifactContent,
  type ArtifactFile,
  type ArtifactFileContent,
  type ArtifactKind,
  type ArtifactRetrieval,
  type ArtifactsBackend,
} from '@oide/protocol';
import { z } from 'zod';
import { ArtifactPathError, foldPath, isTextBytes, isTextFile, kindOfEntry, pickEntry, resolveInside, walkFolder, type WalkedFile } from './artifact-files.js';
import { fromJson, type Database } from './db.js';
import { newId, num, pathKey, type Row } from './util.js';

/**
 * Local artifacts (ADR 0004, ADR 0014). Each artifact is a folder of files:
 *
 *   <repo>/.oide/artifacts/<slug>/     shared with the team through git (location "repo")
 *   <app-data>/artifacts/<slug>/       personal (location "app-data")
 *     artifact.json                    ArtifactMeta
 *     <files of the current version>   index.html | App.jsx | doc.md | board.excalidraw, or many files
 *     .versions/versions.json          ArtifactVersion[] (+ the entry of each version)
 *     .versions/<n>/…                  full snapshot of every file of version n
 *
 * A single-file artifact from before ADR 0014 already fits (`.versions/<n>/<entry>`). Version 0 is a
 * linked artifact waiting for its first retrieval: no files yet. SQLite keeps an index (fast listing
 * and the uses log); the folder is the source of truth for content and meta.
 */

export const ENTRY_FILES: Record<ArtifactKind, string> = { design: 'index.html', doc: 'doc.md', whiteboard: 'board.excalidraw', board: 'board.json' };
/**
 * Boards save a version for every change (a drag is a version), so only the newest snapshots are kept
 * (ADR 0022); older ones are removed after each board commit. Other kinds keep every version (ADR 0004).
 */
export const BOARD_KEEP_VERSIONS = 200;
const MAX_IMPORT_BYTES = ARTIFACT_LIMITS.fileBytes;
const VERSIONS_DIR = '.versions' as const;
/** Written while the folder's root is being brought in line with a new snapshot; rescan finishes the job. */
const SYNC_MARKER = '.sync';
/** Biggest file `files()` reads to tell text from binary (the rest of a big file is not read). */
const SNIFF_BYTES = 64 * 1024;

/**
 * Entry file of a single-file artifact: one of a fixed set. Designs are `index.html` or, for React,
 * `App.jsx`. Multi-file artifacts use any `isSafeArtifactPath` entry (`safeEntry`).
 */
export function entryFileOf(kind: ArtifactKind, entry?: string): string {
  return kind === 'design' && entry === REACT_DESIGN_ENTRY ? REACT_DESIGN_ENTRY : ENTRY_FILES[kind];
}

/** The entry of `meta` when it is a safe relative path, else the fixed name for its kind. */
export function safeEntry(meta: Pick<ArtifactMeta, 'kind' | 'entry'>): string {
  return isSafeArtifactPath(meta.entry) ? meta.entry : entryFileOf(meta.kind, meta.entry);
}

export interface ArtifactStoreOptions {
  db: Database;
  /** Electron `userData`; personal artifacts go to `<appDataDir>/artifacts/`. */
  appDataDir: string;
  /** Main checkout of a project, for repo artifacts. */
  projectPath: (projectId: string) => string | undefined;
  now?: () => number;
  /** Board snapshots kept (default `BOARD_KEEP_VERSIONS`; tests use a small number). */
  boardKeepVersions?: number;
  /** Called after any change (main forwards it as the `artifacts.changed` event). */
  onChange?: (id?: string, info?: ArtifactChange) => void;
}

/** What changed, passed to `onChange` (the `artifacts.changed` event payload minus the id). */
export interface ArtifactChange {
  change: 'created' | 'saved' | 'renamed' | 'deleted' | 'retrieval';
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
export type ImportRefusal = 'no_content' | 'bad_link' | 'wrong_kind' | 'too_large' | 'stub_content' | 'bad_path';

/** Error with a machine-readable code (`conflict`, `invalid_input`), mapped to an IPC error code by main. */
export class ArtifactError extends Error {
  readonly code: 'conflict' | 'invalid_input';
  /** Set when an import or write is refused before anything is created. */
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

/** A file to write: UTF-8 text or base64 bytes (IPC and MCP shape). */
export type ArtifactFileWrite = { path: string } & ArtifactFileContent;

export interface WriteFilesChange {
  files?: ArtifactFileWrite[];
  deletes?: string[];
  /** Move the entry to another file of the new version. */
  entry?: string;
  note?: string;
  author?: string;
  baseVersion?: number;
}

/** Retrieval result committed as one new version (ADR 0014). */
export interface CommitFolderOptions {
  entry?: string;
  /** Applies only while the kind is still the guessed one (the first retrieval, the user gave none). */
  kind?: ArtifactKind;
  /** Applies only while the title is still the placeholder (the user gave none). */
  title?: string;
  note: string;
  author: string;
  retrieval: ArtifactRetrieval;
}

/**
 * oIDE's own notes in `artifact.json`, not part of `ArtifactMeta`: whether the title and kind are
 * still oIDE's guesses for a link import (then the first retrieval may replace them).
 */
interface Internal {
  autoTitle?: boolean;
  autoKind?: boolean;
}
const INTERNAL_KEY = 'oideInternal';
const InternalSchema = z.object({ autoTitle: z.boolean().optional(), autoKind: z.boolean().optional() });

/** One file of a version being written: new bytes, a file to copy, or an unchanged file of the root. */
interface PlanFile {
  path: string;
  size: number;
  bytes?: Buffer;
  from?: string;
  /** Already at the root with this exact path and content. */
  unchanged?: boolean;
}
type Plan = Map<string, PlanFile>;

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
      const type = (JSON.parse(content) as { type?: unknown }).type;
      if (type === 'oide-board') return 'board';
      if (type === 'excalidraw') return 'whiteboard';
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
    case 'board':
      return serializeBoard(defaultBoard());
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
  if (kind === 'board') {
    try {
      parseBoard(content);
    } catch (e) {
      throw new ArtifactError((e as Error).message, 'invalid_input', 'wrong_kind');
    }
    return;
  }
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
  if (kind === 'whiteboard' || kind === 'board') {
    try {
      validateContent(kind, content);
    } catch (e) {
      throw new ArtifactError((e as Error).message, 'invalid_input', 'wrong_kind');
    }
  }
}

async function writeAtomic(path: string, content: string | Buffer): Promise<void> {
  const tmp = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(tmp, content, { flag: 'wx', ...(typeof content === 'string' ? { encoding: 'utf8' as const } : {}) });
  await rename(tmp, path);
}

/** A small file of oIDE's own (artifact.json, versions.json), refused when it is a link or not a regular file. */
async function readRegular(path: string): Promise<string> {
  const st = await lstat(path);
  if (!st.isFile()) throw new Error(`${path} is not a regular file`);
  return readFile(path, 'utf8');
}

/** Atomic copy (tmp + rename), as a clone where the file system can (copy-on-write). */
async function copyAtomic(from: string, to: string): Promise<void> {
  const tmp = `${to}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  await copyFile(from, tmp, constants.COPYFILE_FICLONE | constants.COPYFILE_EXCL);
  await rename(tmp, to);
}

/** versions.json as stored: each version also records its entry (not part of the IPC `ArtifactVersion`). */
const StoredVersion = ArtifactVersion.extend({ entry: z.string().optional() });
type StoredVersion = z.infer<typeof StoredVersion>;
const VersionsFile = z.array(StoredVersion);

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

/** The other design entry (a single-file design is `index.html` or `App.jsx`). */
function otherDesignEntry(entry: string): string {
  return entry === REACT_DESIGN_ENTRY ? HTML_DESIGN_ENTRY : REACT_DESIGN_ENTRY;
}

/** Strict base64 (whitespace allowed), decoded; anything else is refused instead of silently dropped. */
export function decodeBase64(data: string, path: string): Buffer {
  const clean = data.replace(/\s+/g, '');
  if (clean.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) throw new ArtifactError(`${path}: not valid base64.`, 'invalid_input', 'wrong_kind');
  return Buffer.from(clean, 'base64');
}

function cleanTitle(t: string | undefined): string | undefined {
  const s = t?.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE_LENGTH).trim();
  return s || undefined;
}

const mb = (n: number) => `${Math.round(n / (1024 * 1024))} MB`;

/** Limits, paths and file/folder clashes of a whole version, before anything is written. */
function checkPlan(plan: Plan): void {
  if (plan.size > ARTIFACT_LIMITS.files) {
    throw new ArtifactError(`An artifact can have at most ${ARTIFACT_LIMITS.files} files (this one would have ${plan.size}).`, 'invalid_input', 'too_large');
  }
  let total = 0;
  const dirs = new Map<string, string>();
  for (const f of plan.values()) {
    if (!isSafeArtifactPath(f.path)) throw new ArtifactError(`"${f.path}" is not a valid file path inside an artifact.`, 'invalid_input', 'bad_path');
    if (f.size > ARTIFACT_LIMITS.fileBytes) throw new ArtifactError(`${f.path} is larger than ${mb(ARTIFACT_LIMITS.fileBytes)}.`, 'invalid_input', 'too_large');
    total += f.size;
    const parts = foldPath(f.path).split('/');
    for (let i = 1; i < parts.length; i++) dirs.set(parts.slice(0, i).join('/'), f.path);
  }
  if (total > ARTIFACT_LIMITS.totalBytes) throw new ArtifactError(`An artifact can hold at most ${mb(ARTIFACT_LIMITS.totalBytes)} (this one would hold ${mb(total)}).`, 'invalid_input', 'too_large');
  for (const [key, f] of plan) if (dirs.has(key)) throw new ArtifactError(`"${f.path}" is both a file and a folder.`, 'invalid_input', 'bad_path');
}

async function bytesOf(f: PlanFile): Promise<Buffer> {
  return f.bytes ?? (await readFile(f.from!));
}

/**
 * The entry must be a file of the version that fits the kind: a design opens on an HTML page, an SVG
 * or React source; a whiteboard on an Excalidraw JSON object; a doc on a text file. Returns the path
 * as stored (its exact case).
 */
async function checkEntry(kind: ArtifactKind, entry: string, plan: Plan): Promise<string> {
  const f = plan.get(foldPath(entry));
  if (!f) throw new ArtifactError(`The entry file ${entry} is not one of the artifact's files.`, 'invalid_input', 'no_content');
  const ext = extname(f.path).toLowerCase();
  if (kind === 'design') {
    if (['.html', '.htm', '.jsx', '.tsx', '.svg'].includes(ext)) return f.path;
    const bytes = await bytesOf(f);
    if (isTextBytes(bytes) && isDesignContent(bytes.toString('utf8'))) return f.path;
    throw new ArtifactError(`A design opens on an HTML page or a React component; ${f.path} is neither.`, 'invalid_input', 'wrong_kind');
  }
  const bytes = await bytesOf(f);
  if (!isTextBytes(bytes)) throw new ArtifactError(`${f.path} is not a text file, so it can't be the ${kind}'s entry.`, 'invalid_input', 'wrong_kind');
  if (kind === 'whiteboard' || kind === 'board') {
    try {
      validateContent(kind, bytes.toString('utf8'));
    } catch (e) {
      throw new ArtifactError(`${f.path}: ${(e as Error).message}`, 'invalid_input', 'wrong_kind');
    }
  }
  return f.path;
}

export class ArtifactStore {
  private readonly d: Database;
  private readonly appDataDir: string;
  private readonly projectPath: (projectId: string) => string | undefined;
  private readonly now: () => number;
  private readonly onChange: ((id?: string, info?: ArtifactChange) => void) | undefined;
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly boardKeep: number;

  constructor(opts: ArtifactStoreOptions) {
    this.d = opts.db;
    this.appDataDir = opts.appDataDir;
    this.projectPath = opts.projectPath;
    this.now = opts.now ?? Date.now;
    this.onChange = opts.onChange;
    this.boardKeep = Math.max(1, opts.boardKeepVersions ?? BOARD_KEEP_VERSIONS);
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

  /** Path of a file of the current version, or of version `version` (`.versions/<n>/…`), inside the folder. */
  private async filePath(id: string, rel: string, version?: number): Promise<string> {
    if (!isSafeArtifactPath(rel)) throw new ArtifactError(`"${rel}" is not a valid file path inside an artifact.`, 'invalid_input', 'bad_path');
    const parts = rel.split('/');
    return this.guard(() => resolveInside(this.dirOf(id), version === undefined ? parts : [VERSIONS_DIR, String(version), ...parts], version === undefined ? {} : { reservedTop: VERSIONS_DIR }));
  }

  /** Path errors (a symbolic link, an escape) keep their message; nothing else is wrapped. */
  private async guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof ArtifactPathError) throw new Error(e.message, { cause: e });
      throw e;
    }
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

  /** `artifact.json`: the meta (never `brokenImport`, which is derived) plus oIDE's internal notes. */
  private async writeMeta(dir: string, meta: ArtifactMeta, internal?: Internal | null): Promise<void> {
    const { brokenImport: _derived, ...stored } = meta;
    void _derived;
    const keep = internal === undefined ? await this.readInternal(dir) : (internal ?? {});
    const out: Record<string, unknown> = { ...stored };
    if (keep.autoTitle || keep.autoKind) out[INTERNAL_KEY] = { ...(keep.autoTitle ? { autoTitle: true } : {}), ...(keep.autoKind ? { autoKind: true } : {}) };
    await writeAtomic(join(dir, 'artifact.json'), JSON.stringify(out, null, 2) + '\n');
  }

  private async readInternal(dir: string): Promise<Internal> {
    try {
      const raw = JSON.parse(await readRegular(join(dir, 'artifact.json'))) as Record<string, unknown>;
      const r = InternalSchema.safeParse(raw[INTERNAL_KEY]);
      return r.success ? r.data : {};
    } catch {
      return {};
    }
  }

  /** Files at the root of an artifact folder (its current version), never following links. */
  private async rootFiles(dir: string): Promise<WalkedFile[]> {
    if ((await lstat(dir)).isSymbolicLink()) throw new Error('Artifact folder is a symbolic link');
    return walkFolder(dir, { artifactRoot: true, unsafe: 'skip', max: ARTIFACT_LIMITS.files * 4 });
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
          const parsed = ArtifactMeta.safeParse(JSON.parse(await readRegular(join(dir, 'artifact.json'))));
          if (!parsed.success) continue;
          // `brokenImport` is derived when read, so a value on disk is dropped.
          const { brokenImport: _derived, ...onDisk } = parsed.data;
          void _derived;
          // An id already indexed at a different folder keeps its folder; a copied artifact.json can't hijack it.
          const sameId = this.d.db.prepare('SELECT dir_key FROM artifacts WHERE id = ?').get(onDisk.id) as Row | undefined;
          if (sameId && String(sameId.dir_key) !== pathKey(dir) && existsSync(join(this.dirOf(onDisk.id), 'artifact.json'))) continue;
          if ((await lstat(dir)).isSymbolicLink()) continue;
          // An interrupted write: the snapshot is complete, the root may not be.
          const marker = join(dir, VERSIONS_DIR, SYNC_MARKER);
          // (Not while this store is writing it: the marker is then the write in progress.)
          const versionsStat = await lstat(join(dir, VERSIONS_DIR)).catch(() => undefined);
          const markerStat = versionsStat?.isDirectory() ? await lstat(marker).catch(() => undefined) : undefined;
          // A marker that is a link (planted in a cloned repo) is removed (the link, never its target) and ignored.
          if (markerStat?.isSymbolicLink()) await rm(marker, { force: true }).catch(() => undefined);
          else if (onDisk.version > 0 && markerStat?.isFile() && !this.locks.has(onDisk.id)) {
            await this.syncRoot(dir, onDisk.version)
              .then(() => rm(marker, { force: true }))
              .catch(() => undefined);
          }
          const files = onDisk.version > 0 ? await this.rootFiles(dir) : [];
          const entry = onDisk.version > 0 ? this.entryOnDisk(onDisk, files) : isSafeArtifactPath(onDisk.entry) ? onDisk.entry : ENTRY_FILES[onDisk.kind];
          const meta: ArtifactMeta = { ...onDisk, entry, fileCount: files.length, slug: name, location, projectId: location === 'repo' ? projectId : parsed.data.projectId };
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

  /**
   * Never trust `entry` from disk blindly (a cloned repo could point it anywhere): a safe relative
   * path of a real file in the folder, else the fixed name for the kind (or the other design format,
   * after an interrupted switch), else the default entry of the files that are there.
   */
  private entryOnDisk(meta: ArtifactMeta, files: WalkedFile[]): string {
    const paths = files.map((f) => f.path);
    const has = (p: string) => paths.includes(p);
    if (isSafeArtifactPath(meta.entry) && has(meta.entry)) return meta.entry;
    const fixed = entryFileOf(meta.kind, meta.entry);
    if (has(fixed)) return fixed;
    if (meta.kind === 'design' && has(otherDesignEntry(fixed))) return otherDesignEntry(fixed);
    return pickEntry(meta.kind, paths) ?? fixed;
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
      const path = await this.filePath(meta.id, safeEntry(meta));
      if ((await stat(path)).size > LEGACY_IMPORT_STUB_MAX_BYTES) return meta;
      return withBrokenFlag(meta, await readFile(path, 'utf8'));
    } catch {
      return meta;
    }
  }

  /** Meta and the entry file's text. Version 0 (nothing retrieved yet) has no files: content is empty. */
  async read(id: string, agentId?: string): Promise<ArtifactContent> {
    let meta = this.metaFromIndex(id);
    let content = '';
    if (meta.version > 0) {
      try {
        content = await readFile(await this.filePath(id, safeEntry(meta)), 'utf8');
      } catch (e) {
        // A single-file design whose entry is missing but has the other format's file (an interrupted switch).
        const entry = safeEntry(meta);
        if (meta.kind !== 'design' || (e as NodeJS.ErrnoException).code !== 'ENOENT' || (entry !== HTML_DESIGN_ENTRY && entry !== REACT_DESIGN_ENTRY)) throw e;
        const other = otherDesignEntry(entry);
        content = await readFile(await this.filePath(id, other), 'utf8');
        meta = { ...meta, entry: other };
      }
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

  private async storedVersions(id: string): Promise<StoredVersion[]> {
    try {
      const raw = JSON.parse(await readRegular(join(this.dirOf(id), VERSIONS_DIR, 'versions.json')));
      const r = VersionsFile.safeParse(raw);
      return r.success ? r.data : [];
    } catch {
      return [];
    }
  }

  async versions(id: string): Promise<ArtifactVersion[]> {
    return (await this.storedVersions(id)).map((v) => ArtifactVersion.parse(v)).sort((a, b) => b.version - a.version);
  }

  /** The entry file's text of an older version (History). */
  async readVersion(id: string, version: number): Promise<string> {
    const meta = this.metaFromIndex(id);
    if (!Number.isInteger(version) || version < 1) throw new Error('Bad version');
    const stored = (await this.storedVersions(id)).find((v) => v.version === version)?.entry;
    const current = safeEntry(meta);
    const candidates = [
      ...(stored && isSafeArtifactPath(stored) ? [stored] : []),
      current,
      ...(meta.kind === 'design' ? [HTML_DESIGN_ENTRY, REACT_DESIGN_ENTRY] : [ENTRY_FILES[meta.kind]]),
    ];
    let last: unknown;
    for (const entry of [...new Set(candidates)]) {
      try {
        return await readFile(await this.filePath(id, entry, version), 'utf8');
      } catch (e) {
        last = e;
      }
    }
    throw last;
  }

  /** Files of the current version, or of `version`, sorted by path. `text` decides how `readFile` returns each. */
  async files(id: string, version?: number): Promise<ArtifactFile[]> {
    const meta = this.metaFromIndex(id);
    if (version !== undefined && (!Number.isInteger(version) || version < 1 || version > meta.version)) throw new Error('Bad version');
    if (meta.version === 0) return [];
    const dir = this.dirOf(id);
    const base = version === undefined ? dir : await this.guard(() => resolveInside(dir, [VERSIONS_DIR, String(version)], { reservedTop: VERSIONS_DIR }));
    const list = version === undefined ? await this.rootFiles(dir) : await walkFolder(base, { unsafe: 'skip' });
    const out: ArtifactFile[] = [];
    for (const f of list.slice(0, ARTIFACT_LIMITS.files * 4)) out.push({ path: f.path, size: f.size, text: await this.sniffText(f) });
    return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  /** Text by extension, then by the first 64 KB (a big file is not read whole to list it). */
  private async sniffText(f: WalkedFile): Promise<boolean> {
    if (!isTextFile(f.path, new Uint8Array())) return false;
    if (f.size === 0) return true;
    const h = await open(f.abs, 'r');
    try {
      const buf = Buffer.alloc(Math.min(SNIFF_BYTES, f.size));
      const { bytesRead } = await h.read(buf, 0, buf.length, 0);
      return isTextFile(f.path, buf.subarray(0, bytesRead), bytesRead < f.size);
    } finally {
      await h.close();
    }
  }

  /** One file of the current version, or of `version`: UTF-8 text, or base64 for anything else. */
  async readFile(id: string, path: string, version?: number): Promise<ArtifactFileContent> {
    const meta = this.metaFromIndex(id);
    if (meta.version === 0) throw new ArtifactError(`${meta.title} has no files yet.`, 'invalid_input', 'no_content');
    if (version !== undefined && (!Number.isInteger(version) || version < 1 || version > meta.version)) throw new Error('Bad version');
    const file = await this.filePath(id, path, version);
    const st = await lstat(file).catch(() => undefined);
    if (!st?.isFile()) throw new Error(`Unknown artifact file ${path}`);
    if (st.size > ARTIFACT_LIMITS.fileBytes) throw new ArtifactError(`${path} is larger than ${mb(ARTIFACT_LIMITS.fileBytes)}.`, 'invalid_input', 'too_large');
    const bytes = await readFile(file);
    return isTextFile(path, bytes) ? { encoding: 'utf8', data: bytes.toString('utf8') } : { encoding: 'base64', data: bytes.toString('base64') };
  }

  /* -------------------------------------------------------------- write */

  /** A new folder (unique slug) with `artifact.json` at version 0 and no files; not indexed yet. */
  private async newFolder(input: { title: string; kind: ArtifactKind; projectId?: string; location?: 'repo' | 'app-data'; importedFrom?: string; entry?: string }, internal?: Internal): Promise<{ dir: string; meta: ArtifactMeta }> {
    const location = input.location ?? 'app-data';
    const title = cleanTitle(input.title) ?? 'Untitled';
    const root = this.root(location, input.projectId);
    await mkdir(root, { recursive: true });
    const base = slugifyTitle(title);
    let slug = base;
    for (let n = 2; existsSync(join(root, slug)); n++) slug = `${base}-${n}`;
    const dir = join(root, slug);
    await mkdir(join(dir, VERSIONS_DIR), { recursive: true });
    const ts = this.now();
    const meta = ArtifactMeta.parse({
      id: newId(),
      slug,
      title,
      kind: input.kind,
      projectId: input.projectId,
      location,
      version: 0,
      entry: input.entry ?? ENTRY_FILES[input.kind],
      fileCount: 0,
      createdAt: ts,
      updatedAt: ts,
      importedFrom: input.importedFrom,
    });
    await writeAtomic(join(dir, VERSIONS_DIR, 'versions.json'), '[]\n');
    await this.writeMeta(dir, meta, internal ?? null);
    return { dir, meta };
  }

  async create(input: CreateArtifactInput, author = 'user'): Promise<ArtifactMeta> {
    const title = cleanTitle(input.title) ?? 'Untitled';
    let content = input.content ?? defaultContent(input.kind, title);
    if (input.kind === 'doc') content = withFrontMatter(content, { title, ...(input.importedFrom ? { importedFrom: input.importedFrom } : {}) });
    validateContent(input.kind, content);
    const entry = input.kind === 'design' && input.content !== undefined ? designEntryFor(input.content) : ENTRY_FILES[input.kind];
    const bytes = Buffer.from(content, 'utf8');
    const plan: Plan = new Map([[foldPath(entry), { path: entry, size: bytes.length, bytes }]]);
    return this.createFromPlan({ ...input, title }, plan, entry, author);
  }

  /** A new artifact whose first version is `plan` (checked before anything is created). */
  private async createFromPlan(
    input: { title: string; kind: ArtifactKind; projectId?: string; location?: 'repo' | 'app-data'; importedFrom?: string },
    plan: Plan,
    entry: string,
    author: string,
  ): Promise<ArtifactMeta> {
    checkPlan(plan);
    const exact = await checkEntry(input.kind, entry, plan);
    const { dir, meta: draft } = await this.newFolder({ ...input, entry: exact });
    try {
      this.index(draft, dir);
      return await this.withLock(draft.id, () => this.commit(draft, plan, { entry: exact, author, note: 'Created', change: 'created' }));
    } catch (e) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      this.d.db.prepare('DELETE FROM artifacts WHERE id = ?').run(draft.id);
      throw e;
    }
  }

  /**
   * A linked artifact at version 0, waiting for an agent to retrieve its files (ADR 0014). The title
   * and kind given here are the user's; when they gave none, oIDE's guesses may be replaced by the
   * first retrieval.
   */
  async createLinked(input: { url: string; title?: string; kind?: ArtifactKind; projectId?: string; location?: 'repo' | 'app-data' }, author = 'user'): Promise<ArtifactMeta> {
    const importedFrom = claudeImportUrl(input.url);
    const title = cleanTitle(input.title);
    const kind = input.kind ?? 'design';
    const internal: Internal = { ...(title ? {} : { autoTitle: true }), ...(input.kind ? {} : { autoKind: true }) };
    const { dir, meta } = await this.newFolder(
      { title: title ?? 'Imported from claude.ai', kind, importedFrom, ...(input.projectId ? { projectId: input.projectId } : {}), ...(input.location ? { location: input.location } : {}) },
      internal,
    );
    this.index(meta, dir);
    this.onChange?.(meta.id, { change: 'created', version: 0, author });
    return meta;
  }

  /** Save new content of the entry file as the next numbered version (the other files stay). */
  async save(id: string, content: string, opts: SaveOptions = {}): Promise<ArtifactMeta> {
    return this.withLock(id, async () => {
      const cur = this.metaFromIndex(id);
      if (opts.baseVersion !== undefined && opts.baseVersion !== cur.version) {
        throw new ArtifactError(`${cur.title} changed since you opened it (now v${cur.version}, you started from v${opts.baseVersion}).`, 'conflict');
      }
      validateContent(cur.kind, content);
      const plan = await this.currentPlan(cur);
      let entry = safeEntry(cur);
      // A single-file design follows its content: React source is stored as App.jsx, HTML as index.html.
      const singleDesign = cur.kind === 'design' && [...plan.values()].every((f) => f.path === HTML_DESIGN_ENTRY || f.path === REACT_DESIGN_ENTRY);
      if (singleDesign) {
        plan.delete(foldPath(HTML_DESIGN_ENTRY));
        plan.delete(foldPath(REACT_DESIGN_ENTRY));
        entry = designEntryFor(content);
      } else if (cur.version === 0 && !plan.size) entry = cur.kind === 'design' ? designEntryFor(content) : entryFileOf(cur.kind);
      const bytes = Buffer.from(content, 'utf8');
      plan.set(foldPath(entry), { path: entry, size: bytes.length, bytes });
      return this.commit(cur, plan, { entry, author: opts.author ?? 'user', ...(opts.note ? { note: opts.note } : {}) });
    });
  }

  /**
   * Write and delete files as one new version (the viewer's Files panel, the MCP `artifacts_write`).
   * `entry` moves the entry; deleting the entry needs a new one. `baseVersion` refuses with `conflict`.
   */
  async writeFiles(id: string, change: WriteFilesChange): Promise<ArtifactMeta> {
    const decoded = (change.files ?? []).map((f) => ({ path: f.path, bytes: f.encoding === 'base64' ? decodeBase64(f.data, f.path) : Buffer.from(f.data, 'utf8') }));
    return this.withLock(id, async () => {
      const cur = this.metaFromIndex(id);
      if (change.baseVersion !== undefined && change.baseVersion !== cur.version) {
        throw new ArtifactError(`${cur.title} changed since you opened it (now v${cur.version}, you started from v${change.baseVersion}).`, 'conflict');
      }
      if (!decoded.length && !change.deletes?.length && (change.entry === undefined || change.entry === cur.entry)) {
        throw new ArtifactError('Nothing to write: give files, deletes or a new entry.', 'invalid_input', 'no_content');
      }
      const plan = await this.currentPlan(cur);
      for (const p of change.deletes ?? []) {
        if (!isSafeArtifactPath(p)) throw new ArtifactError(`"${p}" is not a valid file path inside an artifact.`, 'invalid_input', 'bad_path');
        if (!plan.delete(foldPath(p))) throw new ArtifactError(`${p} is not one of the artifact's files.`, 'invalid_input', 'bad_path');
      }
      const seen = new Set<string>();
      for (const f of decoded) {
        if (!isSafeArtifactPath(f.path)) throw new ArtifactError(`"${f.path}" is not a valid file path inside an artifact.`, 'invalid_input', 'bad_path');
        const key = foldPath(f.path);
        if (seen.has(key)) throw new ArtifactError(`${f.path} is given twice.`, 'invalid_input', 'bad_path');
        seen.add(key);
        plan.set(key, { path: f.path, size: f.bytes.length, bytes: f.bytes });
      }
      let entry = change.entry;
      if (entry === undefined) {
        const cur0 = safeEntry(cur);
        entry = plan.has(foldPath(cur0)) ? cur0 : cur.version === 0 ? pickEntry(cur.kind, [...plan.values()].map((f) => f.path)) : undefined;
        if (!entry) throw new ArtifactError(`The entry file ${cur0} would be gone: choose another entry.`, 'invalid_input', 'no_content');
      }
      return this.commit(cur, plan, { entry, author: change.author ?? 'user', ...(change.note ? { note: change.note } : {}) });
    });
  }

  /**
   * History > Restore: the full snapshot of `version` (every file, and the entry it had) becomes the
   * next version, noted `Restored v<n>`. It goes through `commit`, so the limits, the path and entry
   * checks, the exclusive no-link writes and the root sync all apply; the per-artifact lock and the
   * `baseVersion` conflict check are the ones `save` uses. Nothing changes when it is refused.
   */
  async restore(id: string, version: number, opts: { author?: string; baseVersion?: number } = {}): Promise<ArtifactMeta> {
    return this.withLock(id, async () => {
      const cur = this.metaFromIndex(id);
      if (opts.baseVersion !== undefined && opts.baseVersion !== cur.version) {
        throw new ArtifactError(`${cur.title} changed since you opened it (now v${cur.version}, you started from v${opts.baseVersion}).`, 'conflict');
      }
      if (!Number.isInteger(version) || version < 1 || version > cur.version) {
        throw new ArtifactError(`${cur.title} has no v${version}.`, 'invalid_input', 'no_content');
      }
      const dir = this.dirOf(id);
      const snap = await this.guard(() => resolveInside(dir, [VERSIONS_DIR, String(version)], { reservedTop: VERSIONS_DIR }));
      const files = await this.guard(() => walkFolder(snap, { unsafe: 'throw', max: ARTIFACT_LIMITS.files + 1 })).catch((e: Error) => {
        throw new ArtifactError(e.message, 'invalid_input', 'bad_path');
      });
      if (!files.length) throw new ArtifactError(`v${version} has no files to restore.`, 'invalid_input', 'no_content');
      const plan = this.planOf(files);
      // The entry that version had; older folders without it fall back to the current one, then to the kind's pick.
      const stored = (await this.storedVersions(id)).find((v) => v.version === version)?.entry;
      const paths = files.map((f) => f.path);
      const entry = [stored, safeEntry(cur), ...(cur.kind === 'design' ? [HTML_DESIGN_ENTRY, REACT_DESIGN_ENTRY] : [ENTRY_FILES[cur.kind]])].find((e): e is string => !!e && isSafeArtifactPath(e) && plan.has(foldPath(e))) ?? pickEntry(cur.kind, paths);
      if (!entry) throw new ArtifactError(`v${version} has no file that can open the ${cur.kind}.`, 'invalid_input', 'wrong_kind');
      return this.commit(cur, plan, { entry, author: opts.author ?? 'user', note: `Restored v${version}` });
    });
  }

  /**
   * Replace every file with the files under `srcDir` (a retrieval's staging folder, outside the
   * artifact) as one new version, and record the retrieval as finished. On the first retrieval the
   * agent's title and kind apply when the user gave none. Nothing changes when it is refused.
   */
  async commitFolder(id: string, srcDir: string, o: CommitFolderOptions): Promise<ArtifactMeta> {
    return this.withLock(id, async () => {
      const cur = this.metaFromIndex(id);
      const internal = await this.readInternal(this.dirOf(id));
      const files = await this.guard(() => walkFolder(srcDir, { unsafe: 'throw' })).catch((e: Error) => {
        throw new ArtifactError(e.message, 'invalid_input', 'bad_path');
      });
      if (!files.length) throw new ArtifactError('No files were handed over.', 'invalid_input', 'no_content');
      const plan = this.planOf(files);
      const paths = files.map((f) => f.path);
      let kind = cur.kind;
      if (internal.autoKind) kind = o.kind ?? (o.entry ? kindOfEntry(o.entry) : undefined) ?? (pickEntry(cur.kind, paths) ? cur.kind : (['design', 'doc', 'whiteboard'] as const).find((k) => pickEntry(k, paths))) ?? cur.kind;
      // Files handed over by an agent never make a board: boards change only through their operations
      // (ADR 0022), which keep comment authors and agent links honest.
      if (kind === 'board') throw new ArtifactError('A retrieval cannot create or replace a kanban board.', 'invalid_input', 'wrong_kind');
      const entry = o.entry ?? pickEntry(kind, paths);
      if (!entry) throw new ArtifactError(`None of the files can open the ${kind}: ${kind === 'design' ? 'no HTML page or React component' : kind === 'doc' ? 'no Markdown file' : 'no Excalidraw file'}.`, 'invalid_input', 'wrong_kind');
      const title = internal.autoTitle ? (cleanTitle(o.title) ?? cur.title) : cur.title;
      return this.commit(cur, plan, { entry, author: o.author, note: o.note, kind, title, patch: { retrieval: o.retrieval }, internal: null });
    });
  }

  /** Record the retrieval state (no new version). */
  async setRetrieval(id: string, retrieval: ArtifactRetrieval | undefined): Promise<ArtifactMeta> {
    return this.withLock(id, async () => {
      const cur = this.metaFromIndex(id);
      const { retrieval: _old, ...rest } = cur;
      void _old;
      const meta = ArtifactMeta.parse({ ...rest, ...(retrieval ? { retrieval } : {}), updatedAt: this.now() });
      const dir = this.dirOf(id);
      await this.writeMeta(dir, meta);
      this.index(meta, dir);
      this.onChange?.(id, { change: 'retrieval', version: meta.version });
      return this.flagBroken(meta);
    });
  }

  /** The current version's files as a plan whose entries are all unchanged. */
  private async currentPlan(cur: ArtifactMeta): Promise<Plan> {
    if (cur.version === 0) return new Map();
    const plan = this.planOf(await this.rootFiles(this.dirOf(cur.id)));
    for (const f of plan.values()) f.unchanged = true;
    return plan;
  }

  private planOf(files: WalkedFile[]): Plan {
    const plan: Plan = new Map();
    for (const f of files) {
      const key = foldPath(f.path);
      const other = plan.get(key)?.path;
      if (other !== undefined) throw new ArtifactError(other === f.path ? `Two files are named ${f.path}.` : `${f.path} and ${other} differ only in case.`, 'invalid_input', 'bad_path');
      plan.set(key, { path: f.path, size: f.size, from: f.abs });
    }
    return plan;
  }

  /**
   * Write `plan` as version `cur.version + 1`: the full snapshot first (`.versions/<n>/`, renamed into
   * place when complete), then versions.json, then `artifact.json` and the index, then the root is
   * brought in line (a marker lets rescan finish that after a crash). Runs under the artifact's lock.
   */
  private async commit(
    cur: ArtifactMeta,
    plan: Plan,
    o: { entry: string; author: string; note?: string; kind?: ArtifactKind; title?: string; patch?: Partial<ArtifactMeta>; internal?: Internal | null; change?: 'created' | 'saved' },
  ): Promise<ArtifactMeta> {
    const id = cur.id;
    const kind = o.kind ?? cur.kind;
    checkPlan(plan);
    const entry = await checkEntry(kind, o.entry, plan);
    const dir = this.dirOf(id);
    const version = cur.version + 1;
    const ts = this.now();
    // Every file the root will get must resolve inside the folder (no link on the way) before anything is written.
    for (const f of plan.values()) if (!f.unchanged) await this.guard(() => resolveInside(dir, f.path.split('/')));
    const versionsDir = await this.guard(() => resolveInside(dir, [VERSIONS_DIR], { reservedTop: VERSIONS_DIR }));
    await mkdir(versionsDir, { recursive: true });
    const final = await this.guard(() => resolveInside(dir, [VERSIONS_DIR, String(version)], { reservedTop: VERSIONS_DIR }));
    // A folder for this number can only be a leftover of an attempt that never committed.
    await rm(final, { recursive: true, force: true });
    const tmp = join(versionsDir, `.tmp-${version}-${process.pid}-${Math.random().toString(36).slice(2)}`);
    await mkdir(tmp);
    try {
      for (const f of plan.values()) {
        const dest = join(tmp, ...f.path.split('/'));
        await mkdir(dirname(dest), { recursive: true });
        // A fresh folder of ours, but still exclusive: nothing already there is ever written through.
        if (f.bytes) await writeFile(dest, f.bytes, { flag: 'wx' });
        else await copyFile(f.from!, dest, constants.COPYFILE_FICLONE | constants.COPYFILE_EXCL);
      }
      await rename(tmp, final);
    } catch (e) {
      await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
      throw e;
    }
    const versions = (await this.storedVersions(id)).filter((v) => v.version < version);
    versions.push(StoredVersion.parse({ version, ts, author: o.author, ...(o.note ? { note: o.note } : {}), entry }));
    versions.sort((a, b) => a.version - b.version);
    await writeAtomic(join(versionsDir, 'versions.json'), JSON.stringify(versions, null, 2) + '\n');
    await writeAtomic(join(versionsDir, SYNC_MARKER), String(version));
    const { brokenImport: _derived, ...base } = cur;
    void _derived;
    const meta = ArtifactMeta.parse({ ...base, ...o.patch, kind, title: o.title ?? cur.title, entry, version, fileCount: plan.size, updatedAt: ts });
    await this.writeMeta(dir, meta, o.internal);
    this.index(meta, dir);
    await this.syncRoot(dir, version, plan);
    await rm(join(versionsDir, SYNC_MARKER), { force: true });
    if (kind === 'board') await this.pruneVersions(dir, versionsDir, versions, version - this.boardKeep).catch(() => undefined);
    this.onChange?.(id, { change: o.change ?? 'saved', version, author: o.author });
    return meta;
  }

  /**
   * Boards (ADR 0022): drop the snapshots of versions at or below `upTo`, then their entries in
   * versions.json. A failure leaves extra snapshots behind, never a missing current one.
   */
  private async pruneVersions(dir: string, versionsDir: string, versions: StoredVersion[], upTo: number): Promise<void> {
    if (upTo < 1) return;
    const old = versions.filter((v) => v.version <= upTo);
    if (!old.length) return;
    await writeAtomic(join(versionsDir, 'versions.json'), JSON.stringify(versions.filter((v) => v.version > upTo), null, 2) + '\n');
    for (const v of old) {
      const snap = await this.guard(() => resolveInside(dir, [VERSIONS_DIR, String(v.version)], { reservedTop: VERSIONS_DIR }));
      await rm(snap, { recursive: true, force: true });
    }
  }

  /**
   * Make the folder's root hold exactly the files of `.versions/<version>/`: files that go (or change
   * case) are deleted first, so a case-insensitive file system never loses a new file; then new and
   * changed files are copied in atomically. `plan` says which files are already there unchanged.
   */
  private async syncRoot(dir: string, version: number, plan?: Plan): Promise<void> {
    const snap = await this.guard(() => resolveInside(dir, [VERSIONS_DIR, String(version)], { reservedTop: VERSIONS_DIR }));
    const want = plan ?? this.planOf(await walkFolder(snap, { unsafe: 'skip' }));
    const have = await this.rootFiles(dir);
    const touched = new Set<string>();
    for (const h of have) {
      const w = want.get(foldPath(h.path));
      if (w && w.path === h.path) continue;
      await rm(h.abs, { force: true });
      touched.add(dirname(h.abs));
    }
    for (const w of want.values()) {
      if (w.unchanged && plan) continue;
      const parts = w.path.split('/');
      const dest = await this.guard(() => resolveInside(dir, parts));
      await mkdir(dirname(dest), { recursive: true });
      await copyAtomic(join(snap, ...parts), dest);
    }
    // Folders emptied by deletions go too (deepest first).
    const root = dir.replace(/[\\/]+$/, '');
    for (const d of [...touched].sort((a, b) => b.length - a.length)) {
      for (let cur = d; cur.length > root.length && cur.startsWith(root); cur = dirname(cur)) {
        try {
          await rmdir(cur);
        } catch {
          break;
        }
      }
    }
  }

  /**
   * New title. The folder (slug) stays as it is, so repo links, git history and agents that hold the
   * id keep working; only `artifact.json` and the index change. Does not create a version. A title
   * the user gives is theirs: a later retrieval no longer replaces it.
   */
  async rename(id: string, title: string): Promise<ArtifactMeta> {
    const next = title.replace(/\s+/g, ' ').trim();
    if (!next) throw new ArtifactError('Give the artifact a title.', 'invalid_input');
    if (next.length > MAX_TITLE_LENGTH) throw new ArtifactError(`Titles can be at most ${MAX_TITLE_LENGTH} characters.`, 'invalid_input');
    return this.withLock(id, async () => {
      const cur = this.metaFromIndex(id);
      const dir = this.dirOf(id);
      const internal = await this.readInternal(dir);
      if (cur.title === next && !internal.autoTitle) return this.flagBroken(cur);
      const meta = ArtifactMeta.parse({ ...cur, title: next, updatedAt: this.now() });
      await this.writeMeta(dir, meta, { ...internal, autoTitle: false });
      this.index(meta, dir);
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
   * "Import from claude.ai" with pasted content. claude.ai has no public API for artifact content, and
   * oIDE never uses the user's claude.ai sign-in, so main cannot fetch it: the user pastes the content
   * they copied on claude.ai (`content`), and the link is kept as `importedFrom` (Open in claude.ai).
   * A link alone goes through `createLinked` and an agent instead (ADR 0014). The kind follows the
   * content when none is given. Everything is checked before anything is created.
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

  /**
   * New artifact from files on disk (ADR 0014): picked files (each at the top, by its name) or a
   * picked folder (its files, recursively, keeping relative paths; links and `.git` are skipped).
   * One picked text file of a known type is imported as before (`importFile`). The kind and entry
   * follow the files unless given. Limits and names are checked before anything is created.
   */
  async importFiles(
    input: { filePaths?: string[]; folderPath?: string; entry?: string; url?: string; title?: string; kind?: ArtifactKind; projectId?: string; location?: 'repo' | 'app-data' },
    author = 'user',
  ): Promise<ArtifactMeta> {
    const importedFrom = input.url ? claudeImportUrl(input.url) : undefined;
    const where = { ...(input.projectId ? { projectId: input.projectId } : {}), ...(input.location ? { location: input.location } : {}) };
    const filePaths = input.filePaths ?? [];
    if (!input.folderPath && filePaths.length === 1 && !input.entry && inferKind(filePaths[0]!)) {
      return this.importFile({ filePath: filePaths[0]!, ...(input.url ? { url: input.url } : {}), ...(input.title ? { title: input.title } : {}), ...(input.kind ? { kind: input.kind } : {}), ...where }, author);
    }
    let files: WalkedFile[];
    if (input.folderPath) {
      const st = await lstat(input.folderPath);
      if (!st.isDirectory()) throw new ArtifactError('Pick a folder.', 'invalid_input', 'no_content');
      files = await walkFolder(input.folderPath, { skipGit: true, unsafe: 'throw', max: ARTIFACT_LIMITS.files + 1 }).catch((e: Error) => {
        throw e instanceof ArtifactPathError ? new ArtifactError(e.message, 'invalid_input', 'bad_path') : e;
      });
    } else {
      files = [];
      for (const p of filePaths) {
        const st = await lstat(p);
        if (st.isSymbolicLink() || !st.isFile()) throw new ArtifactError(`${basename(p)} is not a regular file.`, 'invalid_input', 'bad_path');
        files.push({ path: basename(p), abs: p, size: st.size });
      }
    }
    if (!files.length) throw new ArtifactError('There are no files to import.', 'invalid_input', 'no_content');
    const plan = this.planOf(files);
    checkPlan(plan);
    const paths = files.map((f) => f.path);
    let kind = input.kind ?? (input.entry ? kindOfEntry(input.entry) : undefined);
    if (!kind) kind = (['design', 'doc', 'board', 'whiteboard'] as const).find((k) => pickEntry(k, paths));
    if (!kind) throw new ArtifactError('None of the files can open as an artifact: add an HTML page, a React component, a Markdown file or an Excalidraw file.', 'invalid_input', 'wrong_kind');
    const entry = input.entry ?? pickEntry(kind, paths);
    if (!entry) throw new ArtifactError(`None of the files can open the ${kind}.`, 'invalid_input', 'wrong_kind');
    const entryFile = plan.get(foldPath(entry));
    let title = cleanTitle(input.title);
    if (!title && entryFile && kind !== 'whiteboard' && entryFile.size <= 256 * 1024) {
      const bytes = await bytesOf(entryFile);
      if (isTextBytes(bytes)) title = titleFromContent(kind, bytes.toString('utf8'));
    }
    title ??= input.folderPath ? basename(input.folderPath) : basename(entry, extname(entry));
    return this.createFromPlan({ title, kind, ...where, ...(importedFrom ? { importedFrom } : {}) }, plan, entry, author);
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

  /* ------------------------------------------------- boards (ADR 0022) */

  /**
   * Apply board operations as one new version, under the artifact's lock: the current board is read,
   * changed and written in one step, so a user's drag and an agent's update never overwrite each
   * other. All or nothing: an operation that cannot apply refuses the batch (`invalid_input`, with the
   * reason) and nothing is written. The version note says what changed ("Moved "X" to In review").
   */
  async updateBoard(id: string, ops: readonly BoardOp[], ctx: BoardOpContext): Promise<{ meta: ArtifactMeta; board: KanbanBoard; results: BoardOpResult[] }> {
    return this.withLock(id, async () => {
      const cur = this.metaFromIndex(id);
      if (cur.kind !== 'board') throw new ArtifactError(`${cur.title} is a ${cur.kind}, not a board.`, 'invalid_input', 'wrong_kind');
      if (cur.version === 0) throw new ArtifactError(`${cur.title} has no files yet.`, 'invalid_input', 'no_content');
      const entry = safeEntry(cur);
      let before: KanbanBoard;
      let after: { board: KanbanBoard; results: BoardOpResult[] };
      try {
        before = parseBoard(await readFile(await this.filePath(id, entry), 'utf8'));
        after = applyBoardOps(before, ops, { ...ctx, now: ctx.now ?? this.now });
      } catch (e) {
        if (e instanceof ArtifactError || (e as NodeJS.ErrnoException).code) throw e;
        throw new ArtifactError((e as Error).message, 'invalid_input', 'wrong_kind');
      }
      const plan = await this.currentPlan(cur);
      const bytes = Buffer.from(serializeBoard(after.board), 'utf8');
      plan.set(foldPath(entry), { path: entry, size: bytes.length, bytes });
      const note = describeBoardOps(before, after.board, ops, after.results);
      const meta = await this.commit(cur, plan, { entry, author: ctx.author, ...(note ? { note } : {}) });
      if (ctx.author.startsWith('agent:')) this.recordUse(id, ctx.author.slice('agent:'.length), 'write');
      return { meta, board: after.board, results: after.results };
    });
  }

  /** The board of a board artifact (parsed and checked). */
  async readBoard(id: string): Promise<{ meta: ArtifactMeta; board: KanbanBoard }> {
    const { meta, content } = await this.read(id);
    if (meta.kind !== 'board') throw new ArtifactError(`${meta.title} is a ${meta.kind}, not a board.`, 'invalid_input', 'wrong_kind');
    if (meta.version === 0) throw new ArtifactError(`${meta.title} has no files yet.`, 'invalid_input', 'no_content');
    try {
      return { meta, board: parseBoard(content) };
    } catch (e) {
      throw new ArtifactError((e as Error).message, 'invalid_input', 'wrong_kind');
    }
  }

  /* ------------------------------------------------- ArtifactsBackend (MCP) */

  async write(id: string, content: string, agentId: string): Promise<ArtifactMeta> {
    const meta = await this.save(id, content, { author: `agent:${agentId}` });
    this.recordUse(id, agentId, 'write');
    return meta;
  }

  /** `writeFiles` as called by the MCP tool: author is the agent; the use is logged. */
  async writeFilesForAgent(id: string, change: Omit<WriteFilesChange, 'author' | 'baseVersion'>, agentId: string): Promise<ArtifactMeta> {
    const meta = await this.writeFiles(id, { ...change, author: `agent:${agentId}` });
    this.recordUse(id, agentId, 'write');
    return meta;
  }

  /** `create` as called by the MCP tool: author is the agent; the use is logged. Files make a multi-file artifact. */
  async createForAgent(
    input: { title: string; kind: ArtifactKind; content?: string; projectId?: string; location?: 'repo' | 'app-data'; files?: ArtifactFileWrite[]; entry?: string },
    agentId: string,
  ): Promise<ArtifactMeta> {
    const location = input.location ?? 'app-data';
    let meta: ArtifactMeta;
    if (input.files?.length) {
      const plan: Plan = new Map();
      for (const f of input.files) {
        if (!isSafeArtifactPath(f.path)) throw new ArtifactError(`"${f.path}" is not a valid file path inside an artifact.`, 'invalid_input', 'bad_path');
        const bytes = f.encoding === 'base64' ? decodeBase64(f.data, f.path) : Buffer.from(f.data, 'utf8');
        const key = foldPath(f.path);
        if (plan.has(key)) throw new ArtifactError(`${f.path} is given twice.`, 'invalid_input', 'bad_path');
        plan.set(key, { path: f.path, size: bytes.length, bytes });
      }
      if (input.content !== undefined) {
        const entry = input.entry ?? ENTRY_FILES[input.kind];
        const bytes = Buffer.from(input.content, 'utf8');
        plan.set(foldPath(entry), { path: entry, size: bytes.length, bytes });
      }
      const entry = input.entry ?? pickEntry(input.kind, [...plan.values()].map((f) => f.path));
      if (!entry) throw new ArtifactError(`None of the files can open the ${input.kind}: give entry.`, 'invalid_input', 'wrong_kind');
      meta = await this.createFromPlan({ title: input.title, kind: input.kind, location, ...(input.projectId ? { projectId: input.projectId } : {}) }, plan, entry, `agent:${agentId}`);
    } else {
      meta = await this.create({ title: input.title, kind: input.kind, location, ...(input.content !== undefined ? { content: input.content } : {}), ...(input.projectId ? { projectId: input.projectId } : {}) }, `agent:${agentId}`);
    }
    this.recordUse(meta.id, agentId, 'create');
    return meta;
  }

  /** The backend view the MCP server takes (`list`, `read`, `write`, `create`, files, with agent attribution). */
  backend(): ArtifactsBackend {
    return {
      list: (filter, agentId) => this.list(filter, agentId),
      read: (id, agentId) => this.read(id, agentId),
      write: (id, content, agentId) => this.write(id, content, agentId),
      create: (input, agentId) => this.createForAgent(input, agentId),
      files: (id) => this.files(id),
      readFile: (id, path) => this.readFile(id, path),
      writeFiles: (id, change, agentId) => this.writeFilesForAgent(id, change, agentId),
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
