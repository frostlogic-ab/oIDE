/**
 * Monaco ⇄ main's language servers (ADR 0019). A small hand-written bridge instead of
 * monaco-languageclient: the editor's models are bound to `(root, path)` documents, their text
 * goes to main as `lsp.open` / `lsp.change` (full text, the model's version id), and Monaco's
 * providers (hover, completion, signature help, definitions, references, highlights, symbols,
 * formatting) ask main through the `lsp.*` commands. Diagnostics arrive as `lsp.diagnostics` and
 * become markers. Only Files tabs are bound; any other model (Review's diff editor) gets nothing.
 *
 * Positions: Monaco is 1-based, LSP 0-based; both count UTF-16 code units.
 */
import { LSP_MAX_TEXT, type LspCompletionItem, type LspDiagnostic, type LspLocation, type LspRange, type LspSymbol, type LspTextEdit } from '@oide/protocol';
import { oide } from '../../../lib/bridge';
import { docKey, ensureLspEvents, onDiagnostics, useLsp } from '../lspStore';
import { languageFor, monaco } from './setup';

/** URI of the model of a Files tab (`oide:/<encoded root>/<path>`). */
export function modelUri(root: string, path: string): monaco.Uri {
  return monaco.Uri.from({ scheme: 'oide', path: `/${encodeURIComponent(root)}/${path}` });
}

/** `(root, path)` of a Files model URI (ignores the `?n=` of a renamed-over model), or undefined. */
export function docOfUri(uri: monaco.Uri): { root: string; path: string } | undefined {
  if (uri.scheme !== 'oide') return undefined;
  const m = /^\/([^/]+)\/(.+)$/.exec(uri.path);
  if (!m) return undefined;
  try {
    return { root: decodeURIComponent(m[1]!), path: m[2]! };
  } catch {
    return undefined;
  }
}

interface Binding {
  root: string;
  path: string;
  model: monaco.editor.ITextModel;
  sub: monaco.IDisposable;
  timer: ReturnType<typeof setTimeout> | undefined;
  /** Version last sent to main. */
  sent: number;
}

/** Model URI string → binding. */
const bound = new Map<string, Binding>();
/** docKey → model URI string. */
const byDoc = new Map<string, string>();
const CHANGE_DEBOUNCE_MS = 200;
const OWNER = 'lsp';

const pos = (p: monaco.IPosition) => ({ line: p.lineNumber - 1, character: p.column - 1 });
export const toMonacoRange = (r: LspRange): monaco.IRange => ({
  startLineNumber: r.start.line + 1,
  startColumn: r.start.character + 1,
  endLineNumber: r.end.line + 1,
  endColumn: r.end.character + 1,
});

const SEVERITY: Record<number, monaco.MarkerSeverity> = {
  1: monaco.MarkerSeverity.Error,
  2: monaco.MarkerSeverity.Warning,
  3: monaco.MarkerSeverity.Info,
  4: monaco.MarkerSeverity.Hint,
};

export function toMarkers(list: LspDiagnostic[]): monaco.editor.IMarkerData[] {
  return list.map((d) => {
    const m: monaco.editor.IMarkerData = { ...toMonacoRange(d.range), severity: SEVERITY[d.severity] ?? monaco.MarkerSeverity.Error, message: d.message };
    if (d.source) m.source = d.source;
    if (d.code) m.code = d.code;
    if (d.tags?.length) m.tags = d.tags.map((t) => (t === 1 ? monaco.MarkerTag.Unnecessary : monaco.MarkerTag.Deprecated));
    return m;
  });
}

function applyMarkers(b: Binding): void {
  const p = useLsp.getState().problems[docKey(b.root, b.path)];
  monaco.editor.setModelMarkers(b.model, OWNER, toMarkers(p?.list ?? []));
}

/** Send the model's text now if it changed since the last send (before asking for a feature). */
function flush(b: Binding): Promise<unknown> {
  if (b.timer) clearTimeout(b.timer);
  b.timer = undefined;
  const version = b.model.getVersionId();
  if (b.model.isDisposed() || version === b.sent) return Promise.resolve();
  b.sent = version;
  return oide.invoke('lsp.change', { root: b.root, path: b.path, version, text: b.model.getValue() }).catch(() => undefined);
}

/**
 * Bind a Files tab's model to its document: opens it in main (which starts the server on first
 * use) and keeps it in sync. Read-only (very large) models are not sent.
 */
export function lspAttach(model: monaco.editor.ITextModel, root: string, path: string, readOnly = false): void {
  ensureSetup();
  const key = model.uri.toString();
  const cur = bound.get(key);
  if (cur && cur.root === root && cur.path === path) return;
  if (cur) lspDetach(model);
  if (readOnly || model.getValueLength() > LSP_MAX_TEXT) {
    useLsp.getState().setStatus(root, path, undefined);
    return;
  }
  const b: Binding = { root, path, model, sub: { dispose() {} }, timer: undefined, sent: model.getVersionId() };
  b.sub = model.onDidChangeContent(() => {
    if (b.timer) clearTimeout(b.timer);
    b.timer = setTimeout(() => void flush(b), CHANGE_DEBOUNCE_MS);
  });
  bound.set(key, b);
  byDoc.set(docKey(root, path), key);
  applyMarkers(b);
  oide
    .invoke('lsp.open', { root, path, version: b.sent, text: model.getValue() })
    .then((status) => {
      if (bound.get(key) === b) useLsp.getState().setStatus(root, path, status.state === 'none' ? undefined : status);
    })
    .catch(() => undefined);
}

/** Unbind a model (its tab closed, or it is about to be re-bound under a new path). */
export function lspDetach(model: monaco.editor.ITextModel): void {
  const key = model.uri.toString();
  const b = bound.get(key);
  if (!b) return;
  if (b.timer) clearTimeout(b.timer);
  b.sub.dispose();
  bound.delete(key);
  if (byDoc.get(docKey(b.root, b.path)) === key) byDoc.delete(docKey(b.root, b.path));
  useLsp.getState().setStatus(b.root, b.path, undefined);
  if (!model.isDisposed()) monaco.editor.setModelMarkers(model, OWNER, []);
  void oide.invoke('lsp.close', { root: b.root, path: b.path }).catch(() => undefined);
}

/** Stop and start the server of a bound document again. */
export async function lspRestart(root: string, path: string): Promise<void> {
  const status = await oide.invoke('lsp.restart', { root, path }).catch(() => undefined);
  if (status) useLsp.getState().setStatus(root, path, status.state === 'none' ? undefined : status);
  // The fresh server needs the document again.
  const key = byDoc.get(docKey(root, path));
  const b = key ? bound.get(key) : undefined;
  if (b) {
    lspDetach(b.model);
    lspAttach(b.model, root, path);
  }
}

// ------------------------------------------------------------------ peek models

/**
 * Models for other files that a references / definition peek shows. Monaco's standalone model
 * service only resolves models that exist, so they are created from `files.read`. A tab opened on
 * one of them later adopts it (`adoptPeekModel`) and takes the content on disk.
 */
const peek = new Map<string, monaco.editor.ITextModel>();
const MAX_PEEK_MODELS = 40;
const MAX_PEEK_FILES = 20;

export function adoptPeekModel(model: monaco.editor.ITextModel, content: string): void {
  const key = model.uri.toString();
  if (!peek.has(key)) return;
  peek.delete(key);
  if (model.getValue() !== content) model.setValue(content);
}

async function ensureModels(locations: LspLocation[]): Promise<void> {
  const want: Array<{ root: string; path: string; uri: monaco.Uri }> = [];
  const seen = new Set<string>();
  for (const l of locations) {
    const uri = modelUri(l.root, l.path);
    const k = uri.toString();
    if (seen.has(k) || monaco.editor.getModel(uri)) continue;
    seen.add(k);
    want.push({ root: l.root, path: l.path, uri });
    if (want.length >= MAX_PEEK_FILES) break;
  }
  await Promise.all(
    want.map(async (w) => {
      const r = await oide.invoke('files.read', { root: w.root, path: w.path }).catch(() => undefined);
      if (!r || r.binary || monaco.editor.getModel(w.uri)) return;
      peek.set(w.uri.toString(), monaco.editor.createModel(r.content, languageFor(w.path), w.uri));
    }),
  );
  // Oldest first: drop peek models nobody shows.
  for (const [k, m] of peek) {
    if (peek.size <= MAX_PEEK_MODELS) break;
    if (m.isAttachedToEditor()) continue;
    peek.delete(k);
    m.dispose();
  }
}

// ------------------------------------------------------------------ providers

const toLocation = (l: LspLocation): monaco.languages.Location => ({ uri: modelUri(l.root, l.path), range: toMonacoRange(l.range) });

/** Binding of a model, with its pending text sent first. */
async function ready(model: monaco.editor.ITextModel): Promise<Binding | undefined> {
  const b = bound.get(model.uri.toString());
  if (!b) return undefined;
  const s = useLsp.getState().status[docKey(b.root, b.path)];
  if (s && s.state !== 'running') return undefined;
  await flush(b);
  return b;
}

const COMPLETION_KIND: Record<number, keyof typeof monaco.languages.CompletionItemKind> = {
  1: 'Text', 2: 'Method', 3: 'Function', 4: 'Constructor', 5: 'Field', 6: 'Variable', 7: 'Class', 8: 'Interface', 9: 'Module',
  10: 'Property', 11: 'Unit', 12: 'Value', 13: 'Enum', 14: 'Keyword', 15: 'Snippet', 16: 'Color', 17: 'File', 18: 'Reference',
  19: 'Folder', 20: 'EnumMember', 21: 'Constant', 22: 'Struct', 23: 'Event', 24: 'Operator', 25: 'TypeParameter',
};

type Suggestion = monaco.languages.CompletionItem & { __lsp?: { root: string; path: string; resultId: number; index: number } };

function toEdits(edits: LspTextEdit[]): monaco.languages.TextEdit[] {
  return edits.map((e) => ({ range: toMonacoRange(e.range), text: e.newText }));
}

function toSuggestion(it: LspCompletionItem, fallback: monaco.IRange, position: monaco.Position): Suggestion {
  let range: monaco.IRange = fallback;
  if (it.range) {
    const r = toMonacoRange(it.range);
    // Monaco needs a single-line range that contains the cursor.
    if (r.startLineNumber === r.endLineNumber && r.startLineNumber === position.lineNumber && r.startColumn <= position.column && r.endColumn >= position.column) range = r;
  }
  const s: Suggestion = {
    label: it.label,
    kind: monaco.languages.CompletionItemKind[COMPLETION_KIND[it.kind ?? 1] ?? 'Text'],
    insertText: it.insertText ?? it.label,
    range,
  };
  if (it.snippet) s.insertTextRules = monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet;
  if (it.detail) s.detail = it.detail;
  if (it.documentation) s.documentation = { value: it.documentation };
  if (it.sortText) s.sortText = it.sortText;
  if (it.filterText) s.filterText = it.filterText;
  if (it.preselect) s.preselect = true;
  if (it.deprecated) s.tags = [monaco.languages.CompletionItemTag.Deprecated];
  if (it.commitCharacters) s.commitCharacters = it.commitCharacters;
  if (it.additionalTextEdits) s.additionalTextEdits = toEdits(it.additionalTextEdits);
  return s;
}

function toDocumentSymbol(s: LspSymbol): monaco.languages.DocumentSymbol {
  return {
    name: s.name,
    detail: s.detail ?? '',
    kind: (s.kind - 1) as monaco.languages.SymbolKind,
    tags: [],
    range: toMonacoRange(s.range),
    selectionRange: toMonacoRange(s.selectionRange),
    ...(s.children ? { children: s.children.map(toDocumentSymbol) } : {}),
  };
}

let openFile: ((root: string, path: string, line: number, column: number) => void) | undefined;

/** The Files screen opens a definition in another file (go to definition, a peek's "open"). */
export function setLspOpenHandler(fn: typeof openFile): void {
  openFile = fn;
}

let setUp = false;

function ensureSetup(): void {
  if (setUp) return;
  setUp = true;
  ensureLspEvents();
  onDiagnostics((root, path) => {
    const key = byDoc.get(docKey(root, path));
    const b = key ? bound.get(key) : undefined;
    if (b && !b.model.isDisposed()) applyMarkers(b);
  });

  // Go to definition into another file opens it as a tab (the standalone editor has no workbench).
  monaco.editor.registerEditorOpener({
    openCodeEditor(source, resource, selectionOrPosition) {
      if (source.getModel()?.uri.toString() === resource.toString()) return false;
      const doc = docOfUri(resource);
      if (!doc || !openFile) return false;
      const at = selectionOrPosition && 'startLineNumber' in selectionOrPosition ? { lineNumber: selectionOrPosition.startLineNumber, column: selectionOrPosition.startColumn } : selectionOrPosition;
      openFile(doc.root, doc.path, at?.lineNumber ?? 1, (at?.column ?? 1) - 1);
      return true;
    },
  });

  const all = '*';
  monaco.languages.registerHoverProvider(all, {
    async provideHover(model, position) {
      const b = await ready(model);
      if (!b) return null;
      const h = await oide.invoke('lsp.hover', { root: b.root, path: b.path, position: pos(position) }).catch(() => null);
      if (!h) return null;
      return { contents: [{ value: h.contents }], ...(h.range ? { range: toMonacoRange(h.range) } : {}) };
    },
  });

  monaco.languages.registerCompletionItemProvider(all, {
    // A superset of what servers ask for; a server ignores a trigger it does not use.
    triggerCharacters: ['.', ':', '<', '"', "'", '/', '@', '#', '$', '>', '-'],
    async provideCompletionItems(model, position, context) {
      const b = await ready(model);
      if (!b) return null;
      const trigger = context.triggerKind === monaco.languages.CompletionTriggerKind.TriggerCharacter ? context.triggerCharacter : undefined;
      const list = await oide.invoke('lsp.completion', { root: b.root, path: b.path, position: pos(position), ...(trigger ? { triggerCharacter: trigger } : {}) }).catch(() => null);
      if (!list) return null;
      const word = model.getWordUntilPosition(position);
      const fallback = { startLineNumber: position.lineNumber, endLineNumber: position.lineNumber, startColumn: word.startColumn, endColumn: word.endColumn };
      return {
        incomplete: list.incomplete,
        suggestions: list.items.map((it) => {
          const s = toSuggestion(it, fallback, position);
          s.__lsp = { root: b.root, path: b.path, resultId: list.resultId, index: it.index };
          return s;
        }),
      };
    },
    async resolveCompletionItem(item: Suggestion) {
      const ref = item.__lsp;
      if (!ref || item.documentation) return item;
      const r = await oide.invoke('lsp.resolveCompletion', ref).catch(() => null);
      if (!r) return item;
      if (r.detail && !item.detail) item.detail = r.detail;
      if (r.documentation) item.documentation = { value: r.documentation };
      if (r.additionalTextEdits && !item.additionalTextEdits) item.additionalTextEdits = toEdits(r.additionalTextEdits);
      return item;
    },
  });

  monaco.languages.registerSignatureHelpProvider(all, {
    signatureHelpTriggerCharacters: ['(', ','],
    signatureHelpRetriggerCharacters: [')'],
    async provideSignatureHelp(model, position, _token, context) {
      const b = await ready(model);
      if (!b) return null;
      const trigger = context.triggerCharacter;
      const h = await oide.invoke('lsp.signatureHelp', { root: b.root, path: b.path, position: pos(position), ...(trigger ? { triggerCharacter: trigger } : {}) }).catch(() => null);
      if (!h) return null;
      return {
        value: {
          activeSignature: h.activeSignature,
          activeParameter: h.activeParameter,
          signatures: h.signatures.map((s) => ({
            label: s.label,
            ...(s.documentation ? { documentation: { value: s.documentation } } : {}),
            parameters: s.parameters.map((p) => ({ label: p.label, ...(p.documentation ? { documentation: { value: p.documentation } } : {}) })),
          })),
        },
        dispose() {},
      };
    },
  });

  const locationProvider = (command: 'lsp.definition' | 'lsp.typeDefinition' | 'lsp.implementation') => ({
    async provide(model: monaco.editor.ITextModel, position: monaco.Position): Promise<monaco.languages.Location[] | null> {
      const b = await ready(model);
      if (!b) return null;
      const list = await oide.invoke(command, { root: b.root, path: b.path, position: pos(position) }).catch(() => []);
      if (!list.length) return null;
      await ensureModels(list);
      return list.map(toLocation);
    },
  });
  const def = locationProvider('lsp.definition');
  const typeDef = locationProvider('lsp.typeDefinition');
  const impl = locationProvider('lsp.implementation');
  monaco.languages.registerDefinitionProvider(all, { provideDefinition: (m, p) => def.provide(m, p) });
  monaco.languages.registerTypeDefinitionProvider(all, { provideTypeDefinition: (m, p) => typeDef.provide(m, p) });
  monaco.languages.registerImplementationProvider(all, { provideImplementation: (m, p) => impl.provide(m, p) });

  monaco.languages.registerReferenceProvider(all, {
    async provideReferences(model, position, context) {
      const b = await ready(model);
      if (!b) return null;
      const list = await oide.invoke('lsp.references', { root: b.root, path: b.path, position: pos(position), includeDeclaration: context.includeDeclaration }).catch(() => []);
      if (!list.length) return null;
      await ensureModels(list);
      return list.map(toLocation);
    },
  });

  const HIGHLIGHT: Record<number, monaco.languages.DocumentHighlightKind> = {
    1: monaco.languages.DocumentHighlightKind.Text,
    2: monaco.languages.DocumentHighlightKind.Read,
    3: monaco.languages.DocumentHighlightKind.Write,
  };
  monaco.languages.registerDocumentHighlightProvider(all, {
    async provideDocumentHighlights(model, position) {
      const b = await ready(model);
      if (!b) return null;
      const list = await oide.invoke('lsp.highlights', { root: b.root, path: b.path, position: pos(position) }).catch(() => []);
      return list.length ? list.map((h) => ({ range: toMonacoRange(h.range), kind: HIGHLIGHT[h.kind ?? 1] ?? monaco.languages.DocumentHighlightKind.Text })) : null;
    },
  });

  monaco.languages.registerDocumentSymbolProvider(all, {
    displayName: 'Language server',
    async provideDocumentSymbols(model) {
      const b = await ready(model);
      if (!b) return null;
      const list = await oide.invoke('lsp.symbols', { root: b.root, path: b.path }).catch(() => []);
      return list.length ? list.map(toDocumentSymbol) : null;
    },
  });

  monaco.languages.registerDocumentFormattingEditProvider(all, {
    displayName: 'Language server',
    async provideDocumentFormattingEdits(model, options) {
      const b = await ready(model);
      if (!b) return null;
      const edits = await oide.invoke('lsp.format', { root: b.root, path: b.path, tabSize: options.tabSize, insertSpaces: options.insertSpaces }).catch(() => []);
      return edits.length ? toEdits(edits) : null;
    },
  });
}

/** Test seam: forget every binding (models are not disposed). */
export function __resetLspForTests(): void {
  for (const b of bound.values()) {
    if (b.timer) clearTimeout(b.timer);
    b.sub.dispose();
  }
  bound.clear();
  byDoc.clear();
}
