import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { cloneFailureMessage, cloneFailureOf, cloneProgressParser, cloneRepo } from '../src/clone.js';
import { parseRepoList } from '../src/gh.js';
import { cleanup, makeRepo, sh, tempDir, write } from './helpers.js';

afterAll(cleanup);

describe('cloneProgressParser', () => {
  it('reads git progress split across chunks and carriage returns', () => {
    const parse = cloneProgressParser();
    expect(parse("Cloning into 'repo'...\n")).toEqual({ phase: 'Connecting' });
    expect(parse('remote: Counting objects:  50% (5/10)\rremote: Counting obj')).toEqual({ phase: 'Counting objects', percent: 50 });
    expect(parse('ects: 100% (10/10), done.\n')).toEqual({ phase: 'Counting objects', percent: 100 });
    expect(parse('Receiving objects:  12% (12/100), 1.00 MiB | 2.00 MiB/s\rReceiving objects:  40% (40/100)\r')).toEqual({ phase: 'Receiving objects', percent: 40 });
    expect(parse('Resolving deltas: 100% (3/3), done.\n')).toEqual({ phase: 'Resolving deltas', percent: 100 });
    expect(parse('warning: something else\n')).toBeUndefined();
  });
});

describe('cloneFailureOf', () => {
  it.each([
    ["remote: Repository not found.\nfatal: repository 'https://github.com/o/r.git/' not found", 'not_found'],
    ["fatal: 'x' does not appear to be a git repository", 'not_found'],
    ["fatal: could not read Username for 'https://github.com': terminal prompts disabled", 'auth'],
    ["fatal: Authentication failed for 'https://host/r.git/'", 'auth'],
    ['git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.', 'auth'],
    ["fatal: unable to access 'https://nope.invalid/r.git/': Could not resolve host: nope.invalid", 'network'],
    ["fatal: destination path 'r' already exists and is not an empty directory.", 'exists'],
    ['fatal: something odd', 'other'],
  ])('%s → %s', (stderr, kind) => {
    expect(cloneFailureOf(stderr)).toBe(kind);
  });

  it('explains each kind in a sentence', () => {
    expect(cloneFailureMessage('auth', '')).toMatch(/gh auth login/);
    expect(cloneFailureMessage('other', 'fatal: boom\n')).toBe('git clone failed: boom');
  });
});

describe('cloneRepo', () => {
  it('clones a repository and reports progress', async () => {
    const src = makeRepo({ 'README.md': '# demo\n', 'src/a.ts': 'export const a = 1;\n' });
    const parent = tempDir();
    const target = join(parent, 'copy');
    const seen: string[] = [];
    const r = await cloneRepo({ url: src, target, cwd: parent, onProgress: (p) => seen.push(p.phase) });
    expect(r).toEqual({ ok: true, aborted: false });
    expect(readFileSync(join(target, 'src', 'a.ts'), 'utf8')).toBe('export const a = 1;\n');
    expect(sh(target, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('main');
    expect(seen[0]).toBe('Connecting');
  });

  it('never throws for a git failure: it says what kind it was', async () => {
    const parent = tempDir();
    const r = await cloneRepo({ url: join(parent, 'missing'), target: join(parent, 'copy'), cwd: parent });
    expect(r.ok).toBe(false);
    expect(r.failure).toBe('not_found');
    expect(existsSync(join(parent, 'copy'))).toBe(false);
  });

  it('refuses a folder that is not empty', async () => {
    const src = makeRepo();
    const parent = tempDir();
    mkdirSync(join(parent, 'copy'));
    write(join(parent, 'copy'), 'keep.txt', 'mine');
    const r = await cloneRepo({ url: src, target: join(parent, 'copy'), cwd: parent });
    expect(r.failure).toBe('exists');
    expect(readFileSync(join(parent, 'copy', 'keep.txt'), 'utf8')).toBe('mine');
  });

  it('stops when aborted', async () => {
    const src = makeRepo();
    const parent = tempDir();
    const ac = new AbortController();
    ac.abort();
    const r = await cloneRepo({ url: src, target: join(parent, 'copy'), cwd: parent, signal: ac.signal });
    expect(r).toEqual({ ok: false, aborted: true });
  });
});

describe('parseRepoList', () => {
  const json = JSON.stringify([
    { nameWithOwner: 'o/old', description: '', isPrivate: false, url: 'https://github.com/o/old', sshUrl: 'git@github.com:o/old.git', pushedAt: '2025-01-01T00:00:00Z' },
    { nameWithOwner: 'o/new', description: 'Newest', isPrivate: true, url: 'https://github.com/o/new', sshUrl: 'git@github.com:o/new.git', pushedAt: '2026-11-01T00:00:00Z' },
    { nope: true },
  ]);

  it('lists repos newest first with https clone URLs', () => {
    expect(parseRepoList(json)).toEqual([
      { nameWithOwner: 'o/new', description: 'Newest', isPrivate: true, cloneUrl: 'https://github.com/o/new.git', updatedAt: '2026-11-01T00:00:00Z' },
      { nameWithOwner: 'o/old', isPrivate: false, cloneUrl: 'https://github.com/o/old.git', updatedAt: '2025-01-01T00:00:00Z' },
    ]);
  });

  it('follows git_protocol ssh, and survives bad output', () => {
    expect(parseRepoList(json, 'ssh')[0]!.cloneUrl).toBe('git@github.com:o/new.git');
    expect(parseRepoList('not json')).toEqual([]);
    expect(parseRepoList('{}')).toEqual([]);
  });
});
