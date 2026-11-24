import { SyncState } from '@oide/protocol';
import { toGit, type Repo } from './git.js';

/** One entry of `git status --porcelain=v2`. */
export interface StatusEntry {
  path: string;
  /** Rename/copy source. */
  origPath?: string;
  /** Two-letter XY code (`.` = unchanged), `??` for untracked, `!!` for ignored. */
  xy: string;
  kind: 'changed' | 'renamed' | 'unmerged' | 'untracked' | 'ignored';
  staged: boolean;
  unstaged: boolean;
}

export interface StatusResult {
  branch: string;
  /** Undefined when detached or unborn. */
  oid?: string;
  detached: boolean;
  upstream?: string;
  ahead: number;
  behind: number;
  entries: StatusEntry[];
}

/**
 * Parse `git status --porcelain=v2 --branch -z` output. Entries are NUL-terminated; rename/copy
 * entries (`2 …`) are followed by an extra NUL-terminated original path.
 */
export function parseStatusV2(text: string): StatusResult {
  const res: StatusResult = { branch: '', detached: false, ahead: 0, behind: 0, entries: [] };
  const parts = text.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i];
    if (!rec) continue;
    if (rec.startsWith('# ')) {
      const [, key, ...rest] = rec.split(' ');
      const value = rest.join(' ');
      if (key === 'branch.oid') res.oid = value === '(initial)' ? undefined : value;
      else if (key === 'branch.head') {
        if (value === '(detached)') {
          res.detached = true;
          res.branch = 'HEAD';
        } else res.branch = value;
      } else if (key === 'branch.upstream') res.upstream = value;
      else if (key === 'branch.ab') {
        const m = /^\+(\d+) -(\d+)$/.exec(value);
        if (m) {
          res.ahead = Number(m[1]);
          res.behind = Number(m[2]);
        }
      }
      continue;
    }
    const type = rec[0];
    if (type === '1') {
      // 1 XY sub mH mI mW hH hI path
      const f = splitN(rec, 9);
      const xy = f[1] ?? '..';
      res.entries.push(entry(f[8] ?? '', xy, 'changed'));
    } else if (type === '2') {
      // 2 XY sub mH mI mW hH hI Xscore path \0 origPath
      const f = splitN(rec, 10);
      const xy = f[1] ?? '..';
      const e = entry(f[9] ?? '', xy, 'renamed');
      e.origPath = parts[++i];
      res.entries.push(e);
    } else if (type === 'u') {
      // u XY sub m1 m2 m3 mW h1 h2 h3 path
      const f = splitN(rec, 11);
      res.entries.push(entry(f[10] ?? '', f[1] ?? 'UU', 'unmerged'));
    } else if (type === '?') {
      res.entries.push({ path: rec.slice(2), xy: '??', kind: 'untracked', staged: false, unstaged: true });
    } else if (type === '!') {
      res.entries.push({ path: rec.slice(2), xy: '!!', kind: 'ignored', staged: false, unstaged: false });
    }
  }
  return res;
}

function entry(path: string, xy: string, kind: StatusEntry['kind']): StatusEntry {
  return { path, xy, kind, staged: kind === 'unmerged' || xy[0] !== '.', unstaged: kind === 'unmerged' || xy[1] !== '.' };
}

/** Split on the first n-1 spaces; the last field keeps any spaces (file paths). */
function splitN(s: string, n: number): string[] {
  const out: string[] = [];
  let start = 0;
  for (let k = 0; k < n - 1; k++) {
    const idx = s.indexOf(' ', start);
    if (idx < 0) break;
    out.push(s.slice(start, idx));
    start = idx + 1;
  }
  out.push(s.slice(start));
  return out;
}

export function toSyncState(s: StatusResult, lastFetchAt?: number): SyncState {
  const dirty = s.entries.filter((e) => e.kind !== 'ignored').map((e) => e.path);
  return SyncState.parse({
    branch: s.branch,
    upstream: s.upstream,
    ahead: s.ahead,
    behind: s.behind,
    dirtyFiles: [...new Set(dirty)],
    lastFetchAt,
  });
}

/** Full porcelain v2 status of a checkout. */
export async function status(repo: Repo): Promise<StatusResult> {
  const git = toGit(repo);
  // GIT_OPTIONAL_LOCKS=0: background status must not take index.lock away from agents.
  const out = await git.out(['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'], { env: { GIT_OPTIONAL_LOCKS: '0' } });
  return parseStatusV2(out);
}

/** `SyncState` for a checkout (branch, upstream, ahead/behind, dirty files). */
export async function syncState(repo: Repo, opts: { lastFetchAt?: number } = {}): Promise<SyncState> {
  return toSyncState(await status(repo), opts.lastFetchAt);
}
