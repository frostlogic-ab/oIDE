#!/usr/bin/env node
/**
 * A tiny stdio language server for tests (no dependencies). Speaks Content-Length framed
 * JSON-RPC and answers a fixed set of requests from the text of the open documents:
 * - diagnostics: one error per line containing `ERR` (published on didOpen / didChange / didSave);
 * - hover: the word at the position, in Markdown;
 * - definition: a Location in the same file plus one outside any test root (must be dropped);
 * - completion: a CompletionList with item defaults; resolve adds documentation.
 *
 * Flags:
 *   --log <file>         append one JSON line per message received (method, uri, version)
 *   --crash-once <file>  on the first didOpen, create <file> and exit 3 (later starts behave)
 *   --crash-on-open      exit 3 on every didOpen
 */
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const logFile = value('--log');
const crashOnce = value('--crash-once');

/** uri → { text, version } */
const docs = new Map();

function send(msg) {
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...msg }), 'utf8');
  process.stdout.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]));
}

function log(method, params) {
  if (!logFile) return;
  const td = params && params.textDocument;
  appendFileSync(logFile, `${JSON.stringify({ method, uri: td && td.uri, version: td && td.version })}\n`);
}

function publish(uri) {
  const doc = docs.get(uri);
  if (!doc) return;
  const diagnostics = [];
  doc.text.split('\n').forEach((line, i) => {
    const at = line.indexOf('ERR');
    if (at >= 0) diagnostics.push({ range: { start: { line: i, character: at }, end: { line: i, character: at + 3 } }, severity: 1, source: 'fake-lsp', code: 'E1', message: `ERR on line ${i + 1}` });
  });
  send({ method: 'textDocument/publishDiagnostics', params: { uri, version: doc.version, diagnostics } });
}

function wordAt(uri, pos) {
  const line = (docs.get(uri)?.text ?? '').split('\n')[pos.line] ?? '';
  let s = pos.character;
  let e = pos.character;
  while (s > 0 && /\w/.test(line[s - 1])) s--;
  while (e < line.length && /\w/.test(line[e])) e++;
  return { word: line.slice(s, e), range: { start: { line: pos.line, character: s }, end: { line: pos.line, character: e } } };
}

function crash() {
  process.exit(3);
}

const handlers = {
  initialize: () => ({
    capabilities: {
      textDocumentSync: { openClose: true, change: 1, save: { includeText: false } },
      hoverProvider: true,
      completionProvider: { resolveProvider: true, triggerCharacters: ['.'] },
      signatureHelpProvider: { triggerCharacters: ['('] },
      definitionProvider: true,
      referencesProvider: true,
      documentHighlightProvider: true,
      documentSymbolProvider: true,
      documentFormattingProvider: true,
    },
    serverInfo: { name: 'fake-lsp', version: '1.0.0' },
  }),
  shutdown: () => null,
  'textDocument/hover': (p) => {
    const { word, range } = wordAt(p.textDocument.uri, p.position);
    return word ? { contents: { kind: 'markdown', value: `**${word}**` }, range } : null;
  },
  'textDocument/definition': (p) => [
    { uri: p.textDocument.uri, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } } },
    { uri: pathToFileURL(join(tmpdir(), 'fake-lsp-elsewhere.ts')).href, range: { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } } },
  ],
  'textDocument/references': (p) => [{ uri: p.textDocument.uri, range: { start: p.position, end: p.position } }],
  'textDocument/documentHighlight': (p) => [{ range: wordAt(p.textDocument.uri, p.position).range, kind: 2 }],
  'textDocument/documentSymbol': () => [
    { name: 'main', kind: 12, range: { start: { line: 0, character: 0 }, end: { line: 2, character: 1 } }, selectionRange: { start: { line: 0, character: 9 }, end: { line: 0, character: 13 } } },
  ],
  'textDocument/signatureHelp': () => ({ signatures: [{ label: 'f(a, b)', parameters: [{ label: [2, 3] }, { label: 'b' }] }], activeSignature: 0, activeParameter: 1 }),
  'textDocument/formatting': () => [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: '// formatted\n' }],
  'textDocument/completion': (p) => ({
    isIncomplete: false,
    itemDefaults: { editRange: { start: { line: p.position.line, character: 0 }, end: p.position } },
    items: [
      { label: 'alpha', kind: 3, data: { n: 0 } },
      { label: 'beta', kind: 6, insertText: 'beta(${1:x})', insertTextFormat: 2, data: { n: 1 } },
    ],
  }),
  'completionItem/resolve': (item) => ({ ...item, documentation: { kind: 'markdown', value: `Docs for \`${item.label}\`` } }),
};

const notifications = {
  'textDocument/didOpen': (p) => {
    if (flag('--crash-on-open')) crash();
    if (crashOnce && !existsSync(crashOnce)) {
      writeFileSync(crashOnce, 'crashed');
      crash();
    }
    docs.set(p.textDocument.uri, { text: p.textDocument.text, version: p.textDocument.version });
    publish(p.textDocument.uri);
  },
  'textDocument/didChange': (p) => {
    const doc = docs.get(p.textDocument.uri);
    if (!doc) return;
    doc.text = p.contentChanges[p.contentChanges.length - 1].text;
    doc.version = p.textDocument.version;
    publish(p.textDocument.uri);
  },
  'textDocument/didSave': (p) => publish(p.textDocument.uri),
  'textDocument/didClose': (p) => void docs.delete(p.textDocument.uri),
  exit: () => process.exit(0),
};

function dispatch(msg) {
  if (typeof msg.method !== 'string') return; // an answer to a request of ours (none are sent)
  log(msg.method, msg.params);
  if (msg.id === undefined) return void notifications[msg.method]?.(msg.params);
  const h = handlers[msg.method];
  if (!h) return send({ id: msg.id, error: { code: -32601, message: `Unhandled ${msg.method}` } });
  send({ id: msg.id, result: h(msg.params) ?? null });
}

let buf = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  for (;;) {
    const end = buf.indexOf('\r\n\r\n');
    if (end < 0) return;
    const m = /content-length:\s*(\d+)/i.exec(buf.subarray(0, end).toString('ascii'));
    if (!m) return crash();
    const start = end + 4;
    const len = Number(m[1]);
    if (buf.length < start + len) return;
    const body = buf.subarray(start, start + len).toString('utf8');
    buf = buf.subarray(start + len);
    dispatch(JSON.parse(body));
  }
});
process.stdin.on('end', () => process.exit(0));
