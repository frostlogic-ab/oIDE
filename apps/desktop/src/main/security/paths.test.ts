import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertInside, assertInsideAny, isInside, PathOutsideRootError } from './paths';
import { AllowedRoots } from './roots';
import { isAllowedExternalUrl } from './external';

let base: string;
let root: string;
let outside: string;

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'oide-paths-'));
  root = join(base, 'project');
  outside = join(base, 'secret');
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(outside, { recursive: true });
  mkdirSync(join(base, 'project-other'), { recursive: true });
  writeFileSync(join(root, 'src', 'a.ts'), 'x');
  writeFileSync(join(outside, 'creds.txt'), 'x');
  // Directory junctions need no admin rights on Windows; plain symlinks elsewhere.
  symlinkSync(outside, join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  symlinkSync(join(root, 'src'), join(base, 'link-into-project'), process.platform === 'win32' ? 'junction' : 'dir');
});

afterAll(() => rmSync(base, { recursive: true, force: true }));

describe('assertInside', () => {
  it('accepts the root itself and files inside it', () => {
    expect(isInside(root, root)).toBe(true);
    expect(assertInside(root, join(root, 'src', 'a.ts'))).toMatch(/a\.ts$/);
    expect(isInside(root, 'src/a.ts')).toBe(true);
  });

  it('accepts paths that do not exist yet', () => {
    expect(isInside(root, join(root, 'src', 'new', 'file.ts'))).toBe(true);
  });

  it('rejects .. traversal', () => {
    expect(isInside(root, join(root, '..', 'secret', 'creds.txt'))).toBe(false);
    expect(isInside(root, '../secret/creds.txt')).toBe(false);
    expect(() => assertInside(root, join(root, 'src', '..', '..', 'secret'))).toThrow(PathOutsideRootError);
  });

  it('rejects sibling folders that share a prefix', () => {
    expect(isInside(root, join(base, 'project-other'))).toBe(false);
  });

  it('resolves symlinks/junctions that point outside', () => {
    expect(isInside(root, join(root, 'escape', 'creds.txt'))).toBe(false);
    expect(isInside(root, join(root, 'escape', 'not-yet.txt'))).toBe(false);
  });

  it('accepts a symlink outside that resolves inside', () => {
    expect(isInside(root, join(base, 'link-into-project', 'a.ts'))).toBe(true);
  });

  it('is case-insensitive on win32/darwin and case-sensitive on linux', () => {
    const upper = join(root.toUpperCase(), 'SRC', 'A.TS');
    expect(isInside(root, upper, { platform: 'win32' })).toBe(true);
    // Pure comparison check independent of the host filesystem:
    expect(isInside('/nonexistent-root/Proj', '/nonexistent-root/proj/x', { platform: 'darwin' })).toBe(true);
    expect(isInside('/nonexistent-root/Proj', '/nonexistent-root/proj/x', { platform: 'linux' })).toBe(false);
  });

  it('rejects NUL bytes and empty roots', () => {
    expect(isInside(root, join(root, 'a\0b'))).toBe(false);
    expect(isInside('', root)).toBe(false);
  });

  it('assertInsideAny picks the matching root and needs absolute candidates', () => {
    const other = join(base, 'project-other');
    expect(assertInsideAny([other, root], join(root, 'src')).root).toBe(root);
    expect(() => assertInsideAny([root], 'src/a.ts')).toThrow(PathOutsideRootError);
    expect(() => assertInsideAny([], join(root, 'src'))).toThrow(PathOutsideRootError);
  });
});

describe('AllowedRoots', () => {
  it('only allows registered roots, optionally by kind', () => {
    const roots = new AllowedRoots();
    expect(() => roots.assertAllowed(join(root, 'src'))).toThrow(PathOutsideRootError);
    roots.add(root, 'project');
    expect(roots.assertAllowed(join(root, 'src'))).toMatch(/src$/);
    expect(() => roots.assertAllowed(join(root, 'src'), ['worktree'])).toThrow();
    roots.remove(root);
    expect(roots.list()).toEqual([]);
  });
});

describe('isAllowedExternalUrl', () => {
  it('allows only https on allow-listed hosts', () => {
    expect(isAllowedExternalUrl('https://github.com/oide-dev/oide/pull/1')).toBe(true);
    expect(isAllowedExternalUrl('https://docs.anthropic.com/x')).toBe(true);
    expect(isAllowedExternalUrl('https://claude.ai/artifact/abc')).toBe(true);
    expect(isAllowedExternalUrl('http://github.com')).toBe(false);
    expect(isAllowedExternalUrl('https://evilgithub.com')).toBe(false);
    expect(isAllowedExternalUrl('https://github.com.evil.io')).toBe(false);
    expect(isAllowedExternalUrl('https://user:pw@github.com')).toBe(false);
    expect(isAllowedExternalUrl('file:///etc/passwd')).toBe(false);
    expect(isAllowedExternalUrl('javascript:alert(1)')).toBe(false);
    expect(isAllowedExternalUrl('not a url')).toBe(false);
  });
});
