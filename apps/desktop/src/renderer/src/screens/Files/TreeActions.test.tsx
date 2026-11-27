// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyDirs, files as mockFiles } from '../../lib/mock/scm';
import { useScope } from '../../stores/scope';
import { setupMockApp } from '../SourceControl/testing';
import { useFiles } from './filesStore';
import FilesScreen from './index';
import { useSearch } from './searchStore';
import type { EditorPaneProps } from './EditorPane';

vi.mock('./EditorPane', () => ({
  default: ({ active, onDirty }: EditorPaneProps) => (
    <button type="button" onClick={() => onDirty(active.id, true)}>
      Type in {active.path}
    </button>
  ),
}));

const ROOT = '/Users/you/code/billing-api';
let snapshot: Map<string, string>;

beforeEach(() => {
  snapshot = new Map(mockFiles.get(ROOT));
  useFiles.setState({ openProjects: {}, checkout: {}, expanded: {}, nodes: {}, loading: {}, errors: {}, tabs: [], active: undefined, dirty: {}, revealed: {}, pending: undefined, revealTarget: undefined, edit: undefined, clipboard: undefined });
  useSearch.setState({ open: false });
});
afterEach(() => {
  cleanup();
  mockFiles.set(ROOT, snapshot);
  emptyDirs.delete(ROOT);
});

async function setup() {
  const app = await setupMockApp({ screen: 'files', params: {} });
  useScope.setState({ scope: 'billing-api' });
  render(<FilesScreen />);
  const tree = await screen.findByRole('tree', { name: 'billing-api (main)' });
  await row(tree, 'README.md');
  return { ...app, tree };
}

/** Rows' names end with their agent markers ("README.mdReady for review: ..."): match the start. */
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const named = (name: string | RegExp) => (typeof name === 'string' ? new RegExp(`^${esc(name)}(?:$|[A-Z][a-z]+ [a-z])`) : name);
const row = (tree: HTMLElement, name: string | RegExp) => within(tree).findByRole('treeitem', { name: named(name) });
const menuFor = async (el: HTMLElement) => {
  fireEvent.contextMenu(el, { clientX: 40, clientY: 60 });
  return screen.findByRole('menu', { name: /^Actions for/ });
};
const pick = async (el: HTMLElement, item: string | RegExp) => fireEvent.click(within(await menuFor(el)).getByRole('menuitem', { name: item }));

describe('Files tree context menu', () => {
  it('right-click shows the file actions; the project header shows the root ones', async () => {
    const { tree } = await setup();
    const menu = await menuFor(await row(tree, 'README.md'));
    const names = within(menu).getAllByRole('menuitem').map((m) => m.textContent);
    for (const n of ['New file…', 'New folder…', 'Cut', 'Copy', 'Paste', 'Copy path', 'Copy relative path', 'Rename…', 'Delete'])
      expect(names.some((x) => x?.startsWith(n))).toBe(true);
    expect(within(menu).getByRole('menuitem', { name: /^Paste/ }).hasAttribute('disabled')).toBe(true);
    fireEvent.keyDown(menu, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());

    fireEvent.contextMenu(screen.getByRole('button', { name: /^billing-api/ }), { clientX: 10, clientY: 10 });
    const root = await screen.findByRole('menu', { name: 'Actions for billing-api' });
    expect(within(root).queryByRole('menuitem', { name: /^Rename/ })).toBeNull();
    expect(within(root).getByRole('menuitem', { name: /^New file/ })).toBeTruthy();
  });

  it('New file: the name is typed inline, then the file is created and opened', async () => {
    const { tree, invoke } = await setup();
    await pick(await row(tree, /^test/), /^New file/);
    const input = await within(tree).findByRole('textbox', { name: 'New file name' });
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: 'util.test.ts' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(await row(tree, 'util.test.ts')).toBeTruthy();
    expect(invoke).toHaveBeenCalledWith('files.create', { root: ROOT, path: 'test/util.test.ts', kind: 'file' });
    expect(await screen.findByRole('button', { name: 'Type in test/util.test.ts' })).toBeTruthy();
    expect(within(tree).queryByRole('textbox')).toBeNull();
  });

  it('New folder: an empty folder shows; a taken name is explained and Esc cancels', async () => {
    const { tree, invoke } = await setup();
    await pick(await row(tree, /^test/), /^New folder/);
    const input = await within(tree).findByRole('textbox', { name: 'New folder name' });
    fireEvent.change(input, { target: { value: 'invoice.test.ts' } });
    expect((await within(tree).findByRole('alert')).textContent).toMatch(/invoice\.test\.ts already exists at this location/);
    expect(input.getAttribute('aria-invalid')).toBe('true');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(invoke).not.toHaveBeenCalledWith('files.create', expect.anything());
    fireEvent.keyDown(input, { key: 'Escape' });
    await waitFor(() => expect(within(tree).queryByRole('textbox')).toBeNull());

    await pick(await row(tree, /^test/), /^New folder/);
    const again = await within(tree).findByRole('textbox', { name: 'New folder name' });
    fireEvent.change(again, { target: { value: 'fixtures' } });
    fireEvent.keyDown(again, { key: 'Enter' });
    const folder = await row(tree, /^fixtures/);
    expect(folder.getAttribute('aria-expanded')).toBe('false');
    expect(invoke).toHaveBeenCalledWith('files.create', { root: ROOT, path: 'test/fixtures', kind: 'dir' });
  });

  it('Rename (F2): the open tab and its unsaved edits follow the file', async () => {
    const { tree, invoke } = await setup();
    useFiles.getState().openFile('billing-api', ROOT, 'README.md');
    fireEvent.click(await screen.findByRole('button', { name: 'Type in README.md' }));
    fireEvent.keyDown(await row(tree, 'README.md'), { key: 'F2' });
    const input = (await within(tree).findByRole('textbox', { name: 'Rename README.md' })) as HTMLInputElement;
    expect(input.value).toBe('README.md');
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, 6]); // the stem, not ".md"
    fireEvent.change(input, { target: { value: 'GUIDE.md' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(await row(tree, 'GUIDE.md')).toBeTruthy();
    expect(within(tree).queryByRole('treeitem', { name: named('README.md') })).toBeNull();
    expect(invoke).toHaveBeenCalledWith('files.rename', { root: ROOT, from: 'README.md', to: 'GUIDE.md' });
    const tab = await screen.findByRole('tab', { name: /GUIDE\.md/ });
    expect(within(tab).getByLabelText('unsaved changes')).toBeTruthy();
  });

  it('Delete asks first, then moves the file to the trash and closes its tab', async () => {
    const { tree, invoke } = await setup();
    useFiles.getState().openFile('billing-api', ROOT, 'package.json');
    await pick(await row(tree, 'package.json'), /^Delete/);
    const dialog = await screen.findByRole('dialog', { name: 'Delete package.json?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(invoke).not.toHaveBeenCalledWith('files.delete', expect.anything());

    fireEvent.keyDown(await row(tree, 'package.json'), { key: 'Delete' });
    const again = await screen.findByRole('dialog', { name: 'Delete package.json?' });
    fireEvent.click(within(again).getByRole('button', { name: /^Move to/ }));
    await waitFor(() => expect(within(tree).queryByRole('treeitem', { name: named('package.json') })).toBeNull());
    expect(invoke).toHaveBeenCalledWith('files.delete', { root: ROOT, path: 'package.json' });
    expect(useFiles.getState().tabs).toHaveLength(0);
  });

  it('Copy / Paste duplicates (a taken name gets " copy"); Cut / Paste moves', async () => {
    const { tree, invoke } = await setup();
    await pick(await row(tree, 'README.md'), /^Copy(Ctrl|⌘)/);
    await pick(await row(tree, /^test/), /^Paste/);
    expect(invoke).toHaveBeenCalledWith('files.copy', { fromRoot: ROOT, from: 'README.md', toRoot: ROOT, toDir: 'test', move: false });
    await waitFor(() => expect(within(tree).getAllByRole('treeitem', { name: named('README.md') })).toHaveLength(2));
    // the clipboard stays: paste again next to the original
    await pick(await row(tree, 'package.json'), /^Paste/);
    expect(await row(tree, 'README copy.md')).toBeTruthy();

    // Ctrl/Cmd+X then Ctrl/Cmd+V from the keyboard
    const mod = /Mac/i.test(navigator.platform) ? { metaKey: true } : { ctrlKey: true };
    fireEvent.keyDown(await row(tree, 'README copy.md'), { key: 'x', ...mod });
    await waitFor(() => expect(within(tree).getByRole('treeitem', { name: named('README copy.md') }).className).toMatch(/opacity-60/));
    fireEvent.keyDown(await row(tree, /^test/), { key: 'v', ...mod });
    expect(invoke).toHaveBeenCalledWith('files.copy', { fromRoot: ROOT, from: 'README copy.md', toRoot: ROOT, toDir: 'test', move: true });
    await waitFor(() => expect(mockFiles.get(ROOT)!.has('test/README copy.md')).toBe(true));
    expect(mockFiles.get(ROOT)!.has('README copy.md')).toBe(false);
    expect(useFiles.getState().clipboard).toBeUndefined();
  });
});
