import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { Parser, x as tarExtract } from 'tar';

export class TarballError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TarballError';
  }
}

export interface TarEntryInfo {
  /** Path inside the package (top folder such as `package/` removed). */
  path: string;
  type: 'File' | 'Directory' | 'SymbolicLink';
  size: number;
  linkpath?: string;
}

export interface TarLimits {
  maxEntries?: number;
  maxTotalBytes?: number;
}

const DEFAULT_LIMITS = { maxEntries: 20_000, maxTotalBytes: 256 * 1024 * 1024 };
const FILE_TYPES = new Set(['File', 'OldFile', 'ContiguousFile']);

function segments(p: string): string[] {
  return p.split(/[\\/]+/).filter((s) => s !== '' && s !== '.');
}

function isAbsoluteish(p: string): boolean {
  return p.startsWith('/') || p.startsWith('\\') || /^[a-zA-Z]:/.test(p) || path.isAbsolute(p);
}

/** Reject an entry path that is absolute, has `..`, a drive or stream colon, or a NUL. */
function checkEntryPath(p: string): void {
  if (!p || p.includes('\0')) throw new TarballError(`Bad entry name in tarball`);
  if (isAbsoluteish(p)) throw new TarballError(`Tarball entry has an absolute path: ${p}`);
  const segs = segments(p);
  if (segs.includes('..')) throw new TarballError(`Tarball entry escapes the package folder: ${p}`);
  if (segs.some((s) => s.includes(':'))) throw new TarballError(`Tarball entry has a ':' in its name: ${p}`);
}

/**
 * Read every header and validate it without writing anything. Throws TarballError on absolute
 * paths, `..`, hard links, symbolic links, devices, FIFOs, more than one
 * top-level folder, or size limits.
 */
export async function inspectTarball(data: Uint8Array, limits: TarLimits = {}): Promise<TarEntryInfo[]> {
  const lim = { ...DEFAULT_LIMITS, ...limits };
  const entries: TarEntryInfo[] = [];
  let problem: Error | null = null;
  let top: string | null = null;
  let total = 0;
  await new Promise<void>((resolve, reject) => {
    const parser = new Parser({
      strict: true,
      onReadEntry: (entry) => {
        try {
          if (problem) return;
          const raw = entry.path;
          checkEntryPath(raw);
          const segs = segments(raw);
          const first = segs[0];
          if (first === undefined) throw new TarballError('Empty entry name in tarball');
          if (top === null) top = first;
          else if (top !== first) throw new TarballError('Tarball has more than one top-level folder');
          const inner = segs.slice(1).join('/');
          const type = FILE_TYPES.has(entry.type) ? 'File' : entry.type;
          if (type === 'Link') throw new TarballError(`Tarball contains a hard link: ${raw}`);
          if (type !== 'File' && type !== 'Directory' && type !== 'SymbolicLink') throw new TarballError(`Tarball contains an unsupported entry (${entry.type}): ${raw}`);
          // Extensions ship bundled dist/ code and never need links. Lexical checks on link targets can be
          // defeated by link chains (a -> sub/x, sub/x -> .., esc -> a/..), so symlinks are refused outright.
          if (type === 'SymbolicLink') throw new TarballError(`Tarball contains a symbolic link: ${raw}`);
          total += entry.size ?? 0;
          if (entries.length + 1 > lim.maxEntries) throw new TarballError('Tarball has too many entries');
          if (total > lim.maxTotalBytes) throw new TarballError('Tarball is too large when unpacked');
          if (inner) {
            const info: TarEntryInfo = { path: inner, type, size: entry.size ?? 0 };
            if (entry.linkpath) info.linkpath = entry.linkpath;
            entries.push(info);
          }
        } catch (e) {
          problem = e as Error;
        } finally {
          entry.resume();
        }
      },
    });
    parser.on('error', (e: Error) => reject(new TarballError(`Not a valid tarball: ${e.message}`)));
    parser.on('end', () => resolve());
    parser.end(Buffer.from(data));
  });
  if (problem) throw problem;
  if (top === null) throw new TarballError('Tarball is empty');
  return entries;
}

/**
 * Validate, then extract into `dest` (replacing it). The single top folder (npm's
 * `package/`) is stripped. Extraction goes to a temp folder next to `dest` and is renamed into
 * place, so a failure never leaves a half-written extension behind.
 */
export async function extractTarball(data: Uint8Array, dest: string, limits: TarLimits = {}): Promise<TarEntryInfo[]> {
  const entries = await inspectTarball(data, limits);
  const parent = path.dirname(path.resolve(dest));
  await mkdir(parent, { recursive: true });
  const tmp = await mkdtemp(path.join(parent, '.extract-'));
  try {
    await new Promise<void>((resolve, reject) => {
      const unpack = tarExtract({
        cwd: tmp,
        strip: 1,
        strict: true,
        preservePaths: false,
        preserveOwner: false,
        filter: (_p, entry) => {
          const t = 'type' in entry ? entry.type : undefined;
          return t === undefined || FILE_TYPES.has(t) || t === 'Directory';
        },
      });
      unpack.on('error', (e: Error) => reject(new TarballError(`Extraction failed: ${e.message}`)));
      unpack.on('close', () => resolve());
      unpack.end(Buffer.from(data));
    });
    await rm(dest, { recursive: true, force: true });
    await rename(tmp, dest);
  } catch (e) {
    await rm(tmp, { recursive: true, force: true });
    throw e;
  }
  return entries;
}
