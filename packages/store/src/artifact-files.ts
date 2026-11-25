import { lstat, readdir, realpath } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ARTIFACT_LIMITS, isSafeArtifactPath, type ArtifactKind } from '@oide/protocol';

/**
 * File helpers for multi-file artifacts (ADR 0014): path resolution that never follows a symbolic
 * link, folder walks with limits, text detection and the default entry file. Shared by the store
 * and main (the retrieval staging folder).
 */

/** Extensions that are never text, whatever their bytes look like. */
export const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.bmp', '.ico', '.icns', '.tif', '.tiff', '.heic',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.pdf', '.zip', '.gz', '.tgz', '.br', '.7z', '.rar', '.tar',
  '.mp3', '.mp4', '.m4a', '.mov', '.webm', '.wav', '.ogg', '.flac',
  '.wasm', '.bin', '.exe', '.dll', '.so', '.dylib', '.psd', '.sketch', '.fig',
]);

/** Files oIDE never treats as part of an artifact (OS clutter). */
const JUNK = new Set(['.ds_store', 'thumbs.db', 'desktop.ini']);
/** Leftovers of an interrupted atomic write (`<name>.<pid>.<ms>.<rand>.tmp`). */
const ATOMIC_TMP = /\.\d+\.\d+\.[a-z0-9]+\.tmp$/;
/** oIDE's own names at the top of an artifact folder (case-folded). */
const RESERVED_TOP = new Set(['artifact.json', '.versions', '.staging', '__oide']);

/** Key that treats two paths as the same file on a case-insensitive file system (Windows, macOS). */
export function foldPath(p: string): string {
  return p.normalize('NFC').toLowerCase();
}

/** UTF-8 without NUL bytes. `partial`: the bytes are a prefix, so a cut multi-byte sequence at the end is fine. */
export function isTextBytes(bytes: Uint8Array, partial = false): boolean {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes, partial ? { stream: true } : undefined);
    return true;
  } catch {
    return false;
  }
}

/** Text files are read and written as UTF-8, everything else as base64: by extension, then by content. */
export function isTextFile(path: string, bytes: Uint8Array, partial = false): boolean {
  if (BINARY_EXTENSIONS.has(extname(path).toLowerCase())) return false;
  return isTextBytes(bytes, partial);
}

export class ArtifactPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArtifactPathError';
  }
}

/** A name as Windows and macOS compare it: case-folded, trailing dots and spaces dropped. */
const foldSegment = (s: string) => s.normalize('NFC').toLowerCase().replace(/[. ]+$/, '');

export interface ResolveOptions {
  /**
   * The one reserved top-level name this call may reach (the store's own `.versions`). Every other
   * reserved name (`artifact.json`, `.versions`, `.staging`, `__oide`) is refused, by its spelling and
   * by where it really lands.
   */
  reservedTop?: '.versions';
}

/**
 * Absolute path of `parts` under `root`, refused when it leaves the folder lexically, when the root
 * or any existing component below it is a symbolic link (a cloned repo can commit them), when the
 * real path (or its real parent) is outside the real root, or when it really lands on a reserved
 * top-level name, whatever it was spelled as (a Windows 8.3 short name such as `ARTIFA~1.JSO` is
 * `artifact.json`; the real path's first segment must be the one asked for). Callers check
 * `isSafeArtifactPath` first; this is the file-system half and does not rely on the input string.
 */
export async function resolveInside(root: string, parts: string[], opts: ResolveOptions = {}): Promise<string> {
  const base = resolve(root);
  const file = resolve(base, ...parts);
  const lex = relative(base, file);
  if (!lex || lex.startsWith('..') || isAbsolute(lex)) throw new ArtifactPathError('Path escapes the artifact folder');
  const allowed = opts.reservedTop ? foldSegment(opts.reservedTop) : undefined;
  const reserved = (seg: string) => RESERVED_TOP.has(foldSegment(seg)) && foldSegment(seg) !== allowed;
  const top = lex.split(sep)[0]!;
  if (reserved(top) || /~\d/.test(top)) throw new ArtifactPathError('Path reaches a name oIDE keeps for itself');
  if ((await lstat(base)).isSymbolicLink()) throw new ArtifactPathError('Artifact folder is a symbolic link');
  const realBase = await realpath(base);
  let cur = base;
  for (const part of parts) {
    cur = join(cur, part);
    const st = await lstat(cur).catch(() => undefined);
    if (!st) break; // not created yet; the components checked so far are real
    if (st.isSymbolicLink()) throw new ArtifactPathError('Artifact path contains a symbolic link');
  }
  // Where it really is: the file when it exists, else its parent folder (the last segment is then new).
  const real = (await realpath(file).catch(() => undefined)) ?? (await realpath(dirname(file)).catch(() => undefined));
  if (real) {
    const r = relative(realBase, real);
    if (r.startsWith('..') || isAbsolute(r)) throw new ArtifactPathError('Path escapes the artifact folder');
    const realTop = r.split(sep)[0];
    if (realTop && (reserved(realTop) || foldSegment(realTop) !== foldSegment(top))) throw new ArtifactPathError('Path reaches a name oIDE keeps for itself');
  }
  return file;
}

export interface WalkedFile {
  /** Relative path with forward slashes. */
  path: string;
  abs: string;
  size: number;
}

export interface WalkOptions {
  /** An artifact folder: skip `artifact.json`, `.versions`, `.staging` and `__oide` at the top. */
  artifactRoot?: boolean;
  /** Skip `.git` folders (a picked folder is often a repo). */
  skipGit?: boolean;
  /** Unsafe names: skip them (an artifact folder on disk) or throw (an import the user asked for). */
  unsafe: 'skip' | 'throw';
  /** Stop after this many files (the caller then refuses the set as too big). Default 500 + 1. */
  max?: number;
}

/**
 * Regular files under `root`, recursively, never following symbolic links (they are skipped), with
 * their relative paths. Bounded by depth (16) and `max` files so a hostile folder can't stall it.
 */
export async function walkFolder(root: string, opts: WalkOptions): Promise<WalkedFile[]> {
  const out: WalkedFile[] = [];
  const max = opts.max ?? ARTIFACT_LIMITS.files + 1;
  const visit = async (dir: string, prefix: string, depth: number): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (out.length >= max) return;
      const lower = e.name.toLowerCase();
      if (depth === 0 && opts.artifactRoot && RESERVED_TOP.has(lower.replace(/[. ]+$/, ''))) continue;
      if (e.isSymbolicLink()) continue;
      if (opts.skipGit && lower === '.git') continue;
      if (e.isFile() && (JUNK.has(lower) || ATOMIC_TMP.test(lower))) continue;
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      const abs = join(dir, e.name);
      if (e.isDirectory()) {
        if (depth + 1 >= ARTIFACT_LIMITS.depth || !isSafeArtifactPath(`${rel}/x`)) {
          if (opts.unsafe === 'throw') throw new ArtifactPathError(`"${rel}" can't be part of an artifact (the name or depth is not allowed).`);
          continue;
        }
        await visit(abs, rel, depth + 1);
        continue;
      }
      if (!e.isFile()) continue;
      if (!isSafeArtifactPath(rel)) {
        if (opts.unsafe === 'throw') throw new ArtifactPathError(`"${rel}" can't be part of an artifact (the name is not allowed).`);
        continue;
      }
      const st = await lstat(abs).catch(() => undefined);
      if (!st?.isFile()) continue;
      out.push({ path: rel, abs, size: st.size });
    }
  };
  await visit(root, '', 0);
  return out;
}

const depthOf = (p: string) => p.split('/').length;
const byShallowest = (a: string, b: string) => depthOf(a) - depthOf(b) || (a < b ? -1 : a > b ? 1 : 0);
const first = (paths: string[], test: (p: string) => boolean) => paths.filter(test).sort(byShallowest)[0];

/**
 * The default entry for a kind: a design opens on `index.html` or `App.jsx` at the root, else the
 * shallowest HTML page, else the shallowest JSX/TSX; a doc on `doc.md`, else the first Markdown (then
 * text) file; a whiteboard on the first `.excalidraw`, else the first `.json`. Undefined when none fits.
 */
export function pickEntry(kind: ArtifactKind, paths: string[]): string | undefined {
  const has = (name: string) => paths.find((p) => p === name) ?? paths.find((p) => foldPath(p) === foldPath(name));
  const ext = (p: string) => extname(p).toLowerCase();
  switch (kind) {
    case 'design':
      return has('index.html') ?? has('App.jsx') ?? first(paths, (p) => ext(p) === '.html' || ext(p) === '.htm') ?? first(paths, (p) => ext(p) === '.jsx' || ext(p) === '.tsx');
    case 'doc':
      return has('doc.md') ?? first(paths, (p) => ext(p) === '.md' || ext(p) === '.markdown') ?? first(paths, (p) => ext(p) === '.txt');
    case 'whiteboard':
      return first(paths, (p) => ext(p) === '.excalidraw') ?? first(paths, (p) => ext(p) === '.json');
  }
}

/** The kind an entry file suggests by its extension, or undefined. */
export function kindOfEntry(path: string): ArtifactKind | undefined {
  const e = extname(path).toLowerCase();
  if (['.html', '.htm', '.jsx', '.tsx', '.svg'].includes(e)) return 'design';
  if (['.md', '.markdown', '.txt'].includes(e)) return 'doc';
  if (e === '.excalidraw') return 'whiteboard';
  return undefined;
}

/** True for a React design entry (previewed through the generated page, ADR 0013). */
export function isReactEntry(path: string): boolean {
  return /\.(?:jsx|tsx)$/i.test(path);
}
