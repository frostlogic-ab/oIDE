import { describe, expect, it } from 'vitest';
import { terminalKeyAction, type KeyLike } from './clipboardKeys';

const key = (k: string, mods: Partial<KeyLike> = {}): KeyLike => ({
  key: k,
  code: /^[a-z]$/i.test(k) ? `Key${k.toUpperCase()}` : k,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  ...mods,
});
const win = (hasSelection: boolean) => ({ hasSelection, isMac: false });

describe('terminalKeyAction (Windows and Linux)', () => {
  it('Ctrl+C copies only with a selection; otherwise it stays the interrupt', () => {
    expect(terminalKeyAction(key('c', { ctrlKey: true }), win(true))).toBe('copy');
    expect(terminalKeyAction(key('c', { ctrlKey: true }), win(false))).toBeNull();
  });

  it('Ctrl+Shift+C always copies; Ctrl+V and Ctrl+Shift+V paste', () => {
    expect(terminalKeyAction(key('C', { ctrlKey: true, shiftKey: true }), win(false))).toBe('copy');
    expect(terminalKeyAction(key('v', { ctrlKey: true }), win(false))).toBe('paste');
    expect(terminalKeyAction(key('V', { ctrlKey: true, shiftKey: true }), win(false))).toBe('paste');
  });

  it('Ctrl+Insert copies a selection, Shift+Insert pastes', () => {
    expect(terminalKeyAction(key('Insert', { ctrlKey: true }), win(true))).toBe('copy');
    expect(terminalKeyAction(key('Insert', { ctrlKey: true }), win(false))).toBeNull();
    expect(terminalKeyAction(key('Insert', { shiftKey: true }), win(false))).toBe('paste');
  });

  it('follows the physical key on other layouts', () => {
    expect(terminalKeyAction({ ...key('с', { ctrlKey: true }), code: 'KeyC' }, win(true))).toBe('copy');
  });

  it('leaves everything else to the shell', () => {
    for (const k of [key('c'), key('v'), key('d', { ctrlKey: true }), key('v', { ctrlKey: true, altKey: true }), key('Insert')])
      expect(terminalKeyAction(k, win(true))).toBeNull();
  });
});

describe('terminalKeyAction (macOS)', () => {
  const mac = { hasSelection: true, isMac: true };
  it('leaves Cmd+C / Cmd+V to the Edit menu and Ctrl+C / Ctrl+V to the shell', () => {
    expect(terminalKeyAction(key('c', { metaKey: true }), mac)).toBeNull();
    expect(terminalKeyAction(key('v', { metaKey: true }), mac)).toBeNull();
    expect(terminalKeyAction(key('c', { ctrlKey: true }), mac)).toBeNull();
    expect(terminalKeyAction(key('v', { ctrlKey: true }), mac)).toBeNull();
  });
});

describe('terminalKeyAction (menu key)', () => {
  it('opens the menu on every platform', () => {
    expect(terminalKeyAction(key('ContextMenu'), win(false))).toBe('menu');
    expect(terminalKeyAction(key('ContextMenu'), { hasSelection: false, isMac: true })).toBe('menu');
  });
});
