import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { Git, GitError, isInside as lexicallyInside, pathKey, plainFsPromises } from '@oide/git';
import {
  applyReplacements,
  buildSearchRegExp,
  findMatches,
  pathFilter,
  scorePath,
  type ContentFileResult,
  type FileNameMatch,
  type ReplaceFileResult,
  type SearchOptions,
  type SearchResultsEvent,
} from '@oide/protocol';
import { isInside } from '../security/paths.js';

// Not node:fs: in Electron it treats `*.asar` files as folders and keeps them open (@oide/git plain-fs).
const { readdir, readFile, stat, writeFile } = plainFsPromises;

/**
 * Files › quick open and Files › Search in main (wiki: screen-files.md, security.md › Search and
 * replace). Every path handed in has already passed the path guard (`ctx.roots`); every file this
 * module reads or writes is checked again against its root (symlinks out of a checkout are skipped).
 *
 * - `FileIndex`: one list of files per checkout root, from `git ls-files --cached` plus `git status
 *   -uall` (untracked, not ignored; minus deleted), or a folder walk outside git. Built once,
 *   marked dirty by the checkout watchers (GitService.onCheckoutChange) and rebuilt in the background;
 *   queries meanwhile use the previous list. Unwatched roots (untrusted projects) refresh after 30 s.
 * - `ContentSearch`: `git grep -l` (hardened runner, `-e <pattern>` after the flags, `--` after it,
 *   no shell) finds candidate tracked files, and the index's untracked files are added; each is then read here (size and
 *   binary checks), matched with the same JavaScript regex the replace uses, hashed, and streamed in
 *   batches. Outside git, or when git has no PCRE for a regex, it scans the index instead.
 * - `replaceInFiles`: rewrites only the confirmed matches, refusing files whose hash changed.
 */

export const MAX_SEARCH_FILE_BYTES = 5 * 1024 * 1024;
const MAX_INDEX_FILES = 500_000;
const WALK_SKIP = new Set(['.git', 'node_modules']);

export const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const hasGitSegment = (rel: string) => rel.split('/').some((s) => s.toLowerCase() === '.git');

// ------------------------------------------------------------------------------------- index

export interface CheckoutFiles {
  paths: string[];
  source: 'git' | 'walk';
  /** Untracked, not ignored files (git checkouts): content search scans these itself. */
  untracked?: string[];
}

/** `git status --porcelain=v1 -z` records → files deleted in the work tree and untracked files. */
export function parseStatusZ(out: string): { deleted: string[]; untracked: string[] } {
  const deleted: string[] = [];
  const untracked: string[] = [];
  for (const rec of out.split('\0')) {
    if (rec.length < 4) continue;
    const xy = rec.slice(0, 2);
    const path = rec.slice(3);
    if (xy === '??') untracked.push(path);
    else if (xy[1] === 'D' || xy[0] === 'D') deleted.push(path);
  }
  return { deleted, untracked };
}

/**
 * Every file of a checkout, relative with `/`: tracked (`ls-files --cached`) plus untracked and not
 * ignored, minus files deleted in the work tree (both from `status -uall`, which uses Git for
 * Windows' fscache and is several times faster than `ls-files --others` + `--deleted`). Read-only:
 * `--no-optional-locks` so status never takes the index lock an agent's git might need.
 */
export async function listCheckoutFiles(root: string, git: Git = new Git({ cwd: root })): Promise<CheckoutFiles> {
  try {
    const [cached, status] = await Promise.all([
      git.run(['ls-files', '--cached', '-z'], { cwd: root, timeoutMs: 120_000 }),
      git.run(['--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames', '--ignore-submodules=all'], { cwd: root, timeoutMs: 120_000 }),
    ]);
    const { deleted, untracked } = parseStatusZ(status.stdout);
    const gone = new Set(deleted);
    const seen = new Set<string>();
    for (const p of cached.stdout.split('\0')) if (p && !gone.has(p) && !hasGitSegment(p)) seen.add(p);
    const extra = untracked.filter((p) => !hasGitSegment(p) && !p.endsWith('/'));
    for (const p of extra) seen.add(p);
    return { paths: [...seen].slice(0, MAX_INDEX_FILES), source: 'git', untracked: extra.slice(0, MAX_INDEX_FILES) };
  } catch (err) {
    if (!(err instanceof GitError)) throw err;
    return { paths: await walk(root, MAX_INDEX_FILES), source: 'walk' };
  }
}

/** Breadth-first folder walk (no symlinks, no `.git` / `node_modules`), capped. */
async function walk(root: string, cap: number): Promise<string[]> {
  const out: string[] = [];
  const queue = [''];
  for (let qi = 0; qi < queue.length && out.length < cap; qi++) {
    const dir = queue[qi]!;
    const entries = await readdir(dir ? join(root, dir) : root, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!WALK_SKIP.has(e.name)) queue.push(rel);
      } else if (e.isFile()) out.push(rel);
      if (out.length >= cap) break;
    }
  }
  return out;
}

interface IndexEntry {
  root: string;
  paths: string[];
  lower: string[];
  untracked: string[];
  builtAt: number;
  usedAt: number;
  dirty: boolean;
  building?: Promise<void>;
  source: 'git' | 'walk';
  buildMs: number;
  /** False only for the placeholder while the first build runs. */
  ready: boolean;
}

export interface FileIndexOptions {
  /** Whether a watcher covers the root (then it is rebuilt only when marked dirty). */
  isWatched?: (root: string) => boolean;
  /** Age after which an unwatched root is refreshed (default 30 s). */
  unwatchedTtlMs?: number;
  /** Delay before a dirty, recently used index rebuilds on its own (default 1.5 s). */
  rebuildDelayMs?: number;
  list?: (root: string) => Promise<CheckoutFiles>;
  now?: () => number;
  log?: { debug(...a: unknown[]): void };
}

export interface FindInput {
  /** `real` is the guarded path used on disk; `root` is the caller's spelling, echoed in results. */
  roots: Array<{ root: string; real: string }>;
  query: string;
  limit: number;
  recent: Array<{ root: string; path: string }>;
}

export class FileIndex {
  private readonly entries = new Map<string, IndexEntry>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly o: FileIndexOptions = {}) {}

  private now(): number {
    return this.o.now?.() ?? Date.now();
  }

  /** The root's files; the first call builds the index, later calls refresh a stale one in the background. */
  async files(real: string): Promise<{ paths: string[]; lower: string[]; stale: boolean }> {
    const k = pathKey(real);
    let e = this.entries.get(k);
    if (!e || !e.ready) {
      await this.build(real);
      e = this.entries.get(k)!;
    } else {
      const ttl = this.o.unwatchedTtlMs ?? 30_000;
      const expired = !(this.o.isWatched?.(real) ?? false) && this.now() - e.builtAt > ttl;
      if (e.dirty || expired) void this.build(real);
    }
    e.usedAt = this.now();
    return { paths: e.paths, lower: e.lower, stale: Boolean(e.building) };
  }

  /** Like `files`, but waits for a rebuild when the index is dirty (content search needs every new file). */
  async fresh(real: string): Promise<{ paths: string[]; untracked: string[]; source: 'git' | 'walk' }> {
    const k = pathKey(real);
    const e = this.entries.get(k);
    if (!e || !e.ready || e.dirty || e.building) await this.build(real);
    const cur = this.entries.get(k)!;
    cur.usedAt = this.now();
    return { paths: cur.paths, untracked: cur.untracked, source: cur.source };
  }

  /** Index info for diagnostics and tests. */
  info(real: string): { files: number; source: 'git' | 'walk'; buildMs: number; dirty: boolean } | undefined {
    const e = this.entries.get(pathKey(real));
    return e && { files: e.paths.length, source: e.source, buildMs: e.buildMs, dirty: e.dirty };
  }

  /** (Re)build now; concurrent calls share one build. */
  build(real: string): Promise<void> {
    const k = pathKey(real);
    const e = this.entries.get(k);
    if (e?.building) return e.building;
    const started = this.now();
    if (e) e.dirty = false;
    const p = (this.o.list ?? listCheckoutFiles)(real)
      .then(({ paths, source, untracked = [] }) => {
        const prev = this.entries.get(k);
        // A change arrived while building: keep it dirty so the next query rebuilds again.
        const dirty = prev?.dirty ?? false;
        this.entries.set(k, { root: real, paths, lower: paths.map((x) => x.toLowerCase()), untracked, builtAt: this.now(), usedAt: prev?.usedAt ?? this.now(), dirty, source, buildMs: this.now() - started, ready: true });
      })
      .catch((err: unknown) => {
        this.o.log?.debug('file index build failed', real, err);
        if (!this.entries.get(k)?.ready) this.entries.set(k, { root: real, paths: [], lower: [], untracked: [], builtAt: this.now(), usedAt: this.now(), dirty: true, source: 'walk', buildMs: 0, ready: true });
      })
      .finally(() => {
        const cur = this.entries.get(k);
        if (cur) delete cur.building;
      });
    if (e) e.building = p;
    else this.entries.set(k, { root: real, paths: [], lower: [], untracked: [], builtAt: 0, usedAt: this.now(), dirty: false, source: 'git', buildMs: 0, building: p, ready: false });
    return p;
  }

  /** A watcher saw a change in `path` (a checkout root): mark every index under it dirty. */
  invalidate(path: string): void {
    for (const [k, e] of this.entries) {
      if (!lexicallyInside(path, e.root) && !lexicallyInside(e.root, path)) continue;
      e.dirty = true;
      // Keep indexes that were used in the last 10 minutes fresh without waiting for the next query.
      if (this.now() - e.usedAt > 10 * 60_000 || this.timers.has(k)) continue;
      const t = setTimeout(() => {
        this.timers.delete(k);
        if (this.entries.get(k)?.dirty) void this.build(e.root);
      }, this.o.rebuildDelayMs ?? 1500);
      t.unref?.();
      this.timers.set(k, t);
    }
  }

  forget(path: string): void {
    for (const [k, e] of this.entries) if (lexicallyInside(path, e.root)) this.entries.delete(k);
  }

  dispose(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  /** Fuzzy file-name search across roots; recently opened matches first, then by score. */
  async find(input: FindInput): Promise<{ results: FileNameMatch[]; total: number; stale: boolean }> {
    const recentRank = new Map<string, number>();
    input.recent.forEach((r, i) => {
      const key = `${pathKey(r.root)}\n${r.path}`;
      if (!recentRank.has(key)) recentRank.set(key, i);
    });
    const query = input.query.trim();
    const top: FileNameMatch[] = [];
    let min = -Infinity;
    let total = 0;
    let stale = false;
    const lists = await Promise.all(input.roots.map(async (r) => ({ r, list: await this.files(r.real) })));
    for (const { r, list } of lists) {
      total += list.paths.length;
      stale ||= list.stale;
      const rootKey = pathKey(r.root);
      for (let i = 0; i < list.paths.length; i++) {
        const path = list.paths[i]!;
        const rank = recentRank.get(`${rootKey}\n${path}`);
        if (!query && rank === undefined) continue;
        const s = query ? scorePath(query, path, list.lower[i]) : { score: 0, positions: [] };
        if (!s) continue;
        const score = rank !== undefined ? 1_000_000 - rank * 1000 + s.score / 100 : s.score;
        if (top.length >= input.limit && score <= min) continue;
        const item: FileNameMatch = { root: r.root, path, score, positions: s.positions, recent: rank !== undefined };
        // Binary insert, highest score first.
        let lo = 0;
        let hi = top.length;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (top[mid]!.score >= score) lo = mid + 1;
          else hi = mid;
        }
        top.splice(lo, 0, item);
        if (top.length > input.limit) top.pop();
        if (top.length >= input.limit) min = top[top.length - 1]!.score;
      }
    }
    return { results: top, total, stale };
  }
}

// ------------------------------------------------------------------------------------- grep

/**
 * `git grep` arguments for a content search. The pattern is always the argument of `-e` and is
 * followed by `--`, so a pattern starting with `-` (`--output=x`, `-n`) is never read as an
 * option and nothing after it is read as a revision; no shell is involved. `-I` skips binary
 * files, `--untracked` adds new files, `-z -l` prints NUL-separated names only. Untracked files are
 * not passed to git (`--untracked` walks the whole tree and is ~4x slower on Windows): the caller
 * scans the index's untracked list itself. `grep.fullName` from the user's config is forced off so names stay relative to cwd.
 */
export function grepArgs(o: SearchOptions): string[] {
  return [
    '-c',
    'grep.fullName=false',
    'grep',
    '-l',
    '-z',
    '-I',
    '--no-color',
    ...(o.matchCase ? [] : ['-i']),
    ...(o.wholeWord ? ['-w'] : []),
    o.isRegex ? '-P' : '-F',
    '-e',
    o.query,
    '--',
  ];
}

export interface SearchJob extends SearchOptions {
  searchId: string;
  roots: Array<{ root: string; real: string }>;
  include: string;
  exclude: string;
  maxResults: number;
}

export interface ContentSearchOptions {
  index: FileIndex;
  emit: (batch: SearchResultsEvent) => void;
  git?: (cwd: string) => Git;
  log?: { debug(...a: unknown[]): void; warn(...a: unknown[]): void };
  /** Emit a batch after this many files or milliseconds (defaults 25 / 80 ms). */
  batchFiles?: number;
  batchMs?: number;
}

export class ContentSearch {
  private readonly jobs = new Map<string, AbortController>();

  constructor(private readonly o: ContentSearchOptions) {}

  get running(): number {
    return this.jobs.size;
  }

  /** Starts a search; results arrive through `emit`. Resolves when the last batch was sent. */
  start(job: SearchJob): Promise<void> {
    this.cancel(job.searchId);
    // Keep at most 4 searches running; the oldest is cancelled.
    while (this.jobs.size >= 4) this.cancel(this.jobs.keys().next().value!);
    const ac = new AbortController();
    this.jobs.set(job.searchId, ac);
    return this.run(job, ac.signal).finally(() => {
      if (this.jobs.get(job.searchId) === ac) this.jobs.delete(job.searchId);
    });
  }

  cancel(searchId: string): void {
    const ac = this.jobs.get(searchId);
    if (!ac) return;
    this.jobs.delete(searchId);
    ac.abort();
  }

  cancelAll(): void {
    for (const id of [...this.jobs.keys()]) this.cancel(id);
  }

  private async run(job: SearchJob, signal: AbortSignal): Promise<void> {
    const t0 = Date.now();
    const re = buildSearchRegExp(job);
    const keep = pathFilter(job.include, job.exclude);
    let batch: ContentFileResult[] = [];
    let lastFlush = Date.now();
    let matches = 0;
    let fileCount = 0;
    let truncated = false;
    const engines = new Set<'git-grep' | 'scan'>();
    const flush = (extra: Partial<SearchResultsEvent> = {}) => {
      const files = batch;
      batch = [];
      lastFlush = Date.now();
      this.o.emit({ searchId: job.searchId, files, done: false, truncated, ...extra });
    };

    /** Reads, guards and matches one candidate file. False once the result cap is reached. */
    const consider = async (r: { root: string; real: string }, rel: string): Promise<boolean> => {
      if (signal.aborted) return false;
      if (!rel || hasGitSegment(rel) || !keep(rel)) return true;
      const abs = join(r.real, rel);
      if (!isInside(r.real, abs)) return true; // a symlink out of the checkout
      const st = await stat(abs).catch(() => undefined);
      if (!st?.isFile() || st.size > MAX_SEARCH_FILE_BYTES) return true;
      const buf = await readFile(abs).catch(() => undefined);
      if (!buf || buf.subarray(0, 8000).includes(0)) return true; // binary
      const found = findMatches(buf.toString('utf8'), re, job.maxResults - matches);
      if (!found.length) return true;
      batch.push({ root: r.root, path: rel, hash: sha256(buf), mtimeMs: st.mtimeMs, matches: found });
      matches += found.length;
      fileCount++;
      if (batch.length >= (this.o.batchFiles ?? 25) || Date.now() - lastFlush >= (this.o.batchMs ?? 80)) flush();
      if (matches >= job.maxResults) {
        truncated = true;
        return false;
      }
      return true;
    };

    /** Streams files through `consider`, 8 at a time; false when the search should stop. */
    const scan = async (r: { root: string; real: string }, paths: readonly string[]): Promise<boolean> => {
      for (let i = 0; i < paths.length; i += 8) {
        const go = await Promise.all(paths.slice(i, i + 8).map((p) => consider(r, p)));
        if (go.includes(false)) return false;
      }
      return true;
    };

    try {
      for (const r of job.roots) {
        if (signal.aborted || truncated) break;
        // The index (tracked + untracked, .gitignore respected) refreshes while git grep runs.
        const listing = this.o.index.fresh(r.real);
        listing.catch(() => undefined);
        const viaGit = await this.grepRoot(job, r, signal, consider);
        if (viaGit === 'stop') break;
        if (viaGit === 'done') {
          engines.add('git-grep');
          // git grep searched the tracked files; new (untracked, not ignored) files are scanned here.
          if (!(await scan(r, (await listing).untracked))) break;
          continue;
        }
        // Not a git checkout, or git cannot run this regex (no PCRE): scan the whole index.
        engines.add('scan');
        if (!(await scan(r, (await listing).paths))) break;
      }
      const engine = engines.size > 1 ? 'mixed' : engines.has('scan') ? 'scan' : 'git-grep';
      this.o.emit({ searchId: job.searchId, files: batch, done: true, truncated, ...(signal.aborted && !truncated ? { cancelled: true } : {}), stats: { files: fileCount, matches, ms: Date.now() - t0, engine } });
    } catch (err) {
      this.o.log?.warn('content search failed', err);
      this.o.emit({ searchId: job.searchId, files: batch, done: true, truncated, error: (err as Error).message, stats: { files: fileCount, matches, ms: Date.now() - t0, engine: 'scan' } });
    }
  }

  /**
   * Streams `git grep -l` names into `consider` (8 at a time, in order). 'done' when git searched
   * the root, 'fallback' when it could not (not a repo, no PCRE, invalid PCRE), 'stop' at the cap.
   */
  private async grepRoot(
    job: SearchJob,
    r: { root: string; real: string },
    signal: AbortSignal,
    consider: (r: { root: string; real: string }, rel: string) => Promise<boolean>,
  ): Promise<'done' | 'fallback' | 'stop'> {
    const git = this.o.git?.(r.real) ?? new Git({ cwd: r.real });
    const names: string[] = [];
    let rest = Buffer.alloc(0);
    let ended = false;
    let wake: (() => void) | undefined;
    const stop = new AbortController();
    const onAbort = () => stop.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    const proc = git
      .stream(grepArgs(job), {
        cwd: r.real,
        okExitCodes: [0, 1],
        signal: stop.signal,
        onStdout: (chunk) => {
          let buf = rest.length ? Buffer.concat([rest, chunk]) : chunk;
          for (let nul = buf.indexOf(0); nul >= 0; nul = buf.indexOf(0)) {
            names.push(buf.subarray(0, nul).toString('utf8'));
            buf = buf.subarray(nul + 1);
          }
          rest = Buffer.from(buf);
          wake?.();
        },
      })
      .then(
        (res) => ({ ok: true as const, res }),
        (err: unknown) => ({ ok: false as const, err }),
      )
      .finally(() => {
        ended = true;
        wake?.();
      });
    let i = 0;
    let capped = false;
    try {
      for (;;) {
        if (i < names.length) {
          const chunk = names.slice(i, i + 8);
          i += chunk.length;
          const go = await Promise.all(chunk.map((n) => consider(r, n)));
          if (go.includes(false)) {
            capped = !signal.aborted;
            stop.abort();
            break;
          }
          continue;
        }
        if (ended) break;
        await new Promise<void>((res) => (wake = res));
        wake = undefined;
      }
      const outcome = await proc;
      if (capped || signal.aborted) return 'stop';
      if (!outcome.ok) {
        // 128: not a repository, or a regex git's PCRE cannot take. Nothing was reported yet.
        if (outcome.err instanceof GitError && i === 0) return 'fallback';
        throw outcome.err;
      }
      return 'done';
    } finally {
      signal.removeEventListener('abort', onAbort);
      stop.abort();
    }
  }
}

// ------------------------------------------------------------------------------------- replace

export interface ReplaceTarget {
  root: string;
  path: string;
  /** Guarded absolute path. */
  abs: string;
  hash: string;
  matches: Array<{ line: number; column: number; length: number; text: string }>;
}

/**
 * Replaces exactly the confirmed matches. A file is refused (`stale`, nothing written) when its
 * bytes no longer hash to what the search saw, or when any confirmed match is no longer at its
 * line and column; non-UTF-8 files are refused (`failed`) so a rewrite cannot corrupt them.
 */
export async function replaceInFiles(targets: ReplaceTarget[], o: SearchOptions, replacement: string): Promise<ReplaceFileResult[]> {
  buildSearchRegExp(o); // throws on an invalid regex before anything is touched
  const out: ReplaceFileResult[] = [];
  for (const t of targets) {
    const base = { root: t.root, path: t.path };
    try {
      const st = await stat(t.abs).catch(() => undefined);
      if (!st?.isFile()) {
        out.push({ ...base, status: 'stale', replaced: 0, message: 'The file is gone.' });
        continue;
      }
      const buf = await readFile(t.abs);
      if (sha256(buf) !== t.hash) {
        out.push({ ...base, status: 'stale', replaced: 0, message: 'The file changed since the search. Search again.' });
        continue;
      }
      const text = buf.toString('utf8');
      if (!Buffer.from(text, 'utf8').equals(buf)) {
        out.push({ ...base, status: 'failed', replaced: 0, message: 'Not UTF-8 text; left unchanged.' });
        continue;
      }
      const r = applyReplacements(text, o, replacement, t.matches);
      if (r.missing > 0) {
        out.push({ ...base, status: 'stale', replaced: 0, message: 'A match is no longer where the search found it. Search again.' });
        continue;
      }
      // Last check right before writing: nobody wrote the file while we computed.
      const again = await stat(t.abs);
      if (again.mtimeMs !== st.mtimeMs || again.size !== st.size) {
        out.push({ ...base, status: 'stale', replaced: 0, message: 'The file changed while replacing. Search again.' });
        continue;
      }
      await writeFile(t.abs, r.content, 'utf8');
      out.push({ ...base, status: 'replaced', replaced: r.replaced });
    } catch (err) {
      out.push({ ...base, status: 'failed', replaced: 0, message: (err as Error).message });
    }
  }
  return out;
}
