import { realpathSync } from 'node:fs';
import { dirname, basename, isAbsolute, join, resolve, sep } from 'node:path';

/**
 * Path guard for every file path that arrives from the renderer.
 *
 * `assertInside(root, candidate)` resolves `..`, relative segments and symlinks (for the longest
 * existing prefix of the candidate, so paths that do not exist yet can still be checked), and
 * throws unless the result sits inside `root` (or is `root` itself). Comparison is
 * case-insensitive on win32 and darwin, whose default filesystems are case-insensitive.
 */

export class PathOutsideRootError extends Error {
  readonly code = 'forbidden_path';
  constructor(
    readonly root: string,
    readonly candidate: string,
  ) {
    super(`Path is outside the allowed folder: ${candidate}`);
    this.name = 'PathOutsideRootError';
  }
}

export interface PathGuardOptions {
  /** Defaults to `process.platform`. */
  platform?: NodeJS.Platform;
}

function caseInsensitive(platform: NodeJS.Platform): boolean {
  return platform === 'win32' || platform === 'darwin';
}

/** realpath of the longest existing prefix, with the non-existing tail re-appended. */
export function resolveReal(p: string): string {
  const abs = resolve(p);
  const tail: string[] = [];
  let cur = abs;
  for (;;) {
    try {
      const real = realpathSync.native(cur);
      return tail.length ? join(real, ...tail.reverse()) : real;
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return abs; // nothing exists (e.g. missing drive); fall back to lexical
      tail.push(basename(cur));
      cur = parent;
    }
  }
}

function normalizeForCompare(p: string, platform: NodeJS.Platform): string {
  let out = p;
  // Strip trailing separators except for a filesystem root ("C:\" or "/").
  while (out.length > 1 && (out.endsWith('/') || out.endsWith('\\')) && !/^[A-Za-z]:[\\/]$/.test(out)) {
    out = out.slice(0, -1);
  }
  return caseInsensitive(platform) ? out.toLowerCase() : out;
}

/** True when `candidate` (absolute, or relative to `root`) resolves inside `root`. */
export function isInside(root: string, candidate: string, opts: PathGuardOptions = {}): boolean {
  const platform = opts.platform ?? process.platform;
  if (!root || typeof candidate !== 'string' || candidate.includes('\0')) return false;
  const realRoot = resolveReal(root);
  const realCandidate = resolveReal(isAbsolute(candidate) ? candidate : join(realRoot, candidate));
  const r = normalizeForCompare(realRoot, platform);
  const c = normalizeForCompare(realCandidate, platform);
  if (c === r) return true;
  const prefix = r.endsWith(sep) || r.endsWith('/') ? r : r + sep;
  return c.startsWith(prefix);
}

/**
 * Throws `PathOutsideRootError` unless `candidate` is inside `root`.
 * Returns the resolved real path, which callers should use for the actual file operation.
 */
export function assertInside(root: string, candidate: string, opts: PathGuardOptions = {}): string {
  if (!isInside(root, candidate, opts)) throw new PathOutsideRootError(root, candidate);
  const realRoot = resolveReal(root);
  return resolveReal(isAbsolute(candidate) ? candidate : join(realRoot, candidate));
}

/** Like `assertInside` but accepts any of several roots. Returns the matching root and path. */
export function assertInsideAny(
  roots: Iterable<string>,
  candidate: string,
  opts: PathGuardOptions = {},
): { root: string; path: string } {
  for (const root of roots) {
    if (isAbsolute(candidate) && isInside(root, candidate, opts)) return { root, path: assertInside(root, candidate, opts) };
  }
  throw new PathOutsideRootError([...roots].join(', '), candidate);
}
