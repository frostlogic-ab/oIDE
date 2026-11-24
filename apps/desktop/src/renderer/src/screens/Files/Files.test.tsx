// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setupMockApp } from '../SourceControl/testing';
import { ancestorDirs, useFiles, visibleRows } from './filesStore';
import FilesScreen from './index';

afterEach(cleanup);
beforeEach(() => {
  useFiles.setState({ openProjects: {}, checkout: {}, expanded: {}, nodes: {}, loading: {}, errors: {}, tabs: [], active: undefined, revealed: {} });
});

describe('Files tree', () => {
  it('lists one tree per project, expands folders lazily and marks files agents are changing', async () => {
    const { invoke } = await setupMockApp({ screen: 'files', params: {} });
    render(<FilesScreen />);

    const tree = await screen.findByRole('tree', { name: 'oide (main)' });
    // first project open, folders with agent changes revealed (compacted "main/cli" chain)
    expect(await within(tree).findByRole('treeitem', { name: /main\/cli/ })).toBeTruthy();
    expect(await within(tree).findByRole('treeitem', { name: /StatusBar\.tsx/ })).toBeTruthy();
    expect(within(tree).getAllByRole('img', { name: 'Being edited by Wire the Claude Code CLI bridge (waiting on you)' }).length).toBeGreaterThan(0);
    expect(screen.getByRole('combobox', { name: 'Branch or worktree shown for billing-api' })).toBeTruthy();
    expect(screen.queryByRole('tree', { name: /billing-api/ })).toBeNull();

    // lazy expansion of a folder with no agent changes
    const ext = within(tree).getByRole('treeitem', { name: /extensions/ });
    expect(ext.getAttribute('aria-expanded')).toBe('false');
    expect(within(tree).queryByRole('treeitem', { name: 'loader.ts' })).toBeNull();
    fireEvent.click(ext);
    expect(await within(tree).findByRole('treeitem', { name: 'loader.ts' })).toBeTruthy();
    expect(within(tree).getByRole('treeitem', { name: /extensions/ }).getAttribute('aria-expanded')).toBe('true');
    expect(invoke).toHaveBeenCalledWith('files.tree', { root: '/Users/you/code/oide', dir: 'src/extensions' });

    // keyboard: Left collapses, Right expands again
    const row = within(tree).getByRole('treeitem', { name: /extensions/ });
    row.focus();
    fireEvent.keyDown(row, { key: 'ArrowLeft' });
    await waitFor(() => expect(within(tree).queryByRole('treeitem', { name: 'loader.ts' })).toBeNull());
    fireEvent.keyDown(within(tree).getByRole('treeitem', { name: /extensions/ }), { key: 'ArrowRight' });
    expect(await within(tree).findByRole('treeitem', { name: 'loader.ts' })).toBeTruthy();

    // opening another project's tree
    fireEvent.click(screen.getByRole('button', { name: /billing-api/ }));
    expect(await screen.findByRole('tree', { name: 'billing-api (main)' })).toBeTruthy();
  });

  it('switches a project to an agent worktree with its menu', async () => {
    const { invoke } = await setupMockApp({ screen: 'files', params: {} });
    render(<FilesScreen />);
    const select = await screen.findByRole('combobox', { name: 'Branch or worktree shown for oide' });
    await waitFor(() => expect(within(select).getByRole('option', { name: 'shell-layout' })).toBeTruthy());
    fireEvent.change(select, { target: { value: (within(select).getByRole('option', { name: 'shell-layout' }) as HTMLOptionElement).value } });
    expect(await screen.findByRole('tree', { name: 'oide (shell-layout)' })).toBeTruthy();
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('files.tree', { root: '/Users/you/.oide/worktrees/oide/shell-layout', dir: '' }));
  });
});

describe('tree model', () => {
  it('compacts single-folder chains and nests expanded folders', () => {
    const s = {
      nodes: {
        r: {
          '': [
            { name: 'src', path: 'src', kind: 'dir' as const },
            { name: 'a.md', path: 'a.md', kind: 'file' as const },
          ],
          src: [{ name: 'main', path: 'src/main', kind: 'dir' as const }],
          'src/main': [{ name: 'x.ts', path: 'src/main/x.ts', kind: 'file' as const }],
        },
      },
      expanded: { r: { src: true } },
      loading: {},
      errors: {},
    };
    expect(visibleRows('r', s).map((r) => [r.label, r.depth])).toEqual([
      ['src/main', 0],
      ['x.ts', 1],
      ['a.md', 0],
    ]);
    expect(ancestorDirs(['src/main/x.ts', 'docs/a.md'])).toEqual(['src', 'docs', 'src/main']);
  });
});
