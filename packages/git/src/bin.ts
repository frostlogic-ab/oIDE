import { statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';

/**
 * Resolve a bare program name (`git`, `gh`, `node`) to an absolute path from PATH, never from the
 * current or child working directory (review-security SEC-01).
 *
 * On Windows, libuv (and so `execFile`/`spawn`) looks for a bare name in the child's `cwd` before
 * PATH unless `NoDefaultCurrentDirectoryInExePath` is set, so a repository that ships `git.exe` at
 * its root would run as the user. Every spawn of a well-known tool with a repo as cwd therefore uses
 * the absolute path from here. Relative and empty PATH entries (`.`, `bin`, `""`) are skipped: they
 * would resolve against whatever folder the process happens to be in.
 */
export interface FindOptions {
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  /** Windows extensions to try, in order. Default `.exe`, `.com` (what libuv itself runs). */
  exts?: string[];
}

function pathDirs(env: Record<string, string | undefined>, platform: NodeJS.Platform): string[] {
  const raw = env.PATH ?? env.Path ?? env.path ?? Object.entries(env).find(([k]) => k.toUpperCase() === 'PATH')?.[1] ?? '';
  return raw
    .split(platform === 'win32' ? ';' : delimiter)
    .map((d) => d.trim().replace(/^"|"$/g, ''))
    .filter((d) => d.length > 0 && (platform === 'win32' ? isAbsoluteWin(d) : isAbsolute(d)));
}

/** `C:\x` or `\\server\share` (a bare `\x` is drive-relative, so it is refused too). */
function isAbsoluteWin(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p) || /^[\\/]{2}[^\\/]/.test(p);
}

export function findExecutable(name: string, opts: FindOptions = {}): string | undefined {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const exts = platform === 'win32' ? (opts.exts ?? ['.exe', '.com']) : [''];
  for (const dir of pathDirs(env, platform)) {
    for (const ext of exts) {
      const candidate = join(dir, name + ext);
      try {
        const st = statSync(candidate);
        if (st.isFile() && (platform === 'win32' || (st.mode & 0o111) !== 0)) return candidate;
      } catch {
        /* not here */
      }
    }
  }
  return undefined;
}

const cache = new Map<string, string>();

/**
 * Absolute path of a well-known tool, cached per PATH value. Falls back to the bare name only when
 * the tool is not on PATH at all (the spawn then fails with ENOENT, or, on Windows, finds nothing
 * in the cwd because main sets `NoDefaultCurrentDirectoryInExePath`).
 */
export function resolveTool(name: 'git' | 'gh' | 'node' | string, env: Record<string, string | undefined> = process.env): string {
  const key = `${name}\0${env.PATH ?? env.Path ?? ''}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const found = findExecutable(name, { env });
  if (found) cache.set(key, found);
  return found ?? name;
}
