import { describe, expect, it } from 'vitest';
import type { FileNameMatch } from '@oide/protocol';
import type { Command } from './commands';
import { buildCommandBarRows, quickOpenRoots, recentRows } from './quickOpen';

const cmd = (id: string, title: string, group = 'Go to'): Command => ({ id, title, group, run: () => {} });
const commands = [cmd('spawn', 'Spawn an agent', 'Agents'), cmd('market', 'Go to Marketplace'), cmd('files', 'Go to Files')];
const file = (path: string, recent = false): FileNameMatch => ({ root: '/r', path, score: 1, positions: [], recent });

describe('command bar rows', () => {
  it('mixes files and commands in sections, files first for a file-like query', () => {
    const rows = buildCommandBarRows({ query: 'retry', commands, agents: [], files: [file('src/old.ts', true), file('src/retry.ts')], recent: [] });
    expect(rows.map((r) => [r.kind, r.group])).toEqual([
      ['file', 'Recently opened'],
      ['file', 'Files'],
    ]);
  });

  it('keeps commands first when the text is part of a command title', () => {
    const rows = buildCommandBarRows({ query: 'marketpl', commands, agents: [], files: [file('docs/marketplace.md')], recent: [] });
    expect(rows[0]).toMatchObject({ kind: 'command', id: 'market' });
    expect(rows.map((r) => r.group)).toEqual(['Go to', 'Files']);
  });

  it('with ">" shows commands only', () => {
    const rows = buildCommandBarRows({ query: '>go', commands, agents: [], files: [file('go.ts')], recent: [file('a.ts', true)] });
    expect(rows.every((r) => r.kind === 'command')).toBe(true);
    expect(rows.map((r) => r.id).sort()).toEqual(['files', 'market']);
    expect(buildCommandBarRows({ query: '  >', commands, agents: [], files: [], recent: [] })).toHaveLength(3);
  });

  it('shows recently opened files above every command for an empty query', () => {
    const rows = buildCommandBarRows({ query: '', commands, agents: [], files: [], recent: [file('a.ts', true)] });
    expect(rows.map((r) => r.group)).toEqual(['Recently opened', 'Agents', 'Go to', 'Go to']);
  });

  it('carries ":line" and ":line:col" to the file rows', () => {
    const rows = buildCommandBarRows({ query: 'retry.ts:42:3', commands, agents: [], files: [file('src/retry.ts')], recent: [] });
    expect(rows[0]).toMatchObject({ kind: 'file', line: 42, column: 3 });
  });

  it('roots: the checkout each project in scope shows, labelled with its worktree branch', () => {
    const projects = [
      { id: 'a', name: 'oide', path: '/p/oide' },
      { id: 'b', name: 'billing', path: '/p/billing' },
    ] as never;
    const roots = quickOpenRoots(projects, 'all', { a: '/wt/shell' }, { a: { worktrees: [{ path: '/wt/shell', branch: 'oide/shell-layout' }] } });
    expect(roots).toEqual([
      { root: '/wt/shell', projectId: 'a', label: 'oide · shell-layout' },
      { root: '/p/billing', projectId: 'b', label: 'billing' },
    ]);
    expect(quickOpenRoots(projects, 'b', {}, {})).toHaveLength(1);
    expect(recentRows([{ root: '/x', path: 'a' }, { root: '/p/billing', path: 'b' }], roots).map((r) => r.path)).toEqual(['b']);
  });
});
