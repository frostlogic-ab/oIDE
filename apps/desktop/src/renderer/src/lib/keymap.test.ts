import { describe, expect, it, vi } from 'vitest';
import { comboFromEvent, comboLabel, isEditableTarget, Keymap, normalizeCombo, portableCombo, type KeyEventLike } from './keymap';

function key(k: string, mods: Partial<Pick<KeyEventLike, 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>> = {}, target: unknown = null): KeyEventLike & { prevented: boolean } {
  const e = {
    key: k,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...mods,
    target: target as EventTarget | null,
    prevented: false,
    defaultPrevented: false,
    preventDefault() {
      this.prevented = true;
      this.defaultPrevented = true;
    },
  };
  return e;
}

const input = { tagName: 'INPUT', type: 'text', isContentEditable: false, getAttribute: () => null };
const checkbox = { tagName: 'INPUT', type: 'checkbox', isContentEditable: false, getAttribute: () => null };

describe('combo normalization', () => {
  it('normalizes bindings and events to the same string', () => {
    expect(normalizeCombo('Mod+K', false)).toBe('Ctrl+k');
    expect(normalizeCombo('Mod+K', true)).toBe('Meta+k');
    expect(normalizeCombo('shift+tab', false)).toBe('Shift+Tab');
    expect(normalizeCombo('Esc', false)).toBe('Escape');
    expect(comboFromEvent(key('K', { ctrlKey: true, shiftKey: true }))).toBe('Ctrl+Shift+k');
    expect(comboFromEvent(key('Tab', { shiftKey: true }))).toBe('Shift+Tab');
  });

  it('formats labels per platform', () => {
    expect(comboLabel('Mod+K', false)).toBe('Ctrl K');
    expect(comboLabel('Mod+K', true)).toBe('⌘ K');
    expect(comboLabel('Escape', false)).toBe('Esc');
  });

  it('detects editable targets', () => {
    expect(isEditableTarget(input as unknown as EventTarget)).toBe(true);
    expect(isEditableTarget(checkbox as unknown as EventTarget)).toBe(false);
    expect(isEditableTarget({ tagName: 'DIV', isContentEditable: true, getAttribute: () => null } as unknown as EventTarget)).toBe(true);
    expect(isEditableTarget(null)).toBe(false);
  });
});

describe('Keymap', () => {
  it('dispatches default bindings to the active scope', () => {
    const km = new Keymap();
    const next = vi.fn();
    km.pushScope('focus', { 'agent.next': next });
    const e = key('j');
    expect(km.handleKeyDown(e)).toBe(true);
    expect(next).toHaveBeenCalledTimes(1);
    expect(e.prevented).toBe(true);
    expect(km.handleKeyDown(key('x'))).toBe(false);
  });

  it('the most recent scope wins; returning false falls through', () => {
    const km = new Keymap();
    const app = vi.fn();
    const screen = vi.fn(() => false as const);
    km.pushScope('app', { 'view.back': app });
    const pop = km.pushScope('screen', { 'view.back': screen });
    km.handleKeyDown(key('Escape'));
    expect(screen).toHaveBeenCalled();
    expect(app).toHaveBeenCalledTimes(1);
    pop();
    expect(km.activeScopes()).toEqual(['app']);
  });

  it('modal scopes block lower scopes', () => {
    const km = new Keymap();
    const lower = vi.fn();
    km.pushScope('wall', { 'agent.nextNeedsYou': lower });
    km.pushScope('dialog', {}, { modal: true });
    expect(km.handleKeyDown(key('n'))).toBe(false);
    expect(lower).not.toHaveBeenCalled();
  });

  it('ignores unchorded keys inside inputs but not chorded ones', () => {
    const km = new Keymap();
    const next = vi.fn();
    const open = vi.fn();
    const back = vi.fn();
    km.pushScope('app', { 'agent.next': next, 'commandBar.open': open, 'view.back': back });
    expect(km.handleKeyDown(key('j', {}, input))).toBe(false);
    expect(km.handleKeyDown(key('Escape', {}, input))).toBe(false);
    expect(km.handleKeyDown(key('k', { ctrlKey: true }, input))).toBe(true);
    expect(next).not.toHaveBeenCalled();
    expect(back).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledTimes(1);
    // Checkboxes are not text inputs.
    expect(km.handleKeyDown(key('j', {}, checkbox))).toBe(true);
  });

  it('Mod follows the platform', () => {
    const mac = new Keymap({ isMac: true });
    const open = vi.fn();
    mac.pushScope('app', { 'commandBar.open': open });
    expect(mac.handleKeyDown(key('k', { ctrlKey: true }))).toBe(false);
    expect(mac.handleKeyDown(key('k', { metaKey: true }))).toBe(true);
    expect(mac.label('commandBar.open')).toBe('⌘ K');
  });

  it('covers every brief shortcut by default', () => {
    const km = new Keymap();
    const b = km.getBindings();
    for (const action of ['agent.next', 'agent.prev', 'agent.nextNeedsYou', 'permission.allow', 'permission.deny', 'view.back', 'commandBar.open', 'composer.send', 'agent.cycleMode']) {
      expect(b[action]?.length, action).toBeGreaterThan(0);
    }
    const send = vi.fn();
    const mode = vi.fn();
    km.pushScope('focus', { 'composer.send': send, 'agent.cycleMode': mode });
    km.handleKeyDown(key('Enter', { ctrlKey: true }, input));
    km.handleKeyDown(key('Tab', { shiftKey: true }));
    expect(send).toHaveBeenCalled();
    expect(mode).toHaveBeenCalled();
  });

  it('rebinds, persists patches and resets', () => {
    const patches: unknown[] = [];
    const km = new Keymap({ persist: (p) => void patches.push(p) });
    const next = vi.fn();
    km.pushScope('focus', { 'agent.next': next });
    km.rebind('agent.next', ['ArrowDown']);
    expect(km.handleKeyDown(key('j'))).toBe(false);
    expect(km.handleKeyDown(key('ArrowDown'))).toBe(true);
    expect(km.isCustom('agent.next')).toBe(true);
    expect(patches).toEqual([{ 'agent.next': ['ArrowDown'] }]);

    // Saved rebinds come back from Settings without being saved again.
    const restored = new Keymap({ persist: (p) => void patches.push(p) });
    restored.setOverrides({ 'agent.next': ['ArrowDown'] });
    expect(restored.getBindings()['agent.next']).toEqual(['ArrowDown']);
    expect(patches).toHaveLength(1);
    restored.resetBinding('agent.next');
    expect(restored.getBindings()['agent.next']).toEqual(['J']);
    expect(patches.at(-1)).toEqual({ 'agent.next': null });
    restored.resetBinding();
    expect(patches.at(-1)).toBeNull();
  });

  it('finds conflicts and assign() moves a combo from the action that had it', () => {
    const patches: unknown[] = [];
    const km = new Keymap({ persist: (p) => void patches.push(p) });
    expect(km.conflicts('Ctrl+K')).toEqual(['commandBar.open']);
    expect(km.conflicts('Mod+K', 'commandBar.open')).toEqual([]);
    expect(km.conflicts('Shift+J')).toEqual([]);
    km.assign('agent.next', 'Mod+K');
    expect(km.getBindings()['agent.next']).toEqual(['Mod+K']);
    expect(km.getBindings()['commandBar.open']).toEqual([]);
    expect(patches).toEqual([{ 'commandBar.open': [], 'agent.next': ['Mod+K'] }]);
  });

  it('portableCombo stores the platform modifier as Mod', () => {
    expect(portableCombo('Ctrl+k', false)).toBe('Mod+K');
    expect(portableCombo('Meta+Shift+p', true)).toBe('Mod+Shift+P');
    expect(portableCombo('Ctrl+k', true)).toBe('Ctrl+K');
    expect(portableCombo('ArrowDown', false)).toBe('ArrowDown');
  });

  it('skips events already handled or composing', () => {
    const km = new Keymap();
    const next = vi.fn();
    km.pushScope('focus', { 'agent.next': next });
    const e = key('j');
    e.defaultPrevented = true;
    expect(km.handleKeyDown(e)).toBe(false);
    expect(km.handleKeyDown({ ...key('j'), isComposing: true })).toBe(false);
    expect(next).not.toHaveBeenCalled();
  });
});
