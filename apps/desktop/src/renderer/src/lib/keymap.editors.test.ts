// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isEditableTarget, Keymap, type KeyEventLike } from './keymap';

/** Single-key shortcuts must not fire while typing in embedded editors (Monaco, contenteditable, Excalidraw). */

function keyOn(target: Element, k: string, mods: Partial<Pick<KeyEventLike, 'ctrlKey' | 'metaKey' | 'altKey'>> = {}): KeyEventLike {
  return {
    key: k,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...mods,
    target,
    defaultPrevented: false,
    preventDefault() {},
  };
}

function mount(html: string): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = html;
  document.body.append(host);
  return host;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('keymap inside embedded editors', () => {
  const singles = ['j', 'k', 'n', 'y', 'd'];

  function scope() {
    const km = new Keymap();
    const handlers = {
      'agent.next': vi.fn(),
      'agent.prev': vi.fn(),
      'agent.nextNeedsYou': vi.fn(),
      'permission.allow': vi.fn(),
      'permission.deny': vi.fn(),
      'commandBar.open': vi.fn(),
    };
    km.pushScope('app', handlers);
    return { km, handlers };
  }

  it.each([
    // Monaco's EditContext input is a plain div inside .monaco-editor (no textarea, no contenteditable).
    ['Monaco', '<div class="monaco-editor"><div class="overflow-guard"><div class="native-edit-context" tabindex="0"><span id="t">x</span></div></div></div>'],
    ['a contenteditable ancestor', '<div contenteditable="true"><p><span id="t">x</span></p></div>'],
    ['the Excalidraw text editor', '<div class="excalidraw"><div class="excalidraw-textEditorContainer"><div class="excalidraw-wysiwyg" id="t"></div></div></div>'],
    ['the Excalidraw canvas', '<div class="excalidraw"><canvas class="interactive" id="t"></canvas></div>'],
  ])('ignores J, K, N, Y and D typed in %s, but chorded keys still work', (_name, html) => {
    const target = mount(html).querySelector('#t')!;
    expect(isEditableTarget(target)).toBe(true);
    const { km, handlers } = scope();
    for (const k of singles) expect(km.handleKeyDown(keyOn(target, k))).toBe(false);
    expect(handlers['agent.next']).not.toHaveBeenCalled();
    expect(handlers['agent.prev']).not.toHaveBeenCalled();
    expect(handlers['agent.nextNeedsYou']).not.toHaveBeenCalled();
    expect(handlers['permission.allow']).not.toHaveBeenCalled();
    expect(handlers['permission.deny']).not.toHaveBeenCalled();
    expect(km.handleKeyDown(keyOn(target, 'k', { ctrlKey: true }))).toBe(true);
    expect(handlers['commandBar.open']).toHaveBeenCalledTimes(1);
  });

  it('still fires single keys on ordinary UI; a contenteditable="false" chip inside an editor counts as the editor', () => {
    const host = mount('<button id="b">Tile</button><div contenteditable="true"><span contenteditable="false" id="chip">chip</span></div>');
    const { km, handlers } = scope();
    expect(km.handleKeyDown(keyOn(host.querySelector('#b')!, 'j'))).toBe(true);
    expect(handlers['agent.next']).toHaveBeenCalledTimes(1);
    // A non-editable chip inside an editable region is still part of that editor.
    expect(isEditableTarget(host.querySelector('#chip'))).toBe(true);
  });
});
