/**
 * Keymap service. One place for every shortcut so users and extensions can rebind them.
 *
 * - Scoped to the focused view: screens push a scope (`wall`, `focus`, `dialog`, …) with handlers
 *   for the actions they support; the most recently pushed scope wins, and a `modal` scope stops
 *   lower scopes from seeing keys. Listens on the renderer window only; never registers OS-global
 *   shortcuts.
 * - Keystrokes inside inputs, textareas, selects and contenteditable are ignored unless chorded
 *   (Ctrl, Cmd/Meta or Alt held), so typing "j" in the composer never jumps agents. The same goes
 *   for anything inside a Monaco editor (its EditContext input is a plain div), a contenteditable
 *   ancestor, or the Excalidraw whiteboard (its text editor and its own single-key tool shortcuts).
 * - `Mod` means Cmd on macOS and Ctrl elsewhere.
 */

export type ActionId =
  | 'agent.next'
  | 'agent.prev'
  | 'agent.nextNeedsYou'
  | 'permission.allow'
  | 'permission.deny'
  | 'view.back'
  | 'commandBar.open'
  | 'composer.send'
  | 'agent.cycleMode'
  | 'nav.back'
  | 'nav.forward'
  | (string & {});

export const DEFAULT_BINDINGS: Readonly<Record<string, readonly string[]>> = {
  'agent.next': ['J'],
  'agent.prev': ['K'],
  'agent.nextNeedsYou': ['N'],
  'permission.allow': ['Y'],
  'permission.deny': ['D'],
  'view.back': ['Escape'],
  'commandBar.open': ['Mod+K'],
  'composer.send': ['Mod+Enter'],
  'agent.cycleMode': ['Shift+Tab'],
  'nav.back': ['Alt+ArrowLeft'],
  'nav.forward': ['Alt+ArrowRight'],
};

export const ACTION_LABELS: Readonly<Record<string, string>> = {
  'agent.next': 'Next agent',
  'agent.prev': 'Previous agent',
  'agent.nextNeedsYou': 'Next that needs you',
  'permission.allow': 'Allow once',
  'permission.deny': 'Deny',
  'view.back': 'Back / close',
  'commandBar.open': 'Open the command bar',
  'composer.send': 'Send message',
  'agent.cycleMode': 'Switch permission mode',
  'nav.back': 'Go back',
  'nav.forward': 'Go forward',
  'review.nextFile': 'Review: next file',
  'review.prevFile': 'Review: previous file',
  'review.nextHunk': 'Review: next change',
  'review.prevHunk': 'Review: previous change',
};

export interface KeyEventLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  target: EventTarget | null;
  defaultPrevented?: boolean;
  isComposing?: boolean;
  preventDefault(): void;
}

/** Return `false` to let the key fall through to lower scopes. */
export type ActionHandler = (e: KeyEventLike) => void | boolean;
export type ScopeHandlers = Partial<Record<ActionId, ActionHandler>>;

interface Scope {
  id: string;
  handlers: ScopeHandlers;
  modal: boolean;
}

const MODS = ['Ctrl', 'Alt', 'Shift', 'Meta'] as const;
const KEY_ALIASES: Record<string, string> = {
  esc: 'Escape',
  escape: 'Escape',
  enter: 'Enter',
  return: 'Enter',
  tab: 'Tab',
  space: 'Space',
  ' ': 'Space',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  up: 'ArrowUp',
  down: 'ArrowDown',
  arrowleft: 'ArrowLeft',
  arrowright: 'ArrowRight',
  arrowup: 'ArrowUp',
  arrowdown: 'ArrowDown',
  backspace: 'Backspace',
  delete: 'Delete',
};

function normKey(key: string): string {
  if (key.length === 1) return key === ' ' ? 'Space' : key.toLowerCase();
  return KEY_ALIASES[key.toLowerCase()] ?? key;
}

/** Canonical combo string, e.g. "Ctrl+Shift+k". `Mod` resolves per platform. */
export function normalizeCombo(combo: string, isMac: boolean): string {
  const parts = combo.split('+').map((p) => p.trim()).filter(Boolean);
  // "Ctrl++" style: a trailing empty part means the key is "+"
  if (combo.endsWith('++')) parts.push('+');
  const mods = new Set<string>();
  let key = '';
  for (const p of parts) {
    const l = p.toLowerCase();
    if (l === 'mod') mods.add(isMac ? 'Meta' : 'Ctrl');
    else if (l === 'ctrl' || l === 'control') mods.add('Ctrl');
    else if (l === 'alt' || l === 'option' || l === 'opt') mods.add('Alt');
    else if (l === 'shift') mods.add('Shift');
    else if (l === 'meta' || l === 'cmd' || l === 'command' || l === 'super') mods.add('Meta');
    else key = normKey(p);
  }
  return [...MODS.filter((m) => mods.has(m)), key].join('+');
}

export function comboFromEvent(e: KeyEventLike): string {
  const mods: string[] = [];
  if (e.ctrlKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (e.metaKey) mods.push('Meta');
  return [...mods, normKey(e.key)].join('+');
}

/** Human label for a combo: "Ctrl K", "⌘ K", "Shift Tab", "Esc". */
export function comboLabel(combo: string, isMac: boolean): string {
  return normalizeCombo(combo, isMac)
    .split('+')
    .map((p) => {
      if (p === 'Meta') return isMac ? '⌘' : 'Meta';
      if (p === 'Alt') return isMac ? '⌥' : 'Alt';
      if (p === 'Escape') return 'Esc';
      if (p === 'ArrowLeft') return '←';
      if (p === 'ArrowRight') return '→';
      if (p === 'ArrowUp') return '↑';
      if (p === 'ArrowDown') return '↓';
      return p.length === 1 ? p.toUpperCase() : p;
    })
    .join(' ');
}

/**
 * Containers whose keys belong to an embedded editor: Monaco (Files, artifact editors), any
 * contenteditable region, and Excalidraw (`.excalidraw`, with its `.excalidraw-wysiwyg` text editor).
 */
export const EDITOR_CONTAINER_SELECTOR =
  '.monaco-editor, [contenteditable]:not([contenteditable="false"]), .excalidraw, .excalidraw-wysiwyg';

export function isEditableTarget(target: EventTarget | null): boolean {
  if (!target || typeof (target as { tagName?: unknown }).tagName !== 'string') return false;
  const el = target as HTMLElement;
  const tag = el.tagName.toUpperCase();
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = ((el as HTMLInputElement).type || 'text').toLowerCase();
    return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file'].includes(type);
  }
  if (el.isContentEditable === true || el.getAttribute?.('contenteditable') === 'true') return true;
  return typeof el.closest === 'function' && el.closest(EDITOR_CONTAINER_SELECTOR) !== null;
}

function isChorded(e: KeyEventLike): boolean {
  return e.ctrlKey || e.metaKey || e.altKey;
}

/** A change to the user's rebinds: action → combos, `null` = back to the default; `null` overall = reset all. */
export type KeybindingPatch = Record<string, string[] | null> | null;

export interface KeymapOptions {
  isMac?: boolean;
  /** Persist user rebinds. The app sends them to Settings (`keybindings`); see lib/keybindings.ts. */
  persist?: ((patch: KeybindingPatch) => void) | null;
}

/** "Ctrl+K" on Windows and Linux, "Meta+K" on macOS → "Mod+K", so a rebind travels between machines. */
export function portableCombo(combo: string, isMac: boolean): string {
  const parts = normalizeCombo(combo, isMac).split('+');
  const mod = isMac ? 'Meta' : 'Ctrl';
  const out = parts.map((p) => (p === mod ? 'Mod' : p.length === 1 ? p.toUpperCase() : p));
  return [...out.filter((p) => p === 'Mod'), ...out.filter((p) => p !== 'Mod')].join('+');
}

export class Keymap {
  private scopes: Scope[] = [];
  private bindings = new Map<string, string[]>();
  private overrides: Record<string, string[]> = {};
  private defaults: Record<string, readonly string[]> = { ...DEFAULT_BINDINGS };
  private listeners = new Set<() => void>();
  private isMac: boolean;
  private persistFn: KeymapOptions['persist'];

  constructor(opts: KeymapOptions = {}) {
    this.isMac = opts.isMac ?? false;
    this.persistFn = opts.persist ?? null;
    this.rebuild();
  }

  get mac(): boolean {
    return this.isMac;
  }

  /** Where rebinds are saved (the app wires Settings in after boot). */
  setPersist(fn: KeymapOptions['persist']): void {
    this.persistFn = fn ?? null;
  }

  /** Replace the user's rebinds with the saved ones (from Settings). Does not persist. */
  setOverrides(overrides: Readonly<Record<string, readonly string[]>>): void {
    const next = Object.fromEntries(Object.entries(overrides).map(([a, c]) => [a, [...c]]));
    if (JSON.stringify(next) === JSON.stringify(this.overrides)) return;
    this.overrides = next;
    this.rebuild();
  }

  setPlatform(isMac: boolean): void {
    this.isMac = isMac;
    this.emit();
  }

  /** Register default bindings for an action (extensions contributing keybindings use this). */
  define(action: ActionId, combos: string[]): void {
    this.defaults[action] ??= combos;
    this.rebuild();
  }

  rebind(action: ActionId, combos: string[]): void {
    this.overrides[action] = [...combos];
    this.persist({ [action]: [...combos] });
    this.rebuild();
  }

  /**
   * Bind `combo` to `action` as its only key, taking it away from every other action that had it
   * (the "Saving removes it there" choice in Settings). One persisted patch.
   */
  assign(action: ActionId, combo: string): void {
    const patch: Record<string, string[]> = {};
    for (const other of this.conflicts(combo, action)) {
      const left = (this.bindings.get(other) ?? []).filter((c) => normalizeCombo(c, this.isMac) !== normalizeCombo(combo, this.isMac));
      this.overrides[other] = left;
      patch[other] = left;
    }
    this.overrides[action] = [combo];
    patch[action] = [combo];
    this.persist(patch);
    this.rebuild();
  }

  resetBinding(action?: ActionId): void {
    if (action) delete this.overrides[action];
    else this.overrides = {};
    this.persist(action ? { [action]: null } : null);
    this.rebuild();
  }

  getBindings(): Record<string, string[]> {
    return Object.fromEntries(this.bindings);
  }

  /** Built-in combos of an action (what Reset goes back to). */
  defaultsFor(action: ActionId): readonly string[] {
    return this.defaults[action] ?? [];
  }

  /** True when the user changed this action's keys. */
  isCustom(action: ActionId): boolean {
    return Object.prototype.hasOwnProperty.call(this.overrides, action);
  }

  /** Other actions that `combo` already triggers (for the conflict warning). */
  conflicts(combo: string, except?: ActionId): string[] {
    const want = normalizeCombo(combo, this.isMac);
    return this.actionsFor(want).filter((a) => a !== except);
  }

  /** First combo of an action, formatted for display ("Ctrl K"). */
  label(action: ActionId): string {
    const combo = this.bindings.get(action)?.[0];
    return combo ? comboLabel(combo, this.isMac) : '';
  }

  /** Activate a scope. Returns a function that removes it. */
  pushScope(id: string, handlers: ScopeHandlers, opts: { modal?: boolean } = {}): () => void {
    const scope: Scope = { id, handlers, modal: opts.modal ?? false };
    this.scopes.push(scope);
    return () => {
      this.scopes = this.scopes.filter((s) => s !== scope);
    };
  }

  activeScopes(): string[] {
    return this.scopes.map((s) => s.id);
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Returns true when an action handled the key (and the default was prevented). */
  handleKeyDown(e: KeyEventLike): boolean {
    if (e.defaultPrevented || e.isComposing) return false;
    if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return false;
    if (isEditableTarget(e.target) && !isChorded(e)) return false;
    const combo = comboFromEvent(e);
    const actions = this.actionsFor(combo);
    if (!actions.length) return false;
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const scope = this.scopes[i]!;
      for (const action of actions) {
        const handler = scope.handlers[action];
        if (!handler) continue;
        if (handler(e) === false) continue;
        e.preventDefault();
        return true;
      }
      if (scope.modal) return false;
    }
    return false;
  }

  attach(target: Pick<Window, 'addEventListener' | 'removeEventListener'>): () => void {
    const listener = (e: Event) => {
      this.handleKeyDown(e as KeyboardEvent);
    };
    target.addEventListener('keydown', listener);
    return () => target.removeEventListener('keydown', listener);
  }

  private actionsFor(combo: string): string[] {
    const out: string[] = [];
    for (const [action, combos] of this.bindings) {
      if (combos.some((c) => normalizeCombo(c, this.isMac) === combo)) out.push(action);
    }
    return out;
  }

  private rebuild(): void {
    this.bindings = new Map(Object.entries(this.defaults).map(([a, c]) => [a, [...c]]));
    for (const [a, c] of Object.entries(this.overrides)) this.bindings.set(a, [...c]);
    this.emit();
  }

  private persist(patch: KeybindingPatch): void {
    try {
      this.persistFn?.(patch);
    } catch {
      /* saving failed; the rebind still applies until the next start */
    }
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }
}

/**
 * The app-wide keymap. main.tsx attaches it to `window` and sets the platform; lib/keybindings.ts
 * loads the user's rebinds from Settings and saves changes back there.
 */
export const keymap = new Keymap();
