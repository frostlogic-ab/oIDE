import { open, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { DiffStat, FileDiff } from '@oide/protocol';
import { toGit, type Git, type Repo } from './git.js';
import { parseUnifiedDiff, synthesizeAddedPatch } from './patch.js';

/**
 * Diffs for an agent worktree, the way Review and the tiles count them:
 * everything between the merge-base with the base branch and the working tree, i.e.
 * `git diff <merge-base>...HEAD` plus uncommitted changes, plus untracked (not ignored) files.
 *
 * Diffing `<merge-base>` against the working tree gives exactly that union in one pass (a file
 * changed in a commit and again on disk is counted once, with its net change).
 */

export interface DiffOptions {
  /** Include uncommitted and untracked changes (default true). False = `<merge-base>...HEAD` only. */
  includeUncommitted?: boolean;
  /** Limit to these paths. */
  paths?: string[];
}

/** Common diff flags that override user config (external diff tools, prefixes, textconv, colour). */
const DIFF_FLAGS = ['--no-color', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/', '-M'];

/** Untracked files larger than this are reported as binary without reading them. */
const MAX_UNTRACKED_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_UNTRACKED_FILES = 2000;

export async function mergeBase(repo: Repo, base: string, head = 'HEAD'): Promise<string> {
  const git = toGit(repo);
  const r = await git.run(['merge-base', base, head], { okExitCodes: [0, 1] });
  const sha = r.stdout.trim();
  if (r.exitCode === 0 && sha) return sha;
  // No common ancestor: diff against the base itself.
  const baseSha = await git.revParse(base);
  if (!baseSha) throw new Error(`Unknown base ref: ${base}`);
  return baseSha;
}

interface NumstatEntry {
  path: string;
  oldPath?: string;
  additions: number;
  deletions: number;
  binary: boolean;
}

/** Parse `git diff --numstat -z`. Renames come as `a\td\t\0old\0new\0`. */
export function parseNumstatZ(text: string): NumstatEntry[] {
  const parts = text.split('\0');
  const out: NumstatEntry[] = [];
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i];
    if (!rec) continue;
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(rec);
    if (!m) continue;
    const binary = m[1] === '-' || m[2] === '-';
    const additions = binary ? 0 : Number(m[1]);
    const deletions = binary ? 0 : Number(m[2]);
    if (m[3] === '') {
      const oldPath = parts[++i] ?? '';
      const path = parts[++i] ?? '';
      out.push({ path, oldPath, additions, deletions, binary });
    } else out.push({ path: m[3]!, additions, deletions, binary });
  }
  return out;
}

async function untrackedFiles(git: Git, paths?: string[]): Promise<string[]> {
  const args = ['ls-files', '--others', '--exclude-standard', '-z'];
  if (paths?.length) args.push('--', ...paths);
  const out = await git.out(args, { env: { GIT_OPTIONAL_LOCKS: '0' } });
  return out.split('\0').filter(Boolean);
}

interface UntrackedInfo {
  path: string;
  binary: boolean;
  content?: string;
}

async function readUntracked(root: string, rel: string): Promise<UntrackedInfo> {
  const abs = join(root, rel);
  try {
    const st = await stat(abs);
    if (!st.isFile()) return { path: rel, binary: true };
    if (st.size > MAX_UNTRACKED_TEXT_BYTES) return { path: rel, binary: true };
    const fh = await open(abs, 'r');
    try {
      const buf = await fh.readFile();
      if (buf.subarray(0, 8000).includes(0)) return { path: rel, binary: true };
      return { path: rel, binary: false, content: buf.toString('utf8') };
    } finally {
      await fh.close();
    }
  } catch {
    return { path: rel, binary: true };
  }
}

async function diffRange(git: Git, base: string, opts: DiffOptions): Promise<string[]> {
  const mb = await mergeBase(git, base);
  return opts.includeUncommitted === false ? [mb, 'HEAD'] : [mb];
}

/** Totals for the tile and Source control card. */
export async function diffStat(repo: Repo, base: string, opts: DiffOptions = {}): Promise<DiffStat> {
  const entries = await numstat(repo, base, opts);
  return {
    files: entries.length,
    additions: entries.reduce((n, e) => n + e.additions, 0),
    deletions: entries.reduce((n, e) => n + e.deletions, 0),
  };
}

/** Per-file counts, including untracked files. */
export async function numstat(repo: Repo, base: string, opts: DiffOptions = {}): Promise<NumstatEntry[]> {
  const git = toGit(repo);
  const range = await diffRange(git, base, opts);
  const args = ['diff', '--numstat', '-z', ...DIFF_FLAGS, ...range];
  if (opts.paths?.length) args.push('--', ...opts.paths);
  const entries = parseNumstatZ(await git.out(args, { env: { GIT_OPTIONAL_LOCKS: '0' } }));
  if (opts.includeUncommitted !== false) {
    const untracked = (await untrackedFiles(git, opts.paths)).slice(0, MAX_UNTRACKED_FILES);
    for (const p of untracked) {
      const info = await readUntracked(git.cwd, p);
      const additions = info.content ? synthesizeAddedPatch(info.content).additions : 0;
      entries.push({ path: p, additions, deletions: 0, binary: info.binary });
    }
  }
  return entries;
}

/** Changed file paths (new names for renames), sorted. */
export async function changedFiles(repo: Repo, base: string, opts: DiffOptions = {}): Promise<string[]> {
  const git = toGit(repo);
  const range = await diffRange(git, base, opts);
  const args = ['diff', '--name-only', '-z', ...DIFF_FLAGS, ...range];
  if (opts.paths?.length) args.push('--', ...opts.paths);
  const files = new Set((await git.out(args, { env: { GIT_OPTIONAL_LOCKS: '0' } })).split('\0').filter(Boolean));
  if (opts.includeUncommitted !== false) for (const p of await untrackedFiles(git, opts.paths)) files.add(p);
  return [...files].sort();
}

/** Full per-file diffs with parsed unified patches, for Review. */
export async function fileDiffs(repo: Repo, base: string, opts: DiffOptions & { context?: number } = {}): Promise<FileDiff[]> {
  const git = toGit(repo);
  const range = await diffRange(git, base, opts);
  const args = ['diff', `-U${opts.context ?? 3}`, ...DIFF_FLAGS, ...range];
  if (opts.paths?.length) args.push('--', ...opts.paths);
  const diffs = parseUnifiedDiff(await git.out(args, { env: { GIT_OPTIONAL_LOCKS: '0' } }));
  if (opts.includeUncommitted !== false) {
    const untracked = (await untrackedFiles(git, opts.paths)).slice(0, MAX_UNTRACKED_FILES);
    for (const p of untracked) {
      const info = await readUntracked(git.cwd, p);
      if (info.binary || info.content === undefined) {
        diffs.push({ path: p, status: 'added', additions: 0, deletions: 0, binary: true, patch: '' });
      } else {
        const { patch, additions } = synthesizeAddedPatch(info.content);
        diffs.push({ path: p, status: 'added', additions, deletions: 0, binary: false, patch });
      }
    }
  }
  return diffs.sort((a, b) => a.path.localeCompare(b.path));
}
