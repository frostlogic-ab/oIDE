import { describe, expect, it } from 'vitest';
import type { FileNode } from '@oide/protocol';
import { changesUnder, indexChanges } from './changesStore';
import { visibleRows } from './filesStore';

const f = (path: string): FileNode => ({ name: path.split('/').pop()!, path, kind: 'file' });
const d = (path: string): FileNode => ({ name: path.split('/').pop()!, path, kind: 'dir' });

describe('indexChanges', () => {
  it('tints folders with the strongest change under them and lists deleted entries per folder', () => {
    const c = indexChanges(
      [
        { path: 'src/a.ts', status: 'modified' },
        { path: 'src/old/x.ts', status: 'deleted' },
        { path: 'src/old/deep/y.ts', status: 'deleted' },
        { path: 'docs/new.md', status: 'untracked' },
      ],
      'head',
    );
    expect(c.dirs.get('src')).toBe('modified');
    expect(c.dirs.get('src/old')).toBe('deleted');
    expect(c.dirs.get('docs')).toBe('untracked');
    expect(c.ghosts.get('src')).toEqual([d('src/old')]);
    expect(c.ghosts.get('src/old')).toEqual([f('src/old/x.ts'), d('src/old/deep')]);
    expect(c.ghosts.get('src/old/deep')).toEqual([f('src/old/deep/y.ts')]);
    expect(changesUnder(c, 'src/old').map((x) => x.path)).toEqual(['src/old/x.ts', 'src/old/deep/y.ts']);
    expect(changesUnder(c, 'src/a.ts').map((x) => x.path)).toEqual(['src/a.ts']);
    expect(changesUnder(c, 'lib')).toEqual([]);
  });
});

describe('visibleRows with deleted entries', () => {
  const nodes = { '': [d('src'), f('README.md')], src: [f('src/a.ts')] };
  const base = { nodes: { r: nodes }, expanded: { r: { src: true } }, loading: {}, errors: {} };
  const ghosts = indexChanges(
    [
      { path: 'gone.md', status: 'deleted' },
      { path: 'src/old/x.ts', status: 'deleted' },
    ],
    'head',
  ).ghosts;

  it('adds deleted files and folders where the listing lacks them, sorted like the rest', () => {
    const rows = visibleRows('r', base, ghosts);
    expect(rows.map((r) => [r.key, !!r.ghost])).toEqual([
      ['src', false],
      ['src/old', true],
      ['src/a.ts', false],
      ['gone.md', true],
      ['README.md', false],
    ]);
  });

  it('opens a deleted folder from the changes, with no loading or error', () => {
    const rows = visibleRows('r', { ...base, expanded: { r: { src: true, 'src/old': true } }, errors: { r: { 'src/old': 'Cannot list' } } }, ghosts);
    const old = rows.find((r) => r.key === 'src/old')!;
    expect(old.error).toBeUndefined();
    expect(rows.map((r) => r.key)).toContain('src/old/x.ts');
  });

  it('shows nothing extra without changes, or before the root is listed', () => {
    expect(visibleRows('r', base).some((r) => r.ghost)).toBe(false);
    expect(visibleRows('other', base, ghosts)).toEqual([]);
  });
});
