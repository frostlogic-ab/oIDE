import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import type { LspDiagnosticsEvent, LspStateEvent } from '@oide/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { toHover, toLocations, toSignatureHelp, toSymbols, toTextEdits } from './convert.js';
import { LanguageServerService, languageIdFor, lspLanguageBucket, matchServer, serverEnv, nodeInstallHint, whichCommand, windowsCmd, type LanguageServerDef, type LanguageServiceOptions, type SpawnFn } from './language-servers.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/fake-lsp.mjs', import.meta.url));
const DOC = 'src/a.fk';
const TEXT = 'fine\nhas ERR here\nfine\n';

const def = (args: string[] = [], over: Partial<LanguageServerDef> = {}): LanguageServerDef => ({
  key: 'test:fake',
  language: 'fake',
  extensions: ['.fk', 'Fakefile'],
  command: process.execPath,
  args: [FIXTURE, ...args],
  name: 'Fake LSP',
  extension: 'Tests',
  install: 'npm install -g fake-lsp',
  builtin: false,
  ...over,
});

const dirs: string[] = [];
const services: LanguageServerService[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(services.splice(0).map((s) => s.dispose()));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function temp(prefix: string): string {
  const d = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(d);
  return d;
}

/** Set an env var for a moment; returns the undo. */
function withEnv(key: string, value: string): () => void {
  const had = Object.prototype.hasOwnProperty.call(process.env, key);
  const old = process.env[key];
  process.env[key] = value;
  return () => {
    if (had) process.env[key] = old;
    else delete process.env[key];
  };
}

async function waitFor<T>(fn: () => T | undefined | false, what: string, timeoutMs = 15_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

interface Setup {
  defs?: LanguageServerDef[];
  trusted?: boolean;
  options?: Partial<LanguageServiceOptions>;
}

/** A service over one temp checkout (`root`), spawning real processes unless `spawn` is injected. */
function setup(o: Setup = {}) {
  const root = temp('oide-lsp-root-');
  mkdirSync(join(root, 'src'), { recursive: true });
  const log = join(root, 'server.log');
  const state = { trusted: o.trusted ?? true, defs: o.defs ?? [def(['--log', log])] };
  const diagnostics: LspDiagnosticsEvent[] = [];
  const states: LspStateEvent[] = [];
  const spawned: Array<{ command: string; args: string[]; env: Record<string, string>; cwd: string }> = [];
  const outcomes: string[] = [];
  const warnings: string[] = [];
  const spawn: SpawnFn = (command, args, opts) => {
    spawned.push({ command, args, env: opts.env, cwd: opts.cwd });
    return nodeSpawn(command, args, { ...opts, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false });
  };
  const svc = new LanguageServerService({
    checkout: (r) => (r === root ? { projectId: 'p1', trusted: state.trusted } : undefined),
    servers: async () => state.defs,
    emitDiagnostics: (e) => void diagnostics.push(e),
    emitState: (e) => void states.push(e),
    log: { warn: (...a) => void warnings.push(a.map(String).join(' ')), error: () => {} },
    onOutcome: (_d, outcome) => void outcomes.push(outcome),
    spawn,
    requestTimeoutMs: 5_000,
    initTimeoutMs: 10_000,
    ...o.options,
  });
  services.push(svc);
  const received = () =>
    existsSync(log)
      ? readFileSync(log, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l) as { method: string; uri?: string; version?: number })
      : [];
  const running = () => waitFor(() => states.some((s) => s.state === 'running'), 'running');
  const diagsFor = (path: string, n: number) => waitFor(() => diagnostics.filter((d) => d.path === path).length >= n && diagnostics.filter((d) => d.path === path)[n - 1], `diagnostics #${n} for ${path}`);
  return { root, log, state, svc, diagnostics, states, spawned, outcomes, warnings, received, running, diagsFor };
}

describe('LanguageServerService against the fixture server', () => {
  it('starts on open, sends didOpen, and maps published diagnostics to the checkout-relative path', async () => {
    const t = setup();
    let st;
    const restore = withEnv('ANTHROPIC_API_KEY', 'sk-test-never-passed');
    try {
      st = await t.svc.open(t.root, DOC, 1, TEXT);
    } finally {
      restore();
    }
    expect(st).toEqual({ state: 'starting', language: 'fake', server: 'Fake LSP', extension: 'Tests' });
    await t.running();
    const d = await t.diagsFor(DOC, 1);
    expect(d).toEqual({ root: t.root, path: DOC, version: 1, diagnostics: [{ range: { start: { line: 1, character: 4 }, end: { line: 1, character: 7 } }, severity: 1, source: 'fake-lsp', code: 'E1', message: 'ERR on line 2' }] });
    expect(t.outcomes).toEqual(['running']);
    expect(t.states.map((s) => s.state)).toEqual(['starting', 'running']);
    expect(await t.svc.status(t.root, DOC)).toMatchObject({ state: 'running', language: 'fake' });
    expect(t.svc.list()).toEqual([{ root: t.root, language: 'fake', state: 'running', documents: 1 }]);

    // The process runs in the checkout with an allow-listed env.
    expect(t.spawned).toHaveLength(1);
    expect(t.spawned[0]!.cwd).toBe(t.root);
    expect(t.spawned[0]!.env.ANTHROPIC_API_KEY).toBeUndefined();

    const methods = t.received().map((m) => m.method);
    expect(methods.slice(0, 3)).toEqual(['initialize', 'initialized', 'textDocument/didOpen']);
    const open = t.received().find((m) => m.method === 'textDocument/didOpen')!;
    expect(fileURLToPath(open.uri!).toLowerCase()).toBe(join(t.root, 'src', 'a.fk').toLowerCase());
    expect(open.version).toBe(1);

    // Full-text changes with increasing versions; an older version is ignored.
    t.svc.change(t.root, DOC, 2, 'all fine\n');
    const cleared = await t.diagsFor(DOC, 2);
    expect(cleared).toMatchObject({ version: 2, diagnostics: [] });
    t.svc.change(t.root, DOC, 1, 'ERR stale\n');
    t.svc.saved(t.root, DOC);
    await waitFor(() => t.received().some((m) => m.method === 'textDocument/didSave'), 'didSave');
    expect(t.received().filter((m) => m.method === 'textDocument/didChange').map((m) => m.version)).toEqual([2]);
  });

  it('answers hover, definition (outside locations dropped), symbols, signature help, formatting, completion and resolve', async () => {
    const t = setup();
    await t.svc.open(t.root, DOC, 1, TEXT);
    await t.running();
    const at = { line: 1, character: 5 };
    const hover = await t.svc.request(t.root, DOC, 'hoverProvider', 'textDocument/hover', () => ({ position: at }), toHover, null);
    expect(hover).toEqual({ contents: '**ERR**', range: { start: { line: 1, character: 4 }, end: { line: 1, character: 7 } } });

    const defs = await t.svc.request(t.root, DOC, 'definitionProvider', 'textDocument/definition', () => ({ position: at }), (raw, s) => toLocations(s.root, raw), []);
    expect(defs).toEqual([{ root: t.root, path: DOC, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } } }]);

    const symbols = await t.svc.request(t.root, DOC, 'documentSymbolProvider', 'textDocument/documentSymbol', () => ({}), (raw, s) => toSymbols(raw, s.uri), []);
    expect(symbols.map((s) => s.name)).toEqual(['main']);
    const sig = await t.svc.request(t.root, DOC, 'signatureHelpProvider', 'textDocument/signatureHelp', () => ({ position: at }), toSignatureHelp, null);
    expect(sig).toMatchObject({ activeParameter: 1, signatures: [{ label: 'f(a, b)' }] });
    const edits = await t.svc.request(t.root, DOC, 'documentFormattingProvider', 'textDocument/formatting', () => ({ options: { tabSize: 2, insertSpaces: true } }), (raw) => toTextEdits(raw), []);
    expect(edits).toEqual([{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: '// formatted\n' }]);
    // A capability the server lacks: no request, the fallback.
    expect(await t.svc.request(t.root, DOC, 'typeDefinitionProvider', 'textDocument/typeDefinition', () => ({ position: at }), () => ['x'], [])).toEqual([]);
    expect(t.received().some((m) => m.method === 'textDocument/typeDefinition')).toBe(false);

    const list = (await t.svc.completion(t.root, DOC, { line: 1, character: 2 }, '.'))!;
    expect(list.incomplete).toBe(false);
    expect(list.items).toEqual([
      { index: 0, label: 'alpha', kind: 3, insertText: 'alpha', range: { start: { line: 1, character: 0 }, end: { line: 1, character: 2 } } },
      { index: 1, label: 'beta', kind: 6, insertText: 'beta(${1:x})', snippet: true, range: { start: { line: 1, character: 0 }, end: { line: 1, character: 2 } } },
    ]);
    const resolved = await t.svc.resolveCompletion(t.root, DOC, list.resultId, 1);
    expect(resolved).toMatchObject({ index: 1, label: 'beta', documentation: 'Docs for `beta`' });
    expect(await t.svc.resolveCompletion(t.root, DOC, list.resultId + 99, 1)).toBeNull();
    expect(await t.svc.resolveCompletion(t.root, DOC, list.resultId, 5)).toBeNull();

    // A document that is not open gets the fallback, without a request.
    expect(await t.svc.request(t.root, 'src/other.fk', 'hoverProvider', 'textDocument/hover', () => ({ position: at }), toHover, null)).toBeNull();

    // Restart from the status menu: a new process, documents opened again.
    const st = await t.svc.restart(t.root, DOC);
    expect(st.state).toBe('starting');
    await waitFor(() => t.states.filter((s) => s.state === 'running').length >= 2, 'running after restart');
    expect(t.spawned).toHaveLength(2);
    await waitFor(() => t.received().filter((m) => m.method === 'textDocument/didOpen').length >= 2, 'didOpen again');
    expect(t.received().filter((m) => m.method === 'shutdown')).toHaveLength(1);
  });

  it('untrusted checkout: reports untrusted and spawns nothing', async () => {
    const t = setup({ trusted: false });
    expect(await t.svc.open(t.root, DOC, 1, TEXT)).toEqual({ state: 'untrusted', language: 'fake', server: 'Fake LSP', extension: 'Tests' });
    expect(await t.svc.status(t.root, DOC)).toMatchObject({ state: 'untrusted' });
    expect(t.spawned).toEqual([]);
    expect(t.svc.list()).toEqual([]);
  });

  it('no matching server, or an unknown checkout: none', async () => {
    const t = setup();
    expect(await t.svc.open(t.root, 'notes.txt', 1, 'x')).toEqual({ state: 'none' });
    expect(await t.svc.open(temp('oide-lsp-unknown-'), DOC, 1, 'x')).toEqual({ state: 'none' });
    expect(await t.svc.status(t.root, 'notes.txt')).toEqual({ state: 'none' });
    expect(t.spawned).toEqual([]);
  });

  it('a command that is not found: not-installed with the install hint, nothing spawned', async () => {
    const t = setup({ options: { which: () => undefined }, defs: [def([], { command: 'fake-lsp-not-on-path' })] });
    const st = await t.svc.open(t.root, DOC, 1, TEXT);
    expect(st).toMatchObject({ state: 'not-installed', install: 'npm install -g fake-lsp', message: 'fake-lsp-not-on-path was not found on PATH.' });
    expect(t.states.at(-1)).toMatchObject({ root: t.root, state: 'not-installed', install: 'npm install -g fake-lsp' });
    expect(t.outcomes).toEqual(['not_installed']);
    expect(t.spawned).toEqual([]);
    // The real lookup agrees.
    expect(whichCommand('fake-lsp-not-on-path', t.root)).toBeUndefined();
  });

  it("a built-in server not on PATH runs oIDE's bundled copy with the user's node", async () => {
    const t = setup({
      options: { which: (c) => (c === 'node' ? process.execPath : undefined), bundled: (c) => (c === 'fake-lsp-not-on-path' ? FIXTURE : undefined) },
      defs: [def([], { command: 'fake-lsp-not-on-path', args: ['--stdio'], builtin: true })],
    });
    await t.svc.open(t.root, DOC, 1, TEXT);
    await t.running();
    expect(t.spawned[0]).toMatchObject({ command: process.execPath, args: [FIXTURE, '--stdio'] });
    expect(await t.svc.status(t.root, DOC)).toMatchObject({ state: 'running', bundled: true });
  });

  it('the bundled copy is only for built-in servers, and PATH comes first', async () => {
    const onPath = setup({ options: { which: (c) => (c === 'node' || c === 'my-lsp' ? process.execPath : undefined), bundled: () => '/never.js' }, defs: [def([], { command: 'my-lsp', builtin: true })] });
    await onPath.svc.open(onPath.root, DOC, 1, TEXT);
    await onPath.running();
    expect(onPath.spawned[0]?.args[0]).toBe(FIXTURE);
    expect((await onPath.svc.status(onPath.root, DOC)).bundled).toBeUndefined();
    const ext = setup({ options: { which: (c) => (c === 'node' ? process.execPath : undefined), bundled: () => FIXTURE }, defs: [def([], { command: 'ext-lsp', builtin: false })] });
    expect(await ext.svc.open(ext.root, DOC, 1, TEXT)).toMatchObject({ state: 'not-installed', install: 'npm install -g fake-lsp' });
    expect(ext.spawned).toEqual([]);
  });

  it('a bundled server without Node.js: not installed, and Install installs Node.js', async () => {
    const t = setup({ options: { which: () => undefined, bundled: () => FIXTURE, platform: 'win32' }, defs: [def([], { command: 'fake-lsp-not-on-path', builtin: true })] });
    const st = await t.svc.open(t.root, DOC, 1, TEXT);
    expect(st).toMatchObject({ state: 'not-installed', install: 'winget install --id OpenJS.NodeJS.LTS -e' });
    expect(st.message).toMatch(/needs Node\.js/);
    expect(t.svc.installCommand(t.root, DOC)).toEqual({ command: 'winget install --id OpenJS.NodeJS.LTS -e', server: 'Fake LSP' });
    expect(nodeInstallHint('darwin')).toBe('brew install node');
    expect(nodeInstallHint('linux')).toBeUndefined();
  });

  it('Install: gives the install command only while not installed, then starts the server once it is on PATH', async () => {
    let installed = false;
    const t = setup({ options: { which: (c) => (installed ? c : undefined), installPollMs: 20 } });
    expect(t.svc.installCommand(t.root, DOC)).toBeUndefined(); // not open
    await t.svc.open(t.root, DOC, 1, TEXT);
    expect(t.svc.installCommand(t.root, DOC)).toEqual({ command: 'npm install -g fake-lsp', server: 'Fake LSP' });
    t.svc.watchInstall(t.root, DOC);
    await new Promise((r) => setTimeout(r, 80));
    expect(t.spawned).toEqual([]);
    installed = true;
    await t.running();
    expect(t.spawned).toHaveLength(1);
    expect(t.svc.installCommand(t.root, DOC)).toBeUndefined();
  });

  it('Install: stops looking after installWatchMs', async () => {
    let installed = false;
    const t = setup({ options: { which: (c) => (installed ? c : undefined), installPollMs: 20, installWatchMs: 50 } });
    await t.svc.open(t.root, DOC, 1, TEXT);
    t.svc.watchInstall(t.root, DOC);
    await new Promise((r) => setTimeout(r, 150));
    installed = true;
    await new Promise((r) => setTimeout(r, 100));
    expect(t.spawned).toEqual([]);
    expect((await t.svc.status(t.root, DOC)).state).toBe('not-installed');
  });

  it('closing the last document stops the server after idleMs and clears its diagnostics', async () => {
    const t = setup({ options: { idleMs: 50 } });
    await t.svc.open(t.root, DOC, 1, TEXT);
    await t.running();
    expect((await t.diagsFor(DOC, 1)).diagnostics).toHaveLength(1);
    t.svc.close(t.root, DOC);
    const cleared = await t.diagsFor(DOC, 2);
    expect(cleared).toEqual({ root: t.root, path: DOC, diagnostics: [] });
    await waitFor(() => t.svc.list().length === 0, 'session dropped');
    // The process may still be shutting down: stopUnder waits for it (a worktree delete needs its cwd free).
    await t.svc.stopUnder(t.root);
    const methods = t.received().map((m) => m.method);
    expect(methods).toEqual(expect.arrayContaining(['textDocument/didClose', 'shutdown', 'exit']));
    expect(methods.indexOf('textDocument/didClose')).toBeLessThan(methods.indexOf('shutdown'));
    expect(await t.svc.status(t.root, DOC)).toEqual({ state: 'none', language: 'fake', server: 'Fake LSP', extension: 'Tests' });
  });

  it('a crash restarts the server and opens its documents again', async () => {
    const root0 = temp('oide-lsp-marker-');
    const marker = join(root0, 'crashed');
    const t = setup();
    t.state.defs = [def(['--log', t.log, '--crash-once', marker])];
    await t.svc.open(t.root, DOC, 1, TEXT);
    await waitFor(() => existsSync(marker), 'first crash');
    await waitFor(() => t.states.some((s) => s.state === 'starting' && s.message?.includes('stopped')), 'restarting state');
    await t.running();
    const d = await t.diagsFor(DOC, 1);
    expect(d.diagnostics).toHaveLength(1);
    expect(t.spawned).toHaveLength(2);
    expect(t.received().filter((m) => m.method === 'textDocument/didOpen')).toHaveLength(2);
    expect(t.outcomes).toEqual(['running', 'running']);
  });

  it('stopUnder stops servers of a checkout going away; others are kept', async () => {
    const t = setup();
    await t.svc.open(t.root, DOC, 1, TEXT);
    await t.running();
    await t.diagsFor(DOC, 1);
    await t.svc.stopUnder(temp('oide-lsp-other-'));
    expect(t.svc.list()).toHaveLength(1);
    await t.svc.stopUnder(t.root);
    expect(t.svc.list()).toEqual([]);
    expect(t.diagnostics.at(-1)).toEqual({ root: t.root, path: DOC, diagnostics: [] });
    // The document is forgotten too: no fallback request reaches anything.
    expect(await t.svc.completion(t.root, DOC, { line: 0, character: 0 })).toBeNull();
  });

  it('recheck stops servers of projects no longer trusted, and of extensions turned off', async () => {
    const t = setup();
    await t.svc.open(t.root, DOC, 1, TEXT);
    await t.running();
    await t.svc.recheck(); // nothing changed
    expect(t.svc.list()).toHaveLength(1);
    t.state.trusted = false;
    await t.svc.recheck();
    expect(t.svc.list()).toEqual([]);
    expect(t.states.at(-1)).toMatchObject({ root: t.root, state: 'untrusted', language: 'fake' });

    t.state.trusted = true;
    await t.svc.open(t.root, DOC, 2, TEXT);
    await waitFor(() => t.states.filter((s) => s.state === 'running').length >= 2, 'running again');
    t.state.defs = [];
    await t.svc.recheck();
    expect(t.svc.list()).toEqual([]);
    expect(t.states.at(-1)).toMatchObject({ state: 'none' });
  });

  it('dispose stops every server and refuses new documents', async () => {
    const t = setup();
    const other = temp('oide-lsp-root2-');
    await t.svc.open(t.root, DOC, 1, TEXT);
    await t.running();
    await t.svc.dispose();
    expect(t.svc.list()).toEqual([]);
    expect(await t.svc.open(t.root, DOC, 2, TEXT)).toEqual({ state: 'none' });
    expect(await t.svc.open(other, DOC, 1, TEXT)).toEqual({ state: 'none' });
    expect(t.spawned).toHaveLength(1);
  });
});

/** A child that exits as soon as it starts (no real process). */
function dyingChild(): ChildProcess {
  const c = new EventEmitter() as unknown as ChildProcess & { exitCode: number | null; signalCode: null };
  Object.assign(c, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null, pid: undefined, kill: () => true });
  process.nextTick(() => {
    c.exitCode = 1;
    c.emit('exit', 1, null);
  });
  return c;
}

describe('LanguageServerService crash limit', () => {
  it('gives up after five crashes in three minutes, with backoff between restarts', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    let spawns = 0;
    const t = setup({ options: { spawn: () => (spawns++, dyingChild()) } });
    await t.svc.open(t.root, DOC, 1, TEXT);
    await vi.advanceTimersByTimeAsync(0);
    expect(spawns).toBe(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(spawns).toBe(1); // first restart after 1 s
    await vi.advanceTimersByTimeAsync(1);
    expect(spawns).toBe(2);
    await vi.advanceTimersByTimeAsync(2_000 + 4_000 + 8_000);
    expect(spawns).toBe(5);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(spawns).toBe(5);
    const last = t.states.at(-1)!;
    expect(last.state).toBe('failed');
    expect(last.message).toMatch(/crashed 5 times/);
    expect(t.outcomes).toEqual(['failed']);
    expect(await t.svc.status(t.root, DOC)).toMatchObject({ state: 'failed' });
  });
});

describe('matchServer / languageIdFor / lspLanguageBucket', () => {
  const ts = def([], { key: 'a:ts', language: 'typescript', extensions: ['.ts', '.TSX'] });
  const docker = def([], { key: 'b:docker', language: 'dockerfile', extensions: ['Dockerfile', '.dockerfile'] });
  const dts = def([], { key: 'c:dts', language: 'dts', extensions: ['.d.ts'] });

  it('matches by extension (case-insensitive), by whole file name, and in priority order', () => {
    expect(matchServer([ts, docker], 'src/App.tsx')?.key).toBe('a:ts');
    expect(matchServer([ts, docker], 'src/a.TS')?.key).toBe('a:ts');
    expect(matchServer([ts, docker], 'build/Dockerfile')?.key).toBe('b:docker');
    expect(matchServer([ts, docker], 'build/dockerfile')?.key).toBe('b:docker');
    expect(matchServer([ts, docker], 'x.Dockerfile')?.key).toBe('b:docker');
    expect(matchServer([ts, docker], 'notDockerfile')).toBeUndefined();
    expect(matchServer([dts, ts], 'types/x.d.ts')?.key).toBe('c:dts');
    expect(matchServer([ts, dts], 'types/x.d.ts')?.key).toBe('a:ts');
    expect(matchServer([ts], 'README.md')).toBeUndefined();
    expect(matchServer([], 'a.ts')).toBeUndefined();
  });

  it("uses VS Code's language ids by extension, else the contribution's language", () => {
    expect(languageIdFor('a.tsx', 'typescript')).toBe('typescriptreact');
    expect(languageIdFor('a.MJS', 'typescript')).toBe('javascript');
    expect(languageIdFor('x.h', 'cpp')).toBe('c');
    expect(languageIdFor('run.sh', 'x')).toBe('shellscript');
    expect(languageIdFor('Dockerfile', 'dockerfile')).toBe('dockerfile');
  });

  it('telemetry buckets only built-in languages', () => {
    expect(lspLanguageBucket({ language: 'typescript', builtin: true })).toBe('typescript');
    expect(lspLanguageBucket({ language: 'cpp', builtin: true })).toBe('c_cpp');
    expect(lspLanguageBucket({ language: 'shellscript', builtin: true })).toBe('shell');
    expect(lspLanguageBucket({ language: 'zig', builtin: true })).toBe('other');
    expect(lspLanguageBucket({ language: 'typescript', builtin: false })).toBe('other');
  });
});

describe('whichCommand', () => {
  it('finds a bare name on PATH (POSIX)', () => {
    const bin = temp('oide-lsp-bin-');
    writeFileSync(join(bin, 'fake-ls'), '#!/bin/sh\n');
    mkdirSync(join(bin, 'a-dir'));
    const root = temp('oide-lsp-which-');
    expect(whichCommand('fake-ls', root, { PATH: bin }, 'linux')).toBe(join(bin, 'fake-ls'));
    expect(whichCommand('a-dir', root, { PATH: bin }, 'linux')).toBeUndefined(); // folders are not commands
    expect(whichCommand('missing', root, { PATH: bin }, 'linux')).toBeUndefined();
  });

  it('on win32 tries PATHEXT (lowercased) and skips the extensionless npm sh shim', () => {
    const bin = temp('oide-lsp-winbin-');
    writeFileSync(join(bin, 'fake-ls'), '#!/bin/sh\n');
    writeFileSync(join(bin, 'fake-ls.cmd'), '@echo off\n');
    writeFileSync(join(bin, 'only-sh'), '#!/bin/sh\n');
    const root = temp('oide-lsp-which-');
    expect(whichCommand('fake-ls', root, { PATH: bin, PATHEXT: '.COM;.EXE;.CMD' }, 'win32')).toBe(join(bin, 'fake-ls.cmd'));
    expect(whichCommand('fake-ls', root, { Path: bin }, 'win32')).toBe(join(bin, 'fake-ls.cmd')); // default PATHEXT, `Path`
    expect(whichCommand('fake-ls', root, { PATH: bin, PATHEXT: '.EXE' }, 'win32')).toBeUndefined();
    expect(whichCommand('only-sh', root, { PATH: bin }, 'win32')).toBeUndefined();
  });

  it("falls back to the checkout's node_modules/.bin, and checks absolute paths and refuses relative ones", () => {
    const root = temp('oide-lsp-which-');
    mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true });
    writeFileSync(join(root, 'node_modules', '.bin', 'local-ls'), '');
    writeFileSync(join(root, 'node_modules', '.bin', 'local-ls.cmd'), '');
    const expected = process.platform === 'win32' ? 'local-ls.cmd' : 'local-ls';
    expect(whichCommand('local-ls', root, { PATH: '' }, process.platform)).toBe(join(root, 'node_modules', '.bin', expected));
    expect(whichCommand(process.execPath, root, {}, process.platform)).toBe(process.execPath);
    expect(whichCommand(join(root, 'nope'), root, {}, process.platform)).toBeUndefined();
    expect(whichCommand('./node_modules/.bin/local-ls', root, { PATH: '' }, process.platform)).toBeUndefined();
    expect(whichCommand('node_modules/.bin/local-ls', root, { PATH: '' }, process.platform)).toBeUndefined();
  });
});

describe('windowsCmd', () => {
  it('is System32 cmd.exe under SystemRoot, whatever ComSpec says (SEC-01)', () => {
    expect(windowsCmd({ SystemRoot: 'D:/Win', ComSpec: 'C:/evil/cmd.exe' })).toBe(['D:', 'Win', 'System32', 'cmd.exe'].join(String.fromCharCode(92)));
    expect(windowsCmd({ ComSpec: 'C:/evil/cmd.exe' })).toMatch(/^C:.Windows.System32.cmd\.exe$/);
  });
});

describe('serverEnv', () => {
  it('passes only allow-listed variables: never API keys, tokens or loader hooks', () => {
    const env = serverEnv({
      PATH: '/usr/bin',
      HOME: '/home/u',
      LANG: 'en_US.UTF-8',
      CARGO_HOME: '/c',
      ANTHROPIC_API_KEY: 'sk-ant',
      ANTHROPIC_AUTH_TOKEN: 't',
      CLAUDE_CODE_OAUTH_TOKEN: 'o',
      GITHUB_TOKEN: 'g',
      GH_TOKEN: 'g',
      NPM_TOKEN: 'n',
      AWS_SECRET_ACCESS_KEY: 'a',
      NODE_OPTIONS: '--require /tmp/evil.js',
      LD_PRELOAD: '/tmp/evil.so',
      ELECTRON_RUN_AS_NODE: '1',
    });
    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/home/u', LANG: 'en_US.UTF-8', CARGO_HOME: '/c' });
  });

  it('reads process.env by default', () => {
    const restore = withEnv('ANTHROPIC_API_KEY', 'sk-test');
    try {
      const env = serverEnv();
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(env.PATH ?? env.Path).toBeTruthy();
    } finally {
      restore();
    }
  });
});
