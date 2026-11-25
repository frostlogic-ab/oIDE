import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, git, makeRepo, startHarness, tempDir, waitFor, type Harness } from './harness.js';

/**
 * files.findByName / files.searchContent / files.replace (apps/desktop/src/main/handlers/files.ts)
 * through the real IPC router: Zod validation, the path guard on every root and file, streamed
 * `files.searchResults` events that pass their schema, and the stale-file refusal.
 */

const open: Array<{ h: Harness; dirs: string[] }> = [];
afterEach(async () => {
  while (open.length) {
    const { h, dirs } = open.pop()!;
    await h.close().catch(() => undefined);
    cleanup(h.userData, ...dirs);
  }
});

async function setup() {
  const repo = makeRepo();
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src', 'retry.ts'), 'export function retry() {\n  return "-n";\n}\n');
  writeFileSync(join(repo, 'src', 'handler.ts'), 'retry();\nretry();\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'src');
  const outside = tempDir('oide-int-outside-');
  writeFileSync(join(outside, 'secret.txt'), 'retry\n');
  const h = await startHarness();
  open.push({ h, dirs: [repo, outside] });
  h.allowOpen(repo);
  const project = await h.call('projects.open', { path: repo });
  return { h, repo, outside, project: project! };
}

async function search(h: Harness, input: { roots: string[]; query: string; isRegex?: boolean }) {
  const searchId = `s${Math.random().toString(36).slice(2)}`;
  await h.call('files.searchContent', { searchId, ...input });
  const last = await waitFor(() => h.eventsOf('files.searchResults').find((e) => e.searchId === searchId && e.done), 'search done');
  const files = h.eventsOf('files.searchResults').filter((e) => e.searchId === searchId).flatMap((e) => e.files);
  return { last, files };
}

describe('files search handlers', () => {
  it('finds files by name in an open project and refuses roots outside known checkouts', async () => {
    const { h, repo, outside } = await setup();
    const r = await h.call('files.findByName', { roots: [repo], query: 'retry' });
    expect(r.results.map((x) => x.path)).toEqual(['src/retry.ts']);
    expect(r.results[0]!.root).toBe(repo);
    expect(r.total).toBeGreaterThanOrEqual(3);
    expect(await h.fails('files.findByName', { roots: [outside], query: 'secret' })).toBe('forbidden_path');
    expect(await h.fails('files.findByName', { roots: [join(repo, '..')], query: 'x' })).toBe('forbidden_path');
  });

  it('streams schema-valid results and validates the query', async () => {
    const { h, repo, outside } = await setup();
    const { last, files } = await search(h, { roots: [repo], query: '-n' });
    expect(files.map((f) => f.path)).toEqual(['src/retry.ts']);
    expect(last.stats).toMatchObject({ engine: 'git-grep', matches: 1 });
    expect(h.emitErrors).toEqual([]);
    expect(await h.fails('files.searchContent', { searchId: 'x', roots: [repo], query: '(', isRegex: true })).toBe('invalid_input');
    expect(await h.fails('files.searchContent', { searchId: 'x', roots: [repo], query: 'a\nb' })).toBe('invalid_input');
    expect(await h.fails('files.searchContent', { searchId: 'x', roots: [outside], query: 'retry' })).toBe('forbidden_path');
  });

  it('replaces confirmed matches, refuses stale files and paths outside the checkout', async () => {
    const { h, repo, outside } = await setup();
    const { files } = await search(h, { roots: [repo], query: 'retry' });
    const handler = files.find((f) => f.path === 'src/handler.ts')!;
    const opts = { query: 'retry', isRegex: false, matchCase: false, wholeWord: false, replacement: 'again' };

    // Only the second match was confirmed.
    const one = await h.call('files.replace', { ...opts, files: [{ root: repo, path: handler.path, hash: handler.hash, matches: [handler.matches[1]!] }] });
    expect(one.results).toEqual([{ root: repo, path: 'src/handler.ts', status: 'replaced', replaced: 1 }]);
    expect(readFileSync(join(repo, 'src/handler.ts'), 'utf8')).toBe('retry();\nagain();\n');

    // The file changed since the search (the replace above): refused, nothing written.
    const stale = await h.call('files.replace', { ...opts, files: [{ root: repo, path: handler.path, hash: handler.hash, matches: [handler.matches[0]!] }] });
    expect(stale.results[0]).toMatchObject({ status: 'stale', replaced: 0 });
    expect(readFileSync(join(repo, 'src/handler.ts'), 'utf8')).toBe('retry();\nagain();\n');

    // Path guard: traversal, absolute paths elsewhere, the .git folder, unknown roots.
    const m = { line: 1, column: 0, length: 5, text: 'retry' };
    const hash = 'a'.repeat(64);
    expect(await h.fails('files.replace', { ...opts, files: [{ root: repo, path: '../outside/secret.txt', hash, matches: [m] }] })).toBe('forbidden_path');
    expect(await h.fails('files.replace', { ...opts, files: [{ root: repo, path: join(outside, 'secret.txt'), hash, matches: [m] }] })).toBe('forbidden_path');
    expect(await h.fails('files.replace', { ...opts, files: [{ root: repo, path: '.git/config', hash, matches: [m] }] })).toBe('forbidden_path');
    expect(await h.fails('files.replace', { ...opts, files: [{ root: outside, path: 'secret.txt', hash, matches: [m] }] })).toBe('forbidden_path');
    expect(await h.fails('files.replace', { ...opts, files: [{ root: repo, path: 'src/retry.ts', hash: 'nothex', matches: [m] }] })).toBe('invalid_input');
    // One bad path refuses the whole request before anything is written.
    const retry = files.find((f) => f.path === 'src/retry.ts')!;
    expect(
      await h.fails('files.replace', {
        ...opts,
        files: [
          { root: repo, path: retry.path, hash: retry.hash, matches: retry.matches },
          { root: repo, path: '../x', hash, matches: [m] },
        ],
      }),
    ).toBe('forbidden_path');
    expect(readFileSync(join(repo, 'src/retry.ts'), 'utf8')).toContain('export function retry()');
    expect(readFileSync(join(outside, 'secret.txt'), 'utf8')).toBe('retry\n');
  });
});
