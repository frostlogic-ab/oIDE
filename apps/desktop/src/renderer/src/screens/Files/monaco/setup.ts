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
import { language as jsLanguage } from 'monaco-editor/languages/definitions/javascript/javascript';
import { language as tsLanguage } from 'monaco-editor/languages/definitions/typescript/typescript';

declare global {
  interface Window {
    MonacoEnvironment?: { getWorker(workerId: string, label: string): Worker };
  }
}

self.MonacoEnvironment = { getWorker: () => new EditorWorker() };

export const THEME = 'oide-dark';

/**
 * The canvas tints function and component names (`StatusBar`, `useSessions`, `.filter`) in the
 * link blue. Monarch's TypeScript tokenizer calls every lower-case name `identifier`, so derive a
 * tokenizer that first marks a name followed by `(` (optionally with type arguments) as
 * `identifier.function`. Capitalised names are already `type.identifier` (blue).
 */
export function withFunctionNames(lang: monaco.languages.IMonarchLanguage): monaco.languages.IMonarchLanguage {
  const common = (lang.tokenizer.common ?? []) as monaco.languages.IMonarchLanguageRule[];
  const fn: monaco.languages.IMonarchLanguageRule = [
    /[a-z_$][\w$]*(?=\s*(?:<[\w$.,\s[\]]*>)?\s*\()/,
    { cases: { '@keywords': 'keyword', '@default': 'identifier.function' } },
  ];
  return { ...lang, tokenizer: { ...lang.tokenizer, common: [fn, ...common] } };
}

// Registered eagerly: a registered tokenizer wins over the lazy factory of register.all.
monaco.languages.setMonarchTokensProvider('typescript', withFunctionNames(tsLanguage));
monaco.languages.setMonarchTokensProvider('javascript', withFunctionNames(jsLanguage));

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
    { token: 'identifier.function', foreground: '9DBBFA' },
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
    // 5.0:1 on the editor ground (the canvas's #5E6774 is 3.3:1, below the 4.5:1 rule).
    'editorLineNumber.foreground': '#7A8494',
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
    // Files minimap: same ground as the editor, a soft slider over the visible lines.
    'minimap.background': '#0E1013',
    'minimap.selectionHighlight': '#7AA2F766',
    'minimap.findMatchHighlight': '#F2C07899',
    'minimapSlider.background': '#9AA3AE1F',
    'minimapSlider.hoverBackground': '#9AA3AE2E',
    'minimapSlider.activeBackground': '#9AA3AE40',
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
  // JetBrains Mono ligatures (`=>` as one glyph), as the canvas renders code.
  fontLigatures: true,
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

/**
 * The Files editor's minimap: a small rendering of the whole file on the right, with a slider over
 * the lines in view. Click to jump, drag the slider to scroll. Diffs and artifact editors keep it off.
 */
export const FILE_MINIMAP: monaco.editor.IEditorMinimapOptions = {
  enabled: true,
  side: 'right',
  showSlider: 'always',
  renderCharacters: true,
  size: 'proportional',
  scale: 1,
  maxColumn: 100,
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
