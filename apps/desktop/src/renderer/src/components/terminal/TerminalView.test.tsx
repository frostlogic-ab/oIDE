// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TermSession } from '../../stores/terminals';

// xterm does not run in jsdom: a stand-in that records what the view asks of it.
const fake = vi.hoisted(() => ({
  selection: '',
  keyHandler: undefined as ((e: KeyboardEvent) => boolean) | undefined,
  pasted: [] as string[],
  calls: [] as string[],
}));
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    loadAddon() {}
    open() {}
    focus() {}
    write() {}
    dispose() {}
    onData() {}
    onResize() {}
    attachCustomKeyEventHandler(fn: (e: KeyboardEvent) => boolean) {
      fake.keyHandler = fn;
    }
    hasSelection() {
      return fake.selection !== '';
    }
    getSelection() {
      return fake.selection;
    }
    clearSelection() {
      fake.selection = '';
      fake.calls.push('clearSelection');
    }
    selectAll() {
      fake.calls.push('selectAll');
    }
    clear() {
      fake.calls.push('clear');
    }
    paste(text: string) {
      fake.pasted.push(text);
    }
  },
}));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }));
vi.mock('../../lib/bridge', () => ({
  oide: { on: () => () => {}, invoke: () => new Promise(() => {}) },
  isMac: () => false,
  isNotImplemented: () => false,
  ipcErrorMessage: String,
}));

const { TerminalView } = await import('./TerminalView');

const writeText = vi.fn(async (_: string) => {});
const readText = vi.fn(async () => 'echo hi\n');

beforeEach(() => {
  fake.selection = '';
  fake.pasted = [];
  fake.calls = [];
  writeText.mockClear();
  readText.mockClear();
  Object.defineProperty(navigator, 'clipboard', { value: { writeText, readText }, configurable: true });
});
afterEach(cleanup);

let n = 0;
const session = (): TermSession => ({ key: `t${++n}`, group: 'files', cwd: '/p', title: 'Terminal 1', kind: 'shell', status: 'running' });
const key = (init: KeyboardEventInit) => new KeyboardEvent('keydown', { cancelable: true, ...init });

describe('TerminalView copy and paste', () => {
  it('Ctrl+C copies the selection (and clears it); without one it stays the interrupt', () => {
    render(<TerminalView session={session()} visible label="Terminal 1" />);
    expect(fake.keyHandler!(key({ key: 'c', code: 'KeyC', ctrlKey: true }))).toBe(true);
    fake.selection = 'hello';
    const e = key({ key: 'c', code: 'KeyC', ctrlKey: true });
    expect(fake.keyHandler!(e)).toBe(false);
    expect(e.defaultPrevented).toBe(true);
    expect(writeText).toHaveBeenCalledWith('hello');
    expect(fake.calls).toContain('clearSelection');
  });

  it('Ctrl+V pastes the clipboard through xterm', async () => {
    render(<TerminalView session={session()} visible label="Terminal 1" />);
    expect(fake.keyHandler!(key({ key: 'v', code: 'KeyV', ctrlKey: true }))).toBe(false);
    await waitFor(() => expect(fake.pasted).toEqual(['echo hi\n']));
  });

  it('right-click opens Copy, Paste, Select all and Clear', async () => {
    render(<TerminalView session={session()} visible label="Terminal 1" />);
    fireEvent.contextMenu(screen.getByLabelText('Terminal 1'), { clientX: 10, clientY: 10 });
    const menu = screen.getByRole('menu', { name: 'Terminal actions' });
    expect(menu).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: /^Copy/ }).hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByRole('menuitem', { name: /^Paste/ }));
    await waitFor(() => expect(fake.pasted).toEqual(['echo hi\n']));
    expect(screen.queryByRole('menu')).toBeNull();

    fake.selection = 'some output';
    fireEvent.contextMenu(screen.getByLabelText('Terminal 1'), { clientX: 10, clientY: 10 });
    fireEvent.click(screen.getByRole('menuitem', { name: /^Copy/ }));
    expect(writeText).toHaveBeenCalledWith('some output');

    fireEvent.contextMenu(screen.getByLabelText('Terminal 1'), { clientX: 10, clientY: 10 });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Select all' }));
    fireEvent.contextMenu(screen.getByLabelText('Terminal 1'), { clientX: 10, clientY: 10 });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Clear' }));
    expect(fake.calls).toEqual(expect.arrayContaining(['selectAll', 'clear']));
  });

  it('the context-menu key opens the menu from the keyboard', () => {
    render(<TerminalView session={session()} visible label="Terminal 1" />);
    act(() => {
      fake.keyHandler!(key({ key: 'ContextMenu' }));
    });
    expect(screen.getByRole('menu', { name: 'Terminal actions' })).toBeTruthy();
  });
});
