// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { files as mockFiles, mockHash } from '../../lib/mock/scm';
import { keymap } from '../../lib/keymap';
import { useScope } from '../../stores/scope';
import { useUi } from '../../stores/ui';
import { useSettings } from '../../stores/settings';
import { setupMockApp } from '../SourceControl/testing';
import { ancestorDirs, tabId, useFiles, visibleRows } from './filesStore';
import FilesScreen from './index';
import { useSearch } from './searchStore';
import type { EditorPaneProps } from './EditorPane';

// Monaco does not run in jsdom: a stand-in pane that can "type" into the active tab.
vi.mock('./EditorPane', () => ({
  default: ({ active, onDirty, mdView, onOpenFile }: EditorPaneProps) => (
    <>
      <button type="button" onClick={() => onDirty(active.id, true)}>
        Type in {active.path}
      </button>
      <output aria-label="Pane view">{mdView ?? 'source'}</output>
      <button type="button" onClick={() => onOpenFile?.('docs/guide.md')}>
        Follow a link
      </button>
    </>
  ),
}));

afterEach(cleanup);
beforeEach(() => {
  useFiles.setState({ openProjects: {}, checkout: {}, expanded: {}, nodes: {}, loading: {}, errors: {}, tabs: [], active: undefined, dirty: {}, mdView: {}, revealed: {}, pending: undefined, revealTarget: undefined });
  useSearch.setState({ open: false, query: '', replacement: '', replaceOpen: false, isRegex: false, matchCase: false, wholeWord: false, include: '', exclude: '', filtersOpen: false, scope: 'all', status: 'idle', files: [], searchId: undefined, ran: undefined });
});

const OIDE = '/Users/you/code/oide';

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
    fireEvent.click(screen.getByRole('button', { name: /^billing-api/ }));
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

describe('Files tree expand and collapse', () => {
  it('collapses all, expands the loaded folders again and expands to a depth from the toolbar', async () => {
    await setupMockApp({ screen: 'files', params: {} });
    render(<FilesScreen />);
    const tree = await screen.findByRole('tree', { name: 'oide (main)' });
    expect(await within(tree).findByRole('treeitem', { name: /StatusBar\.tsx/ })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Collapse all folders' }));
    await waitFor(() => expect(within(tree).queryByRole('treeitem', { name: /StatusBar\.tsx/ })).toBeNull());
    expect(within(tree).getAllByRole('treeitem').every((r) => r.getAttribute('aria-level') === '1')).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Expand loaded folders' }));
    expect(await within(tree).findByRole('treeitem', { name: /StatusBar\.tsx/ })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Collapse all folders' }));
    fireEvent.click(screen.getByRole('button', { name: 'Expand to depth' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Expand to depth 2' }));
    // depth 2: src/{extensions, main/cli, shell} open, their files listed
    expect(await within(tree).findByRole('treeitem', { name: 'loader.ts' })).toBeTruthy();
    expect(within(tree).getByRole('treeitem', { name: /extensions/ }).getAttribute('aria-expanded')).toBe('true');
  });

  it('per project folder menu with All projects, and * / - on the keyboard', async () => {
    await setupMockApp({ screen: 'files', params: {} });
    render(<FilesScreen />);
    const tree = await screen.findByRole('tree', { name: 'oide (main)' });
    await within(tree).findByRole('treeitem', { name: /StatusBar\.tsx/ });

    fireEvent.click(screen.getByRole('button', { name: 'Folder actions for oide' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Collapse all' }));
    await waitFor(() => expect(within(tree).queryByRole('treeitem', { name: /StatusBar\.tsx/ })).toBeNull());

    // * expands every sibling folder of the focused row
    const src = within(tree).getByRole('treeitem', { name: /src/ });
    fireEvent.keyDown(src, { key: 'ArrowRight' });
    const ext = await within(tree).findByRole('treeitem', { name: /extensions/ });
    fireEvent.keyDown(ext, { key: '*' });
    expect(await within(tree).findByRole('treeitem', { name: 'loader.ts' })).toBeTruthy();
    expect(await within(tree).findByRole('treeitem', { name: 'Rail.tsx' })).toBeTruthy();
    expect(within(tree).getByRole('treeitem', { name: /main\/cli/ }).getAttribute('aria-expanded')).toBe('true');

    // - on a file collapses its folder and moves to it; on an open folder collapses it
    fireEvent.keyDown(within(tree).getByRole('treeitem', { name: 'loader.ts' }), { key: '-' });
    await waitFor(() => expect(within(tree).queryByRole('treeitem', { name: 'loader.ts' })).toBeNull());
    fireEvent.keyDown(within(tree).getByRole('treeitem', { name: 'shell' }), { key: '-' });
    await waitFor(() => expect(within(tree).queryByRole('treeitem', { name: 'Rail.tsx' })).toBeNull());

    // Single project scope: no per-project menu
    cleanup();
    useScope.setState({ scope: 'billing-api' });
    render(<FilesScreen />);
    await screen.findByRole('tree', { name: 'billing-api (main)' });
    expect(screen.queryByRole('button', { name: /Folder actions/ })).toBeNull();
  });

  it('reveals the active file: opens its project, expands its folders and selects the row', async () => {
    await setupMockApp({ screen: 'files', params: {} });
    useFiles.getState().openFile('billing-api', '/Users/you/code/billing-api', 'src/invoices/invoice.ts');
    render(<FilesScreen />);
    await screen.findByRole('tree', { name: 'oide (main)' });
    expect(screen.queryByRole('tree', { name: 'billing-api (main)' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Reveal active file' }));
    const tree = await screen.findByRole('tree', { name: 'billing-api (main)' });
    const row = await within(tree).findByRole('treeitem', { name: 'invoice.ts' });
    expect(row.getAttribute('aria-selected')).toBe('true');
    await waitFor(() => expect(row.getAttribute('tabindex')).toBe('0'));
  });

  it('a quick-open request opens the file in its checkout and reveals it in the tree', async () => {
    await setupMockApp({ screen: 'files', params: {} });
    render(<FilesScreen />);
    await screen.findByRole('tree', { name: 'oide (main)' });
    useFiles.getState().requestOpen({ root: '/Users/you/code/docs-site', path: 'content/docs/start/quickstart.mdx', line: 3 });
    const tree = await screen.findByRole('tree', { name: 'docs-site (main)' });
    expect(await within(tree).findByRole('treeitem', { name: /^quickstart\.mdx/ })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /quickstart\.mdx/ }).getAttribute('aria-selected')).toBe('true');
    expect(useFiles.getState().pending).toBeUndefined();
  });
});

describe('Files editor tabs', () => {
  it('keeps the unsaved marker and the close warning after leaving Files and coming back', async () => {
    await setupMockApp({ screen: 'files', params: {} });
    useFiles.getState().openFile('billing-api', '/Users/you/code/billing-api', 'src/invoices/invoice.ts');
    const first = render(<FilesScreen />);
    fireEvent.click(await screen.findByRole('button', { name: 'Type in src/invoices/invoice.ts' }));
    expect(within(screen.getByRole('tab', { name: /invoice\.ts/ })).getByLabelText('unsaved changes')).toBeTruthy();

    // Leave the screen (AppFrame unmounts it) and come back.
    first.unmount();
    render(<FilesScreen />);
    const tab = await screen.findByRole('tab', { name: /invoice\.ts/ });
    expect(within(tab).getByLabelText('unsaved changes')).toBeTruthy();

    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    try {
      fireEvent.click(screen.getByRole('button', { name: 'Close invoice.ts' }));
      expect(confirm).toHaveBeenCalledWith('src/invoices/invoice.ts has unsaved changes. Close it anyway?');
      expect(useFiles.getState().tabs).toHaveLength(1);

      confirm.mockReturnValue(true);
      fireEvent.click(screen.getByRole('button', { name: 'Close invoice.ts' }));
      expect(useFiles.getState().tabs).toHaveLength(0);
      expect(useFiles.getState().dirty).toEqual({});
    } finally {
      confirm.mockRestore();
    }
  });

  it('right-click on a tab offers Close, Close all to the right and Close all; middle click closes', async () => {
    await setupMockApp({ screen: 'files', params: {} });
    const root = '/Users/you/code/billing-api';
    const s = useFiles.getState();
    for (const p of ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts']) s.openFile('billing-api', root, p);
    s.setActive(useFiles.getState().tabs[3]!.id); // d.ts
    render(<FilesScreen />);
    const names = () => useFiles.getState().tabs.map((t) => t.path);
    const activePath = () => useFiles.getState().tabs.find((t) => t.id === useFiles.getState().active)?.path;
    const menuFor = async (name: RegExp) => {
      fireEvent.contextMenu(await screen.findByRole('tab', { name }));
      return screen.getByRole('menu', { name: /^Actions for/ });
    };

    // Close all to the right of b.ts: the active d.ts goes, b.ts becomes active.
    fireEvent.click(within(await menuFor(/b\.ts/)).getByRole('menuitem', { name: 'Close all to the right' }));
    expect(names()).toEqual(['a.ts', 'b.ts']);
    expect(activePath()).toBe('b.ts');

    // Nothing to the right of the last tab.
    expect((within(await menuFor(/b\.ts/)).getByRole('menuitem', { name: 'Close all to the right' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Close' }));
    expect(names()).toEqual(['a.ts']);

    // Middle click closes a tab.
    s.openFile('billing-api', root, 'c.ts');
    fireEvent(await screen.findByRole('tab', { name: /c\.ts/ }), new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }));
    expect(names()).toEqual(['a.ts']);

    // Close all asks once when files have unsaved changes.
    s.openFile('billing-api', root, 'c.ts');
    s.setDirty(useFiles.getState().tabs[0]!.id, true);
    s.setDirty(useFiles.getState().tabs[1]!.id, true);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    try {
      fireEvent.click(within(await menuFor(/a\.ts/)).getByRole('menuitem', { name: 'Close all' }));
      expect(confirm).toHaveBeenCalledWith('2 files have unsaved changes. Close them anyway?');
      expect(names()).toEqual(['a.ts', 'c.ts']);
      confirm.mockReturnValue(true);
      fireEvent.click(within(await menuFor(/a\.ts/)).getByRole('menuitem', { name: 'Close all' }));
      expect(names()).toEqual([]);
      expect(useFiles.getState().dirty).toEqual({});
    } finally {
      confirm.mockRestore();
    }
  });
});

describe('Files Markdown preview', () => {
  const BILLING = '/Users/you/code/billing-api';
  const view = () => screen.getByRole('group', { name: 'Markdown view' });
  const pressed = (name: string) => within(view()).getByRole('button', { name }).getAttribute('aria-pressed');

  it('opens Markdown in the preview, switches to edit (button or Ctrl+Shift+V) and reopens in the preview', async () => {
    await setupMockApp({ screen: 'files', params: {} });
    useFiles.getState().openFile('billing-api', BILLING, 'README.md');
    render(<FilesScreen />);
    expect((await screen.findByLabelText('Pane view')).textContent).toBe('preview');
    expect(pressed('Preview')).toBe('true');
    expect(pressed('Edit')).toBe('false');

    const detach = keymap.attach(window);
    onTestFinished(detach);
    fireEvent.click(within(view()).getByRole('button', { name: 'Edit' }));
    expect(screen.getByLabelText('Pane view').textContent).toBe('edit');
    expect(pressed('Edit')).toBe('true');

    fireEvent.keyDown(window, { key: 'V', ctrlKey: true, shiftKey: true });
    expect(screen.getByLabelText('Pane view').textContent).toBe('preview');
    fireEvent.keyDown(window, { key: 'V', ctrlKey: true, shiftKey: true });
    expect(screen.getByLabelText('Pane view').textContent).toBe('edit');

    // Closing forgets the choice: the file opens on its rendered page again.
    fireEvent.click(screen.getByRole('button', { name: 'Close README.md' }));
    expect(useFiles.getState().mdView).toEqual({});
    useFiles.getState().openFile('billing-api', BILLING, 'README.md');
    await waitFor(() => expect(screen.getByLabelText('Pane view').textContent).toBe('preview'));
  });

  it('shows no Markdown toggle for other files, opens linked files and shows the source when jumping to a line', async () => {
    await setupMockApp({ screen: 'files', params: {} });
    useFiles.getState().openFile('billing-api', BILLING, 'src/invoices/invoice.ts');
    render(<FilesScreen />);
    expect((await screen.findByLabelText('Pane view')).textContent).toBe('source');
    expect(screen.queryByRole('group', { name: 'Markdown view' })).toBeNull();

    // A relative link in the preview opens that file of the same checkout.
    fireEvent.click(screen.getByRole('button', { name: 'Follow a link' }));
    expect(useFiles.getState().active).toBe(tabId(BILLING, 'docs/guide.md'));

    // Quick open to a line of a Markdown file shows its source beside the preview.
    useFiles.getState().requestOpen({ root: BILLING, path: 'README.md', line: 2 });
    await waitFor(() => expect(useFiles.getState().active).toBe(tabId(BILLING, 'README.md')));
    await waitFor(() => expect(screen.getByLabelText('Pane view').textContent).toBe('edit'));
  });
});

describe('Files search and replace', () => {
  it('searches content across projects, groups by file with highlighted previews and opens a match', async () => {
    const { invoke } = await setupMockApp({ screen: 'files', params: {} });
    render(<FilesScreen />);
    await screen.findByRole('tree', { name: 'oide (main)' });
    fireEvent.click(screen.getByRole('button', { name: 'Search in files' }));
    const panel = screen.getByRole('complementary', { name: 'Search' });
    const field = () => within(panel).getByRole('textbox', { name: 'Search text' });
    fireEvent.change(field(), { target: { value: 'StatusBar' } });
    fireEvent.keyDown(field(), { key: 'Enter' });
    expect(await within(panel).findByText(/results? in \d+ files?/)).toBeTruthy();
    expect(invoke).toHaveBeenCalledWith('files.searchContent', expect.objectContaining({ query: 'StatusBar', roots: expect.arrayContaining([OIDE, '/Users/you/code/billing-api']) }));
    const matches = within(panel).getByRole('list', { name: 'Matches in src/shell/Layout.tsx' });
    expect(within(matches).getAllByRole('button', { name: /^Line/ }).map((b) => /^Line (\d+)/.exec(b.textContent ?? '')?.[1])).toEqual(['2', '2', '9']);
    expect(matches.querySelector('.bg-review-line')?.textContent).toBe('StatusBar');

    // regex errors show inline, without a search
    fireEvent.click(within(panel).getByRole('button', { name: 'Use regular expression' }));
    fireEvent.change(field(), { target: { value: 'Status(' } });
    expect(await within(panel).findByText(/Invalid regular expression/)).toBeTruthy();
    fireEvent.click(within(panel).getByRole('button', { name: 'Use regular expression' }));
    fireEvent.change(field(), { target: { value: 'StatusBar' } });
    fireEvent.keyDown(field(), { key: 'Enter' });
    const again = await within(panel).findByRole('list', { name: 'Matches in src/shell/Layout.tsx' });
    fireEvent.click(within(again).getAllByRole('button', { name: /^Line/ })[0]!);
    await waitFor(() => expect(screen.getByRole('tab', { name: /Layout\.tsx/ }).getAttribute('aria-selected')).toBe('true'));
  });

  it('Enter searches once: the debounce from the last edit does not run the same search again', async () => {
    const { invoke } = await setupMockApp({ screen: 'files', params: {} });
    useScope.setState({ scope: 'oide' });
    render(<FilesScreen />);
    await screen.findByRole('tree', { name: 'oide (main)' });
    fireEvent.click(screen.getByRole('button', { name: 'Search in files' }));
    const panel = screen.getByRole('complementary', { name: 'Search' });
    const field = within(panel).getByRole('textbox', { name: 'Search text' });
    const searches = () => invoke.mock.calls.filter(([channel]) => channel === 'files.searchContent').length;
    fireEvent.change(field, { target: { value: 'Meter' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(await within(panel).findByText('4 results in 1 file')).toBeTruthy();
    expect(searches()).toBe(1);
    // Well past the 250ms debounce: nothing else started.
    await new Promise((r) => setTimeout(r, 400));
    expect(searches()).toBe(1);
    expect(useSearch.getState().files).toHaveLength(1);
  });

  it('replaces one match after a preview and refuses a file that changed since the search', async () => {
    const { invoke } = await setupMockApp({ screen: 'files', params: {} });
    useScope.setState({ scope: 'oide' });
    render(<FilesScreen />);
    await screen.findByRole('tree', { name: 'oide (main)' });
    fireEvent.click(screen.getByRole('button', { name: 'Search in files' }));
    const panel = screen.getByRole('complementary', { name: 'Search' });
    const field = () => within(panel).getByRole('textbox', { name: 'Search text' });
    fireEvent.click(within(panel).getByRole('button', { name: 'Toggle replace' }));
    fireEvent.change(field(), { target: { value: 'Meter' } });
    fireEvent.change(within(panel).getByRole('textbox', { name: 'Replace with' }), { target: { value: 'Gauge' } });
    fireEvent.keyDown(field(), { key: 'Enter' });
    expect(await within(panel).findByText('4 results in 1 file')).toBeTruthy();

    fireEvent.click(within(panel).getByRole('button', { name: 'Replace match at line 2, column 10 of src/shell/StatusBar.tsx' }));
    const dialog = await screen.findByRole('dialog', { name: 'Replace 1 match?' });
    const changes = within(dialog).getByLabelText('Changes in src/shell/StatusBar.tsx');
    expect(changes.querySelector('[data-kind="del"]')!.textContent).toContain("import { Meter } from './Meter';");
    expect(changes.querySelector('[data-kind="add"]')!.textContent).toContain("import { Gauge } from './Meter';");
    fireEvent.click(within(dialog).getByRole('button', { name: 'Replace 1 match' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const content = mockFiles.get(OIDE)!.get('src/shell/StatusBar.tsx')!;
    expect(content).toContain("import { Gauge } from './Meter';");
    expect(content).toContain('<Meter label="Session"');
    expect(invoke).toHaveBeenCalledWith(
      'files.replace',
      expect.objectContaining({ replacement: 'Gauge', files: [expect.objectContaining({ path: 'src/shell/StatusBar.tsx', matches: [expect.objectContaining({ line: 2, text: 'Meter' })] })] }),
    );
    expect(useUi.getState().toasts.some((t) => t.message === 'Replaced 1 match in 1 file')).toBe(true);

    // The search re-ran; change the file behind its back, then Replace all: refused as stale.
    expect(await within(panel).findByText('3 results in 1 file')).toBeTruthy();
    const tree = mockFiles.get(OIDE)!;
    tree.set('src/shell/StatusBar.tsx', `// edited by an agent\n${tree.get('src/shell/StatusBar.tsx')}`);
    expect(mockHash(tree.get('src/shell/StatusBar.tsx')!)).not.toBe(useSearch.getState().files[0]!.hash);
    fireEvent.click(within(panel).getByRole('button', { name: 'Replace all' }));
    const all = await screen.findByRole('dialog', { name: 'Replace 3 matches?' });
    fireEvent.click(within(all).getByRole('button', { name: 'Replace 3 matches' }));
    await waitFor(() => expect(useUi.getState().toasts.some((t) => t.level === 'warning' && /changed since the search/.test(t.message))).toBe(true));
    expect(tree.get('src/shell/StatusBar.tsx')).toContain('<Meter label="Session"');
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

describe('Files tree legend', () => {
  it('closes with its × for good: the choice is saved in settings and the legend stays gone', async () => {
    const { invoke } = await setupMockApp({ screen: 'files', params: {} });
    await useSettings.getState().load();
    const { unmount } = render(<FilesScreen />);

    const legend = await screen.findByRole('note', { name: 'File tree legend' });
    expect(within(legend).getByText('An agent is changing this file')).toBeTruthy();
    fireEvent.click(within(legend).getByRole('button', { name: 'Close the legend' }));
    expect(screen.queryByRole('note', { name: 'File tree legend' })).toBeNull();
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('settings.update', { patch: { ui: { filesLegendHidden: true } } }));
    expect(useSettings.getState().settings?.ui.filesLegendHidden).toBe(true);

    // Next time the screen opens (or after a restart) the legend does not come back.
    unmount();
    render(<FilesScreen />);
    await screen.findByRole('tree', { name: 'oide (main)' });
    expect(screen.queryByRole('note', { name: 'File tree legend' })).toBeNull();
  });
});
