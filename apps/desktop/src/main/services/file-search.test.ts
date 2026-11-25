import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { SearchResultsEvent } from '@oide/protocol';
import { ContentSearch, FileIndex, grepArgs, listCheckoutFiles, parseStatusZ, replaceInFiles, sha256, type SearchJob } from './file-search.js';

const dirs: string[] = [];
const temp = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

let repo: string;
beforeAll(() => {
  repo = temp('oide-search-');
  git(repo, 'init', '-q', '-b', 'main');
  const files: Record<string, string> = {
    'src/retry.ts': 'export function retry() {\n  return backoff("a.c");\n}\n',
    'src/abc.ts': 'const abc = 1; // a.c is not abc\n',
    'src/flags.ts': 'run("--output=pwned", "-n")\n',
    'docs/notes.md': 'Retry with backoff.\r\nRETRY twice.\r\n',
    'dist/bundle.js': 'retry(); retry();\n',
    '.gitignore': 'dist/\n',
  };
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(join(repo, p, '..'), { recursive: true });
    writeFileSync(join(repo, p), c);
  }
  writeFileSync(join(repo, 'src/logo.bin'), Buffer.from([0x72, 0x65, 0x74, 0x72, 0x79, 0, 1, 2]));
  git(repo, 'add', '-A');
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init');
  // untracked, not ignored
  writeFileSync(join(repo, 'src/new.ts'), 'retry(); // new file\n');
});

describe('file index', () => {
  it('lists tracked and untracked files, respects .gitignore, drops deleted ones', async () => {
    writeFileSync(join(repo, 'gone.txt'), 'x');
    git(repo, 'add', 'gone.txt');
    rmSync(join(repo, 'gone.txt'));
    const { paths, source, untracked } = await listCheckoutFiles(repo);
    expect(source).toBe('git');
    expect(untracked).toEqual(['src/new.ts']);
    expect(paths).toContain('src/new.ts');
    expect(paths).toContain('src/retry.ts');
    expect(paths).not.toContain('dist/bundle.js');
    expect(paths).not.toContain('gone.txt');
    git(repo, 'rm', '-q', '--cached', 'gone.txt');
  });

  it('parses git status -z records', () => {
    expect(parseStatusZ(' D a.ts\0?? b c.ts\0M  d.ts\0D  e.ts\0')).toEqual({ deleted: ['a.ts', 'e.ts'], untracked: ['b c.ts'] });
  });

  it('walks a folder that is not a git checkout', async () => {
    const plain = temp('oide-plain-');
    mkdirSync(join(plain, 'a', 'node_modules'), { recursive: true });
    writeFileSync(join(plain, 'a', 'x.ts'), '');
    writeFileSync(join(plain, 'a', 'node_modules', 'dep.js'), '');
    expect(await listCheckoutFiles(plain)).toEqual({ paths: ['a/x.ts'], source: 'walk' });
  });

  it('ranks recently opened matches first, then by score, and caps the results', async () => {
    const list = vi.fn(async () => ({ paths: ['src/shell/StatusBar.tsx', 'src/shell/SessionStatusBar.tsx', 'docs/status.md', 'src/x.ts'], source: 'git' as const }));
    const index = new FileIndex({ list, isWatched: () => true });
    const roots = [{ root: '/r', real: '/r' }];
    const r = await index.find({ roots, query: 'statusbar', limit: 10, recent: [] });
    expect(r.results.map((x) => x.path)).toEqual(['src/shell/StatusBar.tsx', 'src/shell/SessionStatusBar.tsx']);
    const withRecent = await index.find({ roots, query: 'statusbar', limit: 1, recent: [{ root: '/r', path: 'src/shell/SessionStatusBar.tsx' }] });
    expect(withRecent.results).toMatchObject([{ path: 'src/shell/SessionStatusBar.tsx', recent: true }]);
    // empty query: only the recent files
    expect((await index.find({ roots, query: '', limit: 10, recent: [{ root: '/r', path: 'docs/status.md' }] })).results.map((x) => x.path)).toEqual(['docs/status.md']);
    expect(list).toHaveBeenCalledTimes(1); // built once
  });

  it('rebuilds in the background after a watcher change and serves the old list meanwhile', async () => {
    let paths = ['a.ts'];
    let release!: () => void;
    const list = vi.fn(async () => {
      if (list.mock.calls.length > 1) await new Promise<void>((r) => (release = r));
      return { paths: [...paths], source: 'git' as const };
    });
    const index = new FileIndex({ list, isWatched: () => true, rebuildDelayMs: 60_000 });
    expect((await index.files('/r')).paths).toEqual(['a.ts']);
    paths = ['a.ts', 'b.ts'];
    index.invalidate('/r');
    const during = await index.files('/r');
    expect(during).toMatchObject({ paths: ['a.ts'], stale: true });
    release();
    await index.build('/r');
    expect((await index.files('/r')).paths).toEqual(['a.ts', 'b.ts']);
    index.dispose();
  });

  it('refreshes unwatched roots after the TTL', async () => {
    let t = 0;
    const list = vi.fn(async () => ({ paths: ['a'], source: 'walk' as const }));
    const index = new FileIndex({ list, isWatched: () => false, unwatchedTtlMs: 1000, now: () => t });
    await index.files('/r');
    await index.files('/r');
    expect(list).toHaveBeenCalledTimes(1);
    t = 5000;
    await index.files('/r');
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('indexes 100k files and answers a query fast', async () => {
    const paths = Array.from({ length: 100_000 }, (_, i) => `packages/p${i % 50}/src/module${i % 997}/file${i}.ts`);
    const index = new FileIndex({ list: async () => ({ paths, source: 'git' }), isWatched: () => true });
    await index.files('/big');
    const t0 = performance.now();
    const r = await index.find({ roots: [{ root: '/big', real: '/big' }], query: 'file4242', limit: 50, recent: [] });
    const ms = performance.now() - t0;
    expect(r.results[0]!.path).toBe('packages/p42/src/module254/file4242.ts');
    expect(r.total).toBe(100_000);
    expect(ms).toBeLessThan(1500);
  });
});

describe('git grep arguments', () => {
  it('puts the pattern after -e and ends options with --, even for patterns that look like options', () => {
    for (const query of ['--output=/tmp/pwned', '-n', '-e', '--', '--open-files-in-pager=calc']) {
      const args = grepArgs({ query, isRegex: false, matchCase: true, wholeWord: false });
      const e = args.indexOf('-e');
      expect(args[e + 1]).toBe(query);
      expect(args[e + 2]).toBe('--');
      expect(args.at(-1)).toBe('--');
      // nothing user-controlled before -e
      expect(args.slice(0, e).every((a) => a.startsWith('-') || a === 'grep' || a === 'grep.fullName=false')).toBe(true);
    }
  });

  it('uses -F for text, -P for regex, -i and -w from the options', () => {
    expect(grepArgs({ query: 'x', isRegex: false, matchCase: false, wholeWord: false })).toEqual(expect.arrayContaining(['-F', '-i']));
    const re = grepArgs({ query: 'x', isRegex: true, matchCase: true, wholeWord: true });
    expect(re).toEqual(expect.arrayContaining(['-P', '-w']));
    expect(re).not.toContain('-i');
    expect(re).not.toContain('-F');
    expect(re).toEqual(expect.arrayContaining(['-I', '-l', '-z']));
    expect(re).not.toContain('--untracked'); // untracked files come from the index (much faster)
  });
});

async function runSearch(job: Partial<SearchJob> & { query: string }, roots = [repo], opts: { cancelAfterFirst?: boolean } = {}) {
  const events: SearchResultsEvent[] = [];
  const index = new FileIndex({ isWatched: () => true });
  const search = new ContentSearch({ index, emit: (e) => {
    events.push(e);
    if (opts.cancelAfterFirst) search.cancel('t');
  }, batchFiles: 1 });
  await search.start({ searchId: 't', roots: roots.map((r) => ({ root: r, real: r })), isRegex: false, matchCase: false, wholeWord: false, include: '', exclude: '', maxResults: 2000, ...job });
  const files = events.flatMap((e) => e.files);
  return { events, files, last: events.at(-1)!, paths: files.map((f) => f.path).sort() };
}

describe('content search', () => {
  it('finds a pattern that starts with dashes as text, without git reading it as an option', async () => {
    const r = await runSearch({ query: '--output=pwned', matchCase: true });
    expect(r.paths).toEqual(['src/flags.ts']);
    expect(existsSync(join(repo, 'pwned'))).toBe(false);
    const n = await runSearch({ query: '-n', matchCase: true });
    expect(n.paths).toEqual(['src/flags.ts']);
    expect(n.files[0]!.matches[0]).toMatchObject({ line: 1, text: '-n' });
  });

  it('treats text literally and regexes as regexes', async () => {
    expect((await runSearch({ query: 'a.c', matchCase: true })).files.flatMap((f) => f.matches.map((m) => m.text))).toEqual(['a.c', 'a.c']);
    const re = await runSearch({ query: 'a.c', isRegex: true, matchCase: true });
    expect(re.files.flatMap((f) => f.matches.map((m) => m.text)).sort()).toEqual(['a.c', 'a.c', 'abc', 'abc']);
  });

  it('includes untracked files, skips ignored and binary files, matches case-insensitively with CRLF', async () => {
    const r = await runSearch({ query: 'retry' });
    expect(r.paths).toEqual(['docs/notes.md', 'src/new.ts', 'src/retry.ts']);
    const notes = r.files.find((f) => f.path === 'docs/notes.md')!;
    expect(notes.matches.map((m) => [m.line, m.text])).toEqual([
      [1, 'Retry'],
      [2, 'RETRY'],
    ]);
    expect(notes.hash).toBe(sha256(readFileSync(join(repo, 'docs/notes.md'))));
    expect(r.last).toMatchObject({ done: true, truncated: false, stats: { engine: 'git-grep', files: 3, matches: 4 } });
  });

  it('applies include and exclude globs and whole word', async () => {
    expect((await runSearch({ query: 'retry', include: 'src/**', exclude: 'new.ts' })).paths).toEqual(['src/retry.ts']);
    expect((await runSearch({ query: 'retr', wholeWord: true })).paths).toEqual([]);
  });

  it('stops at the result cap and marks the results truncated', async () => {
    const r = await runSearch({ query: 'retry', maxResults: 2 });
    expect(r.files.reduce((n, f) => n + f.matches.length, 0)).toBe(2);
    expect(r.last).toMatchObject({ done: true, truncated: true });
  });

  it('can be cancelled', async () => {
    const r = await runSearch({ query: 'retry' }, [repo], { cancelAfterFirst: true });
    expect(r.last.done).toBe(true);
    expect(r.last.cancelled).toBe(true);
  });

  it('scans folders that are not git checkouts', async () => {
    const plain = temp('oide-plain-search-');
    writeFileSync(join(plain, 'a.txt'), 'hello -n world\n');
    const r = await runSearch({ query: '-n' }, [plain]);
    expect(r.paths).toEqual(['a.txt']);
    expect(r.last.stats?.engine).toBe('scan');
  });
});

describe('replace', () => {
  const o = { query: 'retry', isRegex: false, matchCase: false, wholeWord: false };

  it('replaces only the confirmed matches and keeps CRLF', async () => {
    const dir = temp('oide-replace-');
    const p = join(dir, 'notes.md');
    writeFileSync(p, 'Retry with backoff.\r\nRETRY twice.\r\n');
    const hash = sha256(readFileSync(p));
    const [res] = await replaceInFiles([{ root: dir, path: 'notes.md', abs: p, hash, matches: [{ line: 2, column: 0, length: 5, text: 'RETRY' }] }], o, 'again');
    expect(res).toMatchObject({ status: 'replaced', replaced: 1 });
    expect(readFileSync(p, 'utf8')).toBe('Retry with backoff.\r\nagain twice.\r\n');
  });

  it('refuses a file that changed since the search and writes nothing', async () => {
    const dir = temp('oide-replace-');
    const p = join(dir, 'a.ts');
    writeFileSync(p, 'retry();\n');
    const hash = sha256(readFileSync(p));
    writeFileSync(p, '// an agent edited this\nretry();\n');
    const [res] = await replaceInFiles([{ root: dir, path: 'a.ts', abs: p, hash, matches: [{ line: 1, column: 0, length: 5, text: 'retry' }] }], o, 'x');
    expect(res).toMatchObject({ status: 'stale', replaced: 0 });
    expect(readFileSync(p, 'utf8')).toBe('// an agent edited this\nretry();\n');
  });

  it('refuses a match that is no longer there, and files that are not UTF-8', async () => {
    const dir = temp('oide-replace-');
    const p = join(dir, 'a.ts');
    writeFileSync(p, 'retry();\n');
    const [moved] = await replaceInFiles([{ root: dir, path: 'a.ts', abs: p, hash: sha256(readFileSync(p)), matches: [{ line: 1, column: 2, length: 5, text: 'retry' }] }], o, 'x');
    expect(moved!.status).toBe('stale');
    const latin = join(dir, 'l.txt');
    writeFileSync(latin, Buffer.from([0x72, 0x65, 0x74, 0x72, 0x79, 0xe9, 0x0a]));
    const [bad] = await replaceInFiles([{ root: dir, path: 'l.txt', abs: latin, hash: sha256(readFileSync(latin)), matches: [{ line: 1, column: 0, length: 5, text: 'retry' }] }], o, 'x');
    expect(bad).toMatchObject({ status: 'failed' });
    expect(readFileSync(latin)).toEqual(Buffer.from([0x72, 0x65, 0x74, 0x72, 0x79, 0xe9, 0x0a]));
  });
});
