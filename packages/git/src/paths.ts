import { basename, dirname, join, relative, resolve, sep, isAbsolute } from 'node:path';

/** Case-insensitive file systems by default on Windows and macOS. */
export const CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin';

/** Normalised key for comparing paths: absolute, native separators, case-folded where needed. */
export function pathKey(p: string): string {
  let r = resolve(p);
  if (r.length > 1 && (r.endsWith('/') || r.endsWith('\\'))) r = r.slice(0, -1);
  return CASE_INSENSITIVE ? r.toLowerCase() : r;
}

export function samePath(a: string, b: string): boolean {
  return pathKey(a) === pathKey(b);
}

/** True when `child` is `parent` or sits inside it. */
export function isInside(parent: string, child: string): boolean {
  const rel = relative(pathKey(parent), pathKey(child));
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel));
}

/** Git prints `C:/x/y` on Windows; turn it into a native absolute path. */
export function fromGitPath(p: string): string {
  return resolve(p);
}

/** Folder that holds a project's worktrees for a given location setting. */
export function worktreeRoot(opts: { appDataDir: string; projectId: string; projectPath: string; location: 'app-data' | 'sibling' }): string {
  if (opts.location === 'sibling') {
    const repo = resolve(opts.projectPath);
    return join(dirname(repo), `${basename(repo)}.worktrees`);
  }
  return join(opts.appDataDir, 'worktrees', safeSegment(opts.projectId, 'project id'));
}

/** Reject anything that could escape a folder when used as one path segment. */
export function safeSegment(s: string, what = 'name'): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(s) || s.includes('..') || s.length > 128) {
    throw new Error(`Invalid ${what}: ${JSON.stringify(s)}`);
  }
  return s;
}
