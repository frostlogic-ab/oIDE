/**
 * Monaco, loaded from the local `monaco-editor` package (never a CDN: the CSP forbids remote
 * scripts). Import this module lazily (`await import('./monaco/setup')`) so Monaco stays out of the
 * first bundle. Shared by the Files editor and the Review split view.
 *
 * - Editor API + editor contributions (find, folding, diff editor, codicons) + the Monarch
 *   tokenizers for every basic language. No TypeScript/JSON/CSS/HTML language services: they need
 *   their own workers and project context, and language servers come from extensions.
 * - One worker (the editor worker, for diff computation and links), inlined as a blob so it loads
 *   under `file://` in the packaged app (`worker-src 'self' blob:`).
 * - The `oide-dark` theme follows the design tokens (docs/wiki/pages/design-system.md).
 */
import * as monaco from 'monaco-editor/editor';
import 'monaco-editor/features/register.all';
import 'monaco-editor/languages/definitions/register.all';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker&inline';

declare global {
  interface Window {
    MonacoEnvironment?: { getWorker(workerId: string, label: string): Worker };
  }
}

self.MonacoEnvironment = { getWorker: () => new EditorWorker() };

export const THEME = 'oide-dark';

monaco.editor.defineTheme(THEME, {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: '', foreground: 'E6E8EB' },
    { token: 'keyword', foreground: 'C4A7E7' },
    { token: 'string', foreground: 'A8E0C6' },
    { token: 'string.escape', foreground: 'A8E0C6' },
    { token: 'comment', foreground: '7A8494' },
    { token: 'number', foreground: 'F2C078' },
    { token: 'type', foreground: '9DBBFA' },
    { token: 'type.identifier', foreground: '9DBBFA' },
    { token: 'tag', foreground: '9DBBFA' },
    { token: 'attribute.name', foreground: 'C9CED6' },
    { token: 'attribute.value', foreground: 'A8E0C6' },
    { token: 'delimiter', foreground: 'C9CED6' },
    { token: 'regexp', foreground: 'F4B8B8' },
    { token: 'key', foreground: '9DBBFA' },
    { token: 'string.key.json', foreground: '9DBBFA' },
    { token: 'keyword.md', foreground: 'C4A7E7' },
  ],
  colors: {
    'editor.background': '#0E1013',
    'editor.foreground': '#E6E8EB',
    'editorLineNumber.foreground': '#5E6774',
    'editorLineNumber.activeForeground': '#9AA3AE',
    'editor.selectionBackground': '#1B2333',
    'editor.inactiveSelectionBackground': '#1B233399',
    'editor.lineHighlightBackground': '#13161B',
    'editor.lineHighlightBorder': '#00000000',
    'editorCursor.foreground': '#7AA2F7',
    'editorIndentGuide.background1': '#1E232A',
    'editorIndentGuide.activeBackground1': '#343A44',
    'editorWhitespace.foreground': '#2B313B',
    'editorWidget.background': '#15181D',
    'editorWidget.border': '#343A44',
    'editorHoverWidget.background': '#15181D',
    'editorHoverWidget.border': '#343A44',
    'editorSuggestWidget.background': '#15181D',
    'editorSuggestWidget.border': '#343A44',
    'editorSuggestWidget.selectedBackground': '#1E2430',
    'input.background': '#0B0D10',
    'input.border': '#343A44',
    focusBorder: '#7AA2F7',
    'scrollbarSlider.background': '#343A4466',
    'scrollbarSlider.hoverBackground': '#4A515C88',
    'scrollbarSlider.activeBackground': '#4A515CAA',
    'editorGutter.background': '#0E1013',
    // Brackets stay in the text colour (the canvas has no bracket-pair colours).
    'editorBracketHighlight.foreground1': '#C9CED6',
    'editorBracketHighlight.foreground2': '#C9CED6',
    'editorBracketHighlight.foreground3': '#C9CED6',
    'editorBracketHighlight.foreground4': '#C9CED6',
    'editorBracketHighlight.foreground5': '#C9CED6',
    'editorBracketHighlight.foreground6': '#C9CED6',
    'editorBracketMatch.background': '#1E2430',
    'editorBracketMatch.border': '#343A44',
    'diffEditor.insertedLineBackground': '#12261D',
    'diffEditor.removedLineBackground': '#2A1618',
    'diffEditor.insertedTextBackground': '#22463A99',
    'diffEditor.removedTextBackground': '#4A2A2A99',
    'diffEditorGutter.insertedLineBackground': '#12261D',
    'diffEditorGutter.removedLineBackground': '#2A1618',
    'diffEditor.diagonalFill': '#1E232A',
    'diffEditor.unchangedRegionBackground': '#111418',
    'diffEditor.unchangedRegionForeground': '#9AA3AE',
  },
});

/** Options shared by every oIDE editor (JetBrains Mono 12.5 / 20, canvas gutter). */
export const BASE_OPTIONS: monaco.editor.IStandaloneEditorConstructionOptions = {
  theme: THEME,
  fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  fontSize: 12.5,
  lineHeight: 20,
  lineNumbersMinChars: 4,
  lineDecorationsWidth: 14,
  glyphMargin: false,
  folding: true,
  minimap: { enabled: false },
  renderLineHighlight: 'line',
  scrollBeyondLastLine: false,
  padding: { top: 12, bottom: 12 },
  automaticLayout: true,
  smoothScrolling: true,
  fixedOverflowWidgets: true,
  stickyScroll: { enabled: false },
  overviewRulerBorder: false,
  hideCursorInOverviewRuler: true,
  scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false },
  contextmenu: true,
  bracketPairColorization: { enabled: false },
  guides: { indentation: false },
};

const EXT_LANG: Record<string, string> = {
  json: 'javascript',
  jsonc: 'javascript',
  json5: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  mts: 'typescript',
  cts: 'typescript',
};

/** Monaco language id from a file name (by extension, then by Monaco's own registry). */
export function languageFor(path: string): string {
  const name = path.split('/').pop() ?? path;
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  if (EXT_LANG[ext]) return EXT_LANG[ext];
  const hit = monaco.languages.getLanguages().find((l) => l.extensions?.some((e) => e.toLowerCase() === `.${ext}`) || l.filenames?.includes(name));
  return hit?.id ?? 'plaintext';
}

/** Human label for the status line ("TypeScript"). */
export function languageLabel(id: string): string {
  if (id === 'plaintext') return 'Plain text';
  const l = monaco.languages.getLanguages().find((x) => x.id === id);
  return l?.aliases?.[0] ?? id;
}

export { monaco };
