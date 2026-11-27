#!/usr/bin/env node
// Starts every bundled language server from a staged folder (stage.mjs) with this Node.js and checks
// that it works: each answers `initialize`; TypeScript reports a type error (so tsserver ran) and
// HTML completes inside <script> (its JavaScript mode, on its own TypeScript, answered). Catches a pruned file a server needs.
// Usage: node packages/language-servers/smoke.mjs <staged folder>
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = resolve(process.argv[2] ?? 'apps/desktop/release/language-servers');

// Real files in a scratch folder: tsserver only answers about documents with a real path.
const scratch = mkdtempSync(join(tmpdir(), 'oide-lsp-smoke-'));
process.on('exit', () => rmSync(scratch, { recursive: true, force: true }));
function doc(name, languageId, lines) {
  const text = lines.join('\n');
  writeFileSync(join(scratch, name), text);
  return { uri: pathToFileURL(join(scratch, name)).href, languageId, version: 1, text };
}
const TS_DOC = doc('a.ts', 'typescript', ["const n: number = 'x';", 'export {};', '']);
const HTML_DOC = doc('a.html', 'html', ['<script>', 'const s = "x";', 's.', '</script>', '']);

const SERVERS = [
  ['typescript-language-server', 'lib/cli.mjs', { doc: TS_DOC, until: (m) => m.method === 'textDocument/publishDiagnostics' && m.params?.diagnostics?.length > 0 }],
  ['vscode-langservers-extracted', 'bin/vscode-css-language-server'],
  [
    'vscode-langservers-extracted',
    'bin/vscode-html-language-server',
    {
      doc: HTML_DOC,
      request: { id: 3, method: 'textDocument/completion', params: { textDocument: { uri: HTML_DOC.uri }, position: { line: 2, character: 2 } } },
      until: (m) => m.id === 3 && (m.result?.items ?? []).length > 0,
    },
  ],
  ['vscode-langservers-extracted', 'bin/vscode-json-language-server'],
  ['yaml-language-server', 'bin/yaml-language-server'],
];

// Like the Files editor's (apps/desktop/src/main/services/lsp/language-servers.ts): servers only push diagnostics to clients that say they take them.
const CLIENT_CAPABILITIES = {
  workspace: { configuration: true, workspaceFolders: true },
  textDocument: { synchronization: { didSave: true }, completion: { completionItem: { snippetSupport: true } }, publishDiagnostics: { versionSupport: true } },
};

function frame(msg) {
  const body = JSON.stringify({ jsonrpc: '2.0', ...msg });
  return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
}

/** Complete JSON-RPC messages at the start of `buf`; returns [messages, rest]. */
function parse(buf) {
  const msgs = [];
  for (;;) {
    const h = buf.indexOf('\r\n\r\n');
    if (h < 0) break;
    const len = Number(/Content-Length: (\d+)/i.exec(buf.subarray(0, h).toString())?.[1]);
    if (buf.length < h + 4 + len) break;
    msgs.push(JSON.parse(buf.subarray(h + 4, h + 4 + len).toString()));
    buf = buf.subarray(h + 4 + len);
  }
  return [msgs, buf];
}

function check(pkg, script, deep) {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [join(dir, 'node_modules', pkg, ...script.split('/')), '--stdio'], { cwd: scratch, stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = Buffer.alloc(0);
    let err = '';
    let initialized = false;
    let finished = false;
    const timer = setTimeout(() => {
      child.kill();
      fail(new Error(`${script}: ${initialized ? 'no answer about the document' : 'no initialize result'} in 60 s\n${err}`));
    }, 60_000);
    child.stderr.on('data', (d) => (err += d));
    child.stdout.on('data', (d) => {
      let msgs;
      [msgs, buf] = parse(Buffer.concat([buf, d]));
      let ok = false;
      for (const m of msgs) {
        if (process.env.SMOKE_DEBUG) console.error(JSON.stringify(m).slice(0, 300));
        if (m.id === 1 && m.result?.capabilities) {
          initialized = true;
          if (!deep) ok = true;
          else {
            child.stdin.write(frame({ method: 'initialized', params: {} }));
            child.stdin.write(frame({ method: 'textDocument/didOpen', params: { textDocument: deep.doc } }));
            if (deep.request) child.stdin.write(frame(deep.request));
          }
        } else if (m.id !== undefined && m.method) {
          // Requests to the client (workspace/configuration, progress…): answer with nothing.
          child.stdin.write(frame({ id: m.id, result: m.method === 'workspace/configuration' ? (m.params?.items ?? []).map(() => null) : null }));
        }
        if (deep?.until(m)) ok = true;
      }
      if (!ok || finished) return;
      finished = true;
      clearTimeout(timer);
      child.stdin.write(frame({ id: 2, method: 'shutdown' }));
      child.stdin.write(frame({ method: 'exit' }));
      setTimeout(() => child.kill(), 2000).unref();
      done(script);
    });
    child.on('exit', (code) => {
      if (finished) return;
      clearTimeout(timer);
      fail(new Error(`${script} exited (${code}) before it answered\n${err}`));
    });
    const rootUri = pathToFileURL(scratch).href;
    child.stdin.write(frame({ id: 1, method: 'initialize', params: { processId: process.pid, rootUri, workspaceFolders: [{ uri: rootUri, name: 'smoke' }], capabilities: CLIENT_CAPABILITIES } }));
  });
}

for (const [pkg, script, deep] of SERVERS) console.log(`ok ${await check(pkg, script, deep)}${deep ? ' (answered about a document)' : ''}`);
