import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { LSP_MAX_DIAGNOSTICS, LspCompletionItem, LspDiagnostic, LspSignatureHelp, LspSymbol } from '@oide/protocol';
import { afterAll, describe, expect, it } from 'vitest';
import {
  completionItems,
  fileUri,
  toCheckoutPath,
  toCompletionItem,
  toDiagnostics,
  toHighlights,
  toHover,
  toLocations,
  toMarkdown,
  toSignatureHelp,
  toSymbols,
  toTextEdits,
} from './convert.js';

const R = (l1: number, c1: number, l2: number, c2: number) => ({ start: { line: l1, character: c1 }, end: { line: l2, character: c2 } });

const root = mkdtempSync(join(tmpdir(), 'oide-lsp-convert-'));
const outside = mkdtempSync(join(tmpdir(), 'oide-lsp-outside-'));
mkdirSync(join(root, 'src'), { recursive: true });
writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
writeFileSync(join(outside, 'b.ts'), 'secret\n');
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe('toCheckoutPath', () => {
  it('maps file URIs inside the root to a relative path with / separators', () => {
    expect(toCheckoutPath(root, fileUri(join(root, 'src', 'a.ts')))).toBe('src/a.ts');
    // A file that does not exist yet still maps (the server may report a generated file).
    expect(toCheckoutPath(root, fileUri(join(root, 'gen', 'new.ts')))).toBe('gen/new.ts');
  });

  it('drops the root itself, URIs outside it, non-file URIs and garbage', () => {
    expect(toCheckoutPath(root, fileUri(root))).toBeUndefined();
    expect(toCheckoutPath(root, fileUri(join(outside, 'b.ts')))).toBeUndefined();
    expect(toCheckoutPath(root, `${fileUri(root)}/../${encodeURIComponent('x')}`)).toBeUndefined();
    expect(toCheckoutPath(root, 'untitled:Untitled-1')).toBeUndefined();
    expect(toCheckoutPath(root, 'https://example.invalid/src/a.ts')).toBeUndefined();
    expect(toCheckoutPath(root, 'file://server/share/src/a.ts')).toBeUndefined(); // UNC (win32) / a host (posix)
    expect(toCheckoutPath(root, 'file:///%00')).toBeUndefined();
    expect(toCheckoutPath(root, 42)).toBeUndefined();
  });
});

describe('toMarkdown / toHover', () => {
  it('passes Markdown through and escapes plain text', () => {
    expect(toMarkdown({ kind: 'markdown', value: '**bold** `code`' })).toBe('**bold** `code`');
    expect(toMarkdown({ kind: 'plaintext', value: 'a*b_c <img src=x>' })).toBe('a\\*b\\_c \\<img src=x\\>');
    expect(toMarkdown('plain string')).toBe('plain string');
  });

  it('turns MarkedString code into fenced blocks with a sanitised language', () => {
    expect(toMarkdown({ language: 'typescript', value: 'const a: number' })).toBe('```typescript\nconst a: number\n```');
    expect(toMarkdown({ language: 'ts`\n<x>', value: 'x' })).toBe('```tsx\nx\n```');
  });

  it('joins arrays with a rule, skipping empty parts, and cuts to the limit', () => {
    expect(toMarkdown(['first', '', { language: 'js', value: 'f()' }, 7])).toBe('first\n\n---\n\n```js\nf()\n```');
    expect(toMarkdown(['', '  '])).toBeUndefined();
    expect(toMarkdown(null)).toBeUndefined();
    const long = toMarkdown('x'.repeat(50), 10)!;
    expect(long).toHaveLength(10);
    expect(long.endsWith('…')).toBe(true);
  });

  it('toHover keeps a valid range and answers null without contents', () => {
    expect(toHover({ contents: { kind: 'markdown', value: 'hi' }, range: R(1, 2, 1, 4) })).toEqual({ contents: 'hi', range: R(1, 2, 1, 4) });
    expect(toHover({ contents: 'hi', range: { start: { line: 'x' } } })).toEqual({ contents: 'hi' });
    expect(toHover({ contents: [] })).toBeNull();
    expect(toHover('nope')).toBeNull();
  });
});

describe('toCompletionItem / completionItems', () => {
  it('uses a TextEdit as the insert text and range', () => {
    const item = toCompletionItem({ label: 'log', kind: 2, detail: 'method', textEdit: { range: R(0, 4, 0, 6), newText: 'log()' }, sortText: '0', filterText: 'lo', preselect: true }, 3)!;
    expect(item).toEqual({ index: 3, label: 'log', kind: 2, detail: 'method', insertText: 'log()', range: R(0, 4, 0, 6), sortText: '0', filterText: 'lo', preselect: true });
    expect(LspCompletionItem.safeParse(item).success).toBe(true);
  });

  it('uses the insert range of an InsertReplaceEdit', () => {
    const item = toCompletionItem({ label: 'x', textEdit: { newText: 'xyz', insert: R(0, 0, 0, 1), replace: R(0, 0, 0, 3) } }, 0)!;
    expect(item.insertText).toBe('xyz');
    expect(item.range).toEqual(R(0, 0, 0, 1));
  });

  it('applies the list item defaults: editRange (plain and insert/replace), insertTextFormat, commitCharacters', () => {
    const list = completionItems({
      isIncomplete: true,
      itemDefaults: { editRange: R(2, 0, 2, 3), insertTextFormat: 2, commitCharacters: ['.', '(', '', 'toolong'] },
      items: [{ label: 'alpha' }, { label: 'beta', textEditText: 'beta($1)' }, { label: 'gamma', insertTextFormat: 1 }],
    });
    expect(list.incomplete).toBe(true);
    const [a, b, c] = list.raw.map((r, i) => toCompletionItem(r, i, list.defaults)!);
    expect(a).toMatchObject({ insertText: 'alpha', range: R(2, 0, 2, 3), snippet: true, commitCharacters: ['.', '('] });
    expect(b).toMatchObject({ insertText: 'beta($1)', range: R(2, 0, 2, 3), snippet: true });
    expect(c!.snippet).toBeUndefined(); // the item's own format wins

    const ir = completionItems({ items: [{ label: 'q' }], itemDefaults: { editRange: { insert: R(0, 1, 0, 2), replace: R(0, 1, 0, 5) } } });
    expect(toCompletionItem(ir.raw[0], 0, ir.defaults)).toMatchObject({ insertText: 'q', range: R(0, 1, 0, 2) });
  });

  it('marks snippets, deprecation (flag or tag) and keeps documentation and extra edits', () => {
    expect(toCompletionItem({ label: 's', insertText: 'for (${1:i})', insertTextFormat: 2 }, 0)).toMatchObject({ insertText: 'for (${1:i})', snippet: true });
    expect(toCompletionItem({ label: 'd', deprecated: true }, 0)!.deprecated).toBe(true);
    expect(toCompletionItem({ label: 't', tags: [1] }, 0)!.deprecated).toBe(true);
    const doc = toCompletionItem({ label: 'x', documentation: { kind: 'plaintext', value: 'a_b' }, additionalTextEdits: [{ range: R(0, 0, 0, 0), newText: 'import x;\n' }, { bad: 1 }] }, 0)!;
    expect(doc.documentation).toBe('a\\_b');
    expect(doc.additionalTextEdits).toEqual([{ range: R(0, 0, 0, 0), newText: 'import x;\n' }]);
    expect(toCompletionItem({ label: 'ld', labelDetails: { description: 'from ./x' } }, 0)!.detail).toBe('from ./x');
  });

  it('drops items without a label and accepts a bare array; anything else is empty', () => {
    expect(toCompletionItem({ kind: 1 }, 0)).toBeUndefined();
    expect(toCompletionItem('x', 0)).toBeUndefined();
    expect(completionItems([{ label: 'a' }])).toEqual({ raw: [{ label: 'a' }], incomplete: false });
    expect(completionItems(null)).toEqual({ raw: [], incomplete: false });
  });
});

describe('toLocations', () => {
  const inside = fileUri(join(root, 'src', 'a.ts'));

  it('keeps locations inside the root and drops outside, non-file and malformed ones', () => {
    const out = toLocations(root, [
      { uri: inside, range: R(0, 13, 0, 14) },
      { uri: fileUri(join(outside, 'b.ts')), range: R(0, 0, 0, 1) },
      { uri: pathToFileURL(join(tmpdir(), 'elsewhere.ts')).href, range: R(0, 0, 0, 1) },
      { uri: 'untitled:x', range: R(0, 0, 0, 1) },
      { uri: 'jdt://contents/x.class', range: R(0, 0, 0, 1) },
      { uri: 'file://server/share/a.ts', range: R(0, 0, 0, 1) },
      { uri: inside },
      'garbage',
    ]);
    expect(out).toEqual([{ root, path: 'src/a.ts', range: R(0, 13, 0, 14) }]);
  });

  it('accepts one Location and LocationLinks (target selection range first) and dedupes', () => {
    expect(toLocations(root, { uri: inside, range: R(1, 0, 1, 1) })).toEqual([{ root, path: 'src/a.ts', range: R(1, 0, 1, 1) }]);
    const out = toLocations(root, [
      { targetUri: inside, targetRange: R(0, 0, 5, 0), targetSelectionRange: R(0, 13, 0, 14) },
      { targetUri: inside, targetRange: R(0, 0, 5, 0) },
      { uri: inside, range: R(0, 13, 0, 14) },
    ]);
    expect(out.map((l) => l.range)).toEqual([R(0, 13, 0, 14), R(0, 0, 5, 0)]);
    expect(toLocations(root, null)).toEqual([]);
  });
});

describe('toSymbols', () => {
  it('converts a DocumentSymbol tree with children', () => {
    const out = toSymbols(
      [{ name: 'Cls', kind: 5, detail: 'class', range: R(0, 0, 9, 1), selectionRange: R(0, 6, 0, 9), children: [{ name: 'm', kind: 6, range: R(1, 2, 3, 3), selectionRange: R(1, 2, 1, 3) }, { name: '', kind: 6, range: R(0, 0, 0, 0) }] }],
      'file:///x',
    );
    expect(out).toEqual([{ name: 'Cls', kind: 5, detail: 'class', range: R(0, 0, 9, 1), selectionRange: R(0, 6, 0, 9), children: [{ name: 'm', kind: 6, range: R(1, 2, 3, 3), selectionRange: R(1, 2, 1, 3) }] }]);
    expect(LspSymbol.array().safeParse(out).success).toBe(true);
  });

  it('keeps only the SymbolInformation entries of the document', () => {
    const out = toSymbols(
      [
        { name: 'here', kind: 12, location: { uri: 'file:///doc.ts', range: R(2, 0, 4, 1) } },
        { name: 'there', kind: 12, location: { uri: 'file:///other.ts', range: R(0, 0, 1, 0) } },
      ],
      'file:///doc.ts',
    );
    expect(out).toEqual([{ name: 'here', kind: 12, range: R(2, 0, 4, 1), selectionRange: R(2, 0, 4, 1) }]);
    expect(toSymbols({}, 'file:///doc.ts')).toEqual([]);
  });
});

describe('toDiagnostics', () => {
  it('defaults and clamps severity, stringifies codes, filters tags and drops malformed entries', () => {
    const out = toDiagnostics([
      { range: R(0, 0, 0, 1), message: 'no severity' },
      { range: R(1, 0, 1, 1), message: 'too high', severity: 9, code: 2304, source: 'ts', tags: [1, 2, 2, 7] },
      { range: R(2, 0, 2, 1), message: 'too low', severity: 0, code: 'E1' },
      { range: R(-5, 0, 3, 1.7), message: 'clamped' },
      { range: R(4, 0, 4, 1) },
      { message: 'no range' },
      null,
    ]);
    expect(out).toEqual([
      { range: R(0, 0, 0, 1), message: 'no severity', severity: 1 },
      { range: R(1, 0, 1, 1), message: 'too high', severity: 4, source: 'ts', code: '2304', tags: [1, 2] },
      { range: R(2, 0, 2, 1), message: 'too low', severity: 1, code: 'E1' },
      { range: R(0, 0, 3, 1), message: 'clamped', severity: 1 },
    ]);
    expect(LspDiagnostic.array().safeParse(out).success).toBe(true);
  });

  it(`keeps at most ${LSP_MAX_DIAGNOSTICS} and cuts long messages`, () => {
    const many = Array.from({ length: LSP_MAX_DIAGNOSTICS + 50 }, (_, i) => ({ range: R(i, 0, i, 1), message: 'm' }));
    expect(toDiagnostics(many)).toHaveLength(LSP_MAX_DIAGNOSTICS);
    const [d] = toDiagnostics([{ range: R(0, 0, 0, 1), message: 'x'.repeat(10_000) }]);
    expect(d!.message).toHaveLength(4000);
    expect(LspDiagnostic.safeParse(d).success).toBe(true);
    expect(toDiagnostics('nope')).toEqual([]);
  });
});

describe('toSignatureHelp, toHighlights, toTextEdits', () => {
  it('converts signatures with string and offset parameter labels and clamps the active indexes', () => {
    const out = toSignatureHelp({
      signatures: [
        { label: 'f(a, b)', documentation: { kind: 'markdown', value: '*f*' }, parameters: [{ label: [2, 3], documentation: 'first' }, { label: 'b' }, { label: {} }] },
        { label: 'f(a)', parameters: [{ label: 'a' }], activeParameter: 0 },
      ],
      activeSignature: 7,
      activeParameter: 1,
    })!;
    expect(out).toEqual({
      signatures: [
        { label: 'f(a, b)', documentation: '*f*', parameters: [{ label: [2, 3], documentation: 'first' }, { label: 'b' }] },
        { label: 'f(a)', parameters: [{ label: 'a' }] },
      ],
      activeSignature: 1,
      activeParameter: 0, // the active signature's own activeParameter wins
    });
    expect(LspSignatureHelp.safeParse(out).success).toBe(true);
    expect(toSignatureHelp({ signatures: [{ label: 'g()' }] })).toEqual({ signatures: [{ label: 'g()', parameters: [] }], activeSignature: 0, activeParameter: 0 });
    expect(toSignatureHelp({ signatures: [] })).toBeNull();
    expect(toSignatureHelp({ signatures: [{ nolabel: 1 }] })).toBeNull();
    expect(toSignatureHelp(null)).toBeNull();
  });

  it('highlights keep valid kinds; text edits need a range and text', () => {
    expect(toHighlights([{ range: R(0, 0, 0, 1), kind: 2 }, { range: R(1, 0, 1, 1), kind: 9 }, { kind: 1 }])).toEqual([{ range: R(0, 0, 0, 1), kind: 2 }, { range: R(1, 0, 1, 1) }]);
    expect(toTextEdits([{ range: R(0, 0, 0, 0), newText: 'x' }, { range: R(0, 0, 0, 0) }, { newText: 'y' }])).toEqual([{ range: R(0, 0, 0, 0), newText: 'x' }]);
    expect(toTextEdits(null)).toEqual([]);
  });
});
