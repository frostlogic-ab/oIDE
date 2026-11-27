/**
 * Which clipboard action a key press in a terminal asks for. Windows and Linux follow Windows
 * Terminal and VS Code: Ctrl+C copies only while text is selected (otherwise it stays ^C, the
 * interrupt), Ctrl+Shift+C always copies, Ctrl+V / Ctrl+Shift+V paste, and Ctrl+Insert /
 * Shift+Insert do the same. On macOS, Cmd+C / Cmd+V go through the Edit menu to xterm's own copy
 * and paste handlers, so only the context-menu key is taken here.
 */
export type TerminalKeyAction = 'copy' | 'paste' | 'menu';

export interface KeyLike {
  key: string;
  code?: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

export function terminalKeyAction(e: KeyLike, opts: { hasSelection: boolean; isMac: boolean }): TerminalKeyAction | null {
  if (e.key === 'ContextMenu' && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) return 'menu';
  if (opts.isMac || e.altKey || e.metaKey) return null;
  // `code` keeps the shortcut on the physical key across layouts (AZERTY, Cyrillic, …).
  const letter = e.code?.startsWith('Key') ? e.code.slice(3).toLowerCase() : e.key.toLowerCase();
  if (e.ctrlKey && letter === 'c') return e.shiftKey || opts.hasSelection ? 'copy' : null;
  if (e.ctrlKey && letter === 'v') return 'paste';
  if (e.key === 'Insert' && e.ctrlKey && !e.shiftKey) return opts.hasSelection ? 'copy' : null;
  if (e.key === 'Insert' && e.shiftKey && !e.ctrlKey) return 'paste';
  return null;
}
