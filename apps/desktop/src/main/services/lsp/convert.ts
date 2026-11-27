/**
 * Raw LSP results → the `@oide/protocol` shapes the renderer gets. Everything a server sends is
 * untrusted input: strings are cut to the contract's limits, numbers clamped, unknown shapes
 * dropped, and every `file://` URI goes through the path guard (`toCheckoutPath`) so the renderer
 * only ever sees paths inside the checkout the document belongs to.
 */
import { isAbsolute, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  LSP_MAX_COMPLETIONS,
  LSP_MAX_DIAGNOSTICS,
  LSP_MAX_LOCATIONS,
  type LspCompletionItem,
  type LspDiagnostic,
  type LspHighlight,
  type LspHover,
  type LspLocation,
  type LspRange,
  type LspSeverity,
  type LspSignatureHelp,
  type LspSymbol,
  type LspTextEdit,
} from '@oide/protocol';
import { isInside, resolveReal } from '../../security/paths.js';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, max: number): string | undefined => (typeof v === 'string' ? (v.length > max ? `${v.slice(0, max - 1)}…` : v) : undefined);
const int = (v: unknown, min: number, max: number): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.trunc(v))) : undefined);

/** `file://` URI of an absolute path, as sent to servers. */
export function fileUri(abs: string): string {
  return pathToFileURL(abs).href;
}

/**
 * The checkout-relative path (`/` separators) of a server URI, or undefined when it is not a
 * `file:` URI, does not parse, or resolves outside `root` (symlinks included; UNC paths refused).
 */
export function toCheckoutPath(root: string, uri: unknown): string | undefined {
  if (typeof uri !== 'string' || !uri.startsWith('file:')) return undefined;
  let abs: string;
  try {
    abs = fileURLToPath(uri);
  } catch {
    return undefined;
  }
  if (!isAbsolute(abs) || !isInside(root, abs)) return undefined;
  const rel = relative(resolveReal(root), resolveReal(abs)).split('\\').join('/');
  return rel && !rel.startsWith('..') ? rel : undefined;
}

export function toPosition(v: unknown): { line: number; character: number } | undefined {
  if (!isObj(v)) return undefined;
  const line = int(v.line, 0, 10_000_000);
  const character = int(v.character, 0, 10_000_000);
  return line === undefined || character === undefined ? undefined : { line, character };
}

export function toRange(v: unknown): LspRange | undefined {
  if (!isObj(v)) return undefined;
  const start = toPosition(v.start);
  const end = toPosition(v.end);
  return start && end ? { start, end } : undefined;
}

const MD_SPECIAL = /([\\`*_{}[\]()#+\-.!<>|~])/g;

/** MarkupContent / MarkedString / MarkedString[] → Markdown. Plain text is escaped. */
export function toMarkdown(v: unknown, max = 100_000): string | undefined {
  const one = (x: unknown): string | undefined => {
    if (typeof x === 'string') return x;
    if (!isObj(x)) return undefined;
    if (typeof x.kind === 'string' && typeof x.value === 'string') return x.kind === 'markdown' ? x.value : x.value.replace(MD_SPECIAL, '\\$1');
    if (typeof x.value === 'string') {
      const lang = typeof x.language === 'string' ? x.language.replace(/[^\w+#.-]/g, '') : '';
      return `\`\`\`${lang}\n${x.value}\n\`\`\``;
    }
    return undefined;
  };
  const parts = (Array.isArray(v) ? v : [v]).map(one).filter((s): s is string => !!s && s.trim() !== '');
  if (!parts.length) return undefined;
  return str(parts.join('\n\n---\n\n'), max);
}

export function toHover(v: unknown): LspHover | null {
  if (!isObj(v)) return null;
  const contents = toMarkdown(v.contents);
  if (!contents) return null;
  const range = toRange(v.range);
  return range ? { contents, range } : { contents };
}

export function toTextEdit(v: unknown): LspTextEdit | undefined {
  if (!isObj(v) || typeof v.newText !== 'string') return undefined;
  const range = toRange(v.range);
  return range ? { range, newText: v.newText } : undefined;
}

export function toTextEdits(v: unknown, max = 10_000): LspTextEdit[] {
  if (!Array.isArray(v)) return [];
  return v.slice(0, max).flatMap((e) => toTextEdit(e) ?? []);
}

export function toDiagnostics(v: unknown): LspDiagnostic[] {
  if (!Array.isArray(v)) return [];
  const out: LspDiagnostic[] = [];
  for (const d of v) {
    if (out.length >= LSP_MAX_DIAGNOSTICS) break;
    if (!isObj(d)) continue;
    const range = toRange(d.range);
    const message = str(d.message, 4000);
    if (!range || message === undefined) continue;
    const sev = int(d.severity, 1, 4);
    const diag: LspDiagnostic = { range, message, severity: (sev ?? 1) as LspSeverity };
    const source = str(d.source, 200);
    if (source) diag.source = source;
    const code = typeof d.code === 'number' ? String(d.code) : str(d.code, 200);
    if (code) diag.code = code;
    if (Array.isArray(d.tags)) {
      const tags = [...new Set(d.tags.filter((t): t is 1 | 2 => t === 1 || t === 2))];
      if (tags.length) diag.tags = tags;
    }
    out.push(diag);
  }
  return out;
}

/** A completion item → the contract (without `index`, set by the caller). */
export function toCompletionItem(v: unknown, index: number, defaults?: Obj): LspCompletionItem | undefined {
  if (!isObj(v)) return undefined;
  const label = str(v.label, 1000);
  if (label === undefined) return undefined;
  const item: LspCompletionItem = { index, label };
  const kind = int(v.kind, 1, 25);
  if (kind) item.kind = kind;
  const detail = str(v.detail, 4000) ?? (isObj(v.labelDetails) ? str(v.labelDetails.description, 4000) : undefined);
  if (detail) item.detail = detail;
  const doc = toMarkdown(v.documentation, 50_000);
  if (doc) item.documentation = doc;
  const format = v.insertTextFormat ?? defaults?.insertTextFormat;
  let text: string | undefined;
  let range: LspRange | undefined;
  if (isObj(v.textEdit) && typeof v.textEdit.newText === 'string') {
    text = v.textEdit.newText;
    // InsertReplaceEdit: use the insert range, as VS Code does by default.
    range = toRange(v.textEdit.range) ?? toRange(v.textEdit.insert);
  } else {
    text = typeof v.insertText === 'string' ? v.insertText : typeof v.textEditText === 'string' ? v.textEditText : undefined;
    const er = defaults?.editRange;
    if (er) range = toRange(er) ?? (isObj(er) ? toRange(er.insert) : undefined);
    if (range && text === undefined) text = typeof v.label === 'string' ? v.label : undefined;
  }
  if (text !== undefined) item.insertText = str(text, 100_000)!;
  if (range) item.range = range;
  if (format === 2) item.snippet = true;
  const extra = toTextEdits(v.additionalTextEdits, 100);
  if (extra.length) item.additionalTextEdits = extra;
  const sortText = str(v.sortText, 1000);
  if (sortText) item.sortText = sortText;
  const filterText = str(v.filterText, 1000);
  if (filterText) item.filterText = filterText;
  if (v.preselect === true) item.preselect = true;
  if (v.deprecated === true || (Array.isArray(v.tags) && v.tags.includes(1))) item.deprecated = true;
  const commit = Array.isArray(v.commitCharacters) ? v.commitCharacters : Array.isArray(defaults?.commitCharacters) ? (defaults.commitCharacters as unknown[]) : undefined;
  if (commit) {
    const chars = commit.filter((c): c is string => typeof c === 'string' && c.length > 0 && c.length <= 4).slice(0, 20);
    if (chars.length) item.commitCharacters = chars;
  }
  return item;
}

/** CompletionItem[] | CompletionList → the raw items, `incomplete` and the list's item defaults. */
export function completionItems(v: unknown): { raw: unknown[]; incomplete: boolean; defaults?: Obj } {
  if (Array.isArray(v)) return { raw: v.slice(0, LSP_MAX_COMPLETIONS), incomplete: false };
  if (isObj(v) && Array.isArray(v.items)) {
    const out: { raw: unknown[]; incomplete: boolean; defaults?: Obj } = { raw: v.items.slice(0, LSP_MAX_COMPLETIONS), incomplete: v.isIncomplete === true };
    if (isObj(v.itemDefaults)) out.defaults = v.itemDefaults;
    return out;
  }
  return { raw: [], incomplete: false };
}

export function toSignatureHelp(v: unknown): LspSignatureHelp | null {
  if (!isObj(v) || !Array.isArray(v.signatures) || !v.signatures.length) return null;
  const signatures: LspSignatureHelp['signatures'] = [];
  /** The raw signature behind each kept one (some may be dropped), for its own activeParameter. */
  const raws: Obj[] = [];
  for (const s of v.signatures.slice(0, 50)) {
    if (!isObj(s)) continue;
    const label = str(s.label, 4000);
    if (label === undefined) continue;
    const parameters: LspSignatureHelp['signatures'][number]['parameters'] = [];
    if (Array.isArray(s.parameters)) {
      for (const p of s.parameters.slice(0, 100)) {
        if (!isObj(p)) continue;
        let pl: string | [number, number] | undefined = str(p.label, 1000);
        if (pl === undefined && Array.isArray(p.label) && p.label.length === 2) {
          const a = int(p.label[0], 0, 4000);
          const b = int(p.label[1], 0, 4000);
          if (a !== undefined && b !== undefined) pl = [a, b];
        }
        if (pl === undefined) continue;
        const pd = toMarkdown(p.documentation, 10_000);
        parameters.push(pd ? { label: pl, documentation: pd } : { label: pl });
      }
    }
    const doc = toMarkdown(s.documentation, 50_000);
    signatures.push(doc ? { label, documentation: doc, parameters } : { label, parameters });
    raws.push(s);
  }
  if (!signatures.length) return null;
  const activeSignature = int(v.activeSignature, 0, signatures.length - 1) ?? 0;
  const own = raws[activeSignature]?.activeParameter;
  const activeParameter = int(own ?? v.activeParameter, 0, 100) ?? 0;
  return { signatures, activeSignature, activeParameter };
}

/** Location | Location[] | LocationLink[] → locations inside `root` (others dropped). */
export function toLocations(root: string, v: unknown): LspLocation[] {
  const list = Array.isArray(v) ? v : v ? [v] : [];
  const out: LspLocation[] = [];
  const seen = new Set<string>();
  const pathCache = new Map<string, string | undefined>();
  for (const l of list) {
    if (out.length >= LSP_MAX_LOCATIONS) break;
    if (!isObj(l)) continue;
    const uri = typeof l.targetUri === 'string' ? l.targetUri : l.uri;
    const range = toRange(l.targetSelectionRange) ?? toRange(l.targetRange) ?? toRange(l.range);
    if (typeof uri !== 'string' || !range) continue;
    if (!pathCache.has(uri)) pathCache.set(uri, toCheckoutPath(root, uri));
    const path = pathCache.get(uri);
    if (!path) continue;
    const key = `${path}:${range.start.line}:${range.start.character}:${range.end.line}:${range.end.character}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ root, path, range });
  }
  return out;
}

export function toHighlights(v: unknown): LspHighlight[] {
  if (!Array.isArray(v)) return [];
  return v.slice(0, 2000).flatMap((h) => {
    if (!isObj(h)) return [];
    const range = toRange(h.range);
    if (!range) return [];
    const kind = h.kind === 1 || h.kind === 2 || h.kind === 3 ? h.kind : undefined;
    return [kind ? { range, kind } : { range }];
  });
}

/** DocumentSymbol[] (a tree) or SymbolInformation[] (flat; only those in `uri`) → symbols. */
export function toSymbols(v: unknown, uri: string): LspSymbol[] {
  if (!Array.isArray(v)) return [];
  let budget = 5000;
  const tree = (s: unknown, depth: number): LspSymbol | undefined => {
    if (!isObj(s) || budget <= 0) return undefined;
    const name = str(s.name, 1000);
    const kind = int(s.kind, 1, 26);
    let range = toRange(s.range);
    let selectionRange = toRange(s.selectionRange);
    if (!range && isObj(s.location)) {
      if (s.location.uri !== uri) return undefined;
      range = toRange(s.location.range);
      selectionRange = range;
    }
    if (!name || !kind || !range) return undefined;
    budget--;
    const sym: LspSymbol = { name, kind, range, selectionRange: selectionRange ?? range };
    const detail = str(s.detail, 1000);
    if (detail) sym.detail = detail;
    if (Array.isArray(s.children) && depth < 20) {
      const children = s.children.flatMap((c) => tree(c, depth + 1) ?? []);
      if (children.length) sym.children = children;
    }
    return sym;
  };
  return v.flatMap((s) => tree(s, 0) ?? []);
}
