/**
 * Language servers for the Files editor (ADR 0019).
 *
 * One server process per (contributed language, checkout root), started on the first open
 * document that matches it and stopped when its last document closes (after `idleMs`), when the
 * checkout goes away, or on quit. Servers come from extensions (`contributes.languages`) that are
 * on for the project, and run only for trusted projects: they execute repository code (tsserver
 * plugins, build scripts, proc macros).
 *
 * Document sync is full text with the editor model's version id: Monaco is the only writer of an
 * open document, so its versions are monotonic. Files an agent changes on disk are not open
 * documents; servers watch those themselves. A crashed server restarts with backoff (1 s → 30 s)
 * and gets its open documents again; five crashes in three minutes and it stays `failed`.
 */
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { statSync } from 'node:fs';
import { basename, delimiter, extname, isAbsolute, join } from 'node:path';
import type { LspCompletionItem, LspCompletionList, LspDiagnosticsEvent, LspState, LspStateEvent, LspStatus } from '@oide/protocol';
import { isInside } from '../../security/paths.js';
import { completionItems, fileUri, toCheckoutPath, toCompletionItem, toDiagnostics } from './convert.js';
import { JsonRpcConnection, JsonRpcError, RPC } from './jsonrpc.js';

/** A language server an extension contributes, as main runs it. */
export interface LanguageServerDef {
  /** `<extension id>:<language id>`, unique. */
  key: string;
  language: string;
  /** File extensions with the dot (`.ts`), or whole file names (`Dockerfile`). Compared case-insensitively. */
  extensions: string[];
  /** Executable name (looked up on PATH, then in the checkout's node_modules/.bin) or an absolute path. */
  command: string;
  args: string[];
  name: string;
  /** The extension's display name. */
  extension: string;
  install?: string | undefined;
  initializationOptions?: Record<string, unknown> | undefined;
  builtin: boolean;
}

export interface CheckoutInfo {
  projectId: string;
  trusted: boolean;
}

export type SpawnFn = (command: string, args: string[], opts: { cwd: string; env: Record<string, string>; windowsVerbatimArguments?: boolean }) => ChildProcess;

export interface LanguageServiceOptions {
  /** The project a checkout root (already through the path guard) belongs to, if any. */
  checkout(root: string): CheckoutInfo | undefined;
  /** Servers of the extensions that are on for a project, in priority order. */
  servers(projectId: string): Promise<LanguageServerDef[]>;
  emitDiagnostics(e: LspDiagnosticsEvent): void;
  emitState(e: LspStateEvent): void;
  log: { warn(...a: unknown[]): void; error(...a: unknown[]): void };
  /** Once per start attempt: how it went (telemetry). */
  onOutcome?(def: LanguageServerDef, outcome: 'running' | 'not_installed' | 'failed'): void;
  spawn?: SpawnFn;
  /** Full path of an executable, or undefined (injected in tests). */
  which?(command: string, root: string): string | undefined;
  /** Env for server processes (an allow-list; default `serverEnv()`). */
  env?(): Record<string, string>;
  platform?: NodeJS.Platform;
  appVersion?: string;
  /** Stop a server this long after its last document closed. Default 3 min. */
  idleMs?: number;
  /** At most this many servers run at once; the least recently used idle one stops first. Default 8. */
  maxSessions?: number;
  /** Feature request timeout. Default 10 s. */
  requestTimeoutMs?: number;
  /** `initialize` timeout. Default 45 s. */
  initTimeoutMs?: number;
}

/** Env vars a server inherits: what toolchains need to find themselves, never secrets or tokens. */
const ENV_KEYS = [
  'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SystemDrive', 'windir', 'ComSpec', 'TEMP', 'TMP', 'TMPDIR',
  'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432',
  'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_RUNTIME_DIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'SHELL', 'USER', 'LOGNAME',
  'GOPATH', 'GOROOT', 'GOMODCACHE', 'GOCACHE', 'CARGO_HOME', 'RUSTUP_HOME', 'RUSTUP_TOOLCHAIN', 'JAVA_HOME',
  'VIRTUAL_ENV', 'CONDA_PREFIX', 'PYENV_ROOT', 'NVM_DIR', 'VOLTA_HOME', 'PNPM_HOME', 'DOTNET_ROOT',
];

export function serverEnv(source: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Record<string, string> {
  const env: Record<string, string> = {};
  // Windows env names are case-insensitive (`PATH` and `Path` are one variable): pass each once.
  const seen = new Set<string>();
  for (const k of ENV_KEYS) {
    const v = source[k];
    const id = platform === 'win32' ? k.toLowerCase() : k;
    if (v === undefined || seen.has(id)) continue;
    seen.add(id);
    env[k] = v;
  }
  return env;
}

/** LSP `languageId` of a document (VS Code's ids), by extension; else the contribution's language. */
const LANGUAGE_IDS: Record<string, string> = {
  '.ts': 'typescript', '.mts': 'typescript', '.cts': 'typescript', '.tsx': 'typescriptreact',
  '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.jsx': 'javascriptreact',
  '.py': 'python', '.pyi': 'python', '.rs': 'rust', '.go': 'go',
  '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.cc': 'cpp', '.cxx': 'cpp', '.hpp': 'cpp', '.hh': 'cpp', '.hxx': 'cpp',
  '.css': 'css', '.scss': 'scss', '.less': 'less', '.html': 'html', '.htm': 'html',
  '.json': 'json', '.jsonc': 'jsonc', '.yaml': 'yaml', '.yml': 'yaml', '.sh': 'shellscript', '.bash': 'shellscript',
  '.md': 'markdown', '.java': 'java', '.cs': 'csharp', '.rb': 'ruby', '.php': 'php', '.lua': 'lua', '.swift': 'swift', '.kt': 'kotlin',
};

export function languageIdFor(path: string, fallback: string): string {
  return LANGUAGE_IDS[extname(path).toLowerCase()] ?? fallback;
}

/** The first def that handles `path` (by extension, or by whole file name). */
export function matchServer(defs: LanguageServerDef[], path: string): LanguageServerDef | undefined {
  const name = basename(path).toLowerCase();
  const ext = extname(name);
  return defs.find((d) => d.extensions.some((e) => {
    const x = e.toLowerCase();
    return x.startsWith('.') ? x === ext || name.endsWith(x) : x === name;
  }));
}

/** Arguments cmd.exe would not reinterpret (Windows `.cmd` shims run through `cmd /c`). */
const CMD_SAFE = /^[\w@+=:,./\\-]*$/;

/** Find an executable on PATH (with PATHEXT on Windows), then in `<root>/node_modules/.bin`. */
export function whichCommand(command: string, root: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | undefined {
  const isFile = (p: string) => {
    try {
      return statSync(p).isFile();
    } catch {
      return false;
    }
  };
  if (isAbsolute(command)) return isFile(command) ? command : undefined;
  if (/[\\/]/.test(command)) return undefined;
  const exts = platform === 'win32' ? ['', ...(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((e) => e.toLowerCase())] : [''];
  const dirs = (env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : delimiter).filter(Boolean);
  dirs.push(join(root, 'node_modules', '.bin'));
  // A name that already has a runnable extension (`clangd.exe`) is looked up as it is.
  const hasExt = platform === 'win32' && exts.some((e) => e && command.toLowerCase().endsWith(e));
  for (const dir of dirs) {
    for (const ext of hasExt ? [''] : exts) {
      // On Windows a bare name without an extension is not runnable (it is the sh shim of npm).
      if (platform === 'win32' && ext === '' && !hasExt) continue;
      const p = join(dir, command + ext);
      if (isFile(p)) return p;
    }
  }
  return undefined;
}

interface Doc {
  path: string;
  uri: string;
  languageId: string;
  version: number;
  text: string;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

const CRASH_WINDOW_MS = 3 * 60_000;
const MAX_CRASHES = 5;

class Session {
  state: LspState = 'starting';
  message: string | undefined;
  child: ChildProcess | undefined;
  conn: JsonRpcConnection | undefined;
  caps: Obj = {};
  readonly docs = new Map<string, Doc>();
  /** Paths that have diagnostics from this server (cleared when it stops). */
  readonly withDiagnostics = new Set<string>();
  crashes: number[] = [];
  lastUsed = Date.now();
  idleTimer: ReturnType<typeof setTimeout> | undefined;
  restartTimer: ReturnType<typeof setTimeout> | undefined;
  stopping = false;
  /** Bumped on each start, so callbacks of an old process are ignored. */
  generation = 0;
  stderrTail = '';
  completion: { resultId: number; path: string; raw: unknown[] } | undefined;

  constructor(
    readonly def: LanguageServerDef,
    readonly root: string,
  ) {}

  get id(): string {
    return `${this.def.key}\0${this.root}`;
  }

  status(): LspStatus {
    const s: LspStatus = { state: this.state, language: this.def.language, server: this.def.name, extension: this.def.extension };
    if (this.def.install && this.state === 'not-installed') s.install = this.def.install;
    if (this.message) s.message = this.message;
    return s;
  }
}

let completionSeq = 1;

export class LanguageServerService {
  private readonly sessions = new Map<string, Session>();
  /** `root\0path` → session id of an open document. */
  private readonly docSession = new Map<string, string>();
  /**
   * Sessions already out of `sessions` whose process is still shutting down (an idle stop, a
   * recheck). `stopUnder` and `dispose` wait for these too, so no server still holds a checkout
   * (its cwd) when a worktree is deleted or the app quits.
   */
  private readonly stopping = new Map<Session, Promise<void>>();
  private disposed = false;
  private readonly platform: NodeJS.Platform;

  constructor(private readonly o: LanguageServiceOptions) {
    this.platform = o.platform ?? process.platform;
  }

  /** Running and starting sessions (Settings › Diagnostics, tests). */
  list(): Array<{ root: string; language: string; state: LspState; documents: number }> {
    return [...this.sessions.values()].map((s) => ({ root: s.root, language: s.def.language, state: s.state, documents: s.docs.size }));
  }

  private docKey(root: string, path: string): string {
    return `${root}\0${path}`;
  }

  private async resolve(root: string, path: string): Promise<{ def?: LanguageServerDef; info?: CheckoutInfo }> {
    const info = this.o.checkout(root);
    if (!info) return {};
    const def = matchServer(await this.o.servers(info.projectId), path);
    return def ? { def, info } : { info };
  }

  private noneStatus(def?: LanguageServerDef, state: LspState = 'none'): LspStatus {
    if (!def) return { state };
    return { state, language: def.language, server: def.name, extension: def.extension };
  }

  /** State for a document without opening it. */
  async status(root: string, path: string): Promise<LspStatus> {
    const sid = this.docSession.get(this.docKey(root, path));
    const open = sid ? this.sessions.get(sid) : undefined;
    if (open) return open.status();
    const { def, info } = await this.resolve(root, path);
    if (!def || !info) return { state: 'none' };
    if (!info.trusted) return this.noneStatus(def, 'untrusted');
    const s = this.sessions.get(`${def.key}\0${root}`);
    return s ? s.status() : this.noneStatus(def);
  }

  async open(root: string, path: string, version: number, text: string): Promise<LspStatus> {
    if (this.disposed) return { state: 'none' };
    const key = this.docKey(root, path);
    const prev = this.docSession.get(key);
    if (prev) this.close(root, path);
    const { def, info } = await this.resolve(root, path);
    if (!def || !info) return { state: 'none' };
    if (!info.trusted) return this.noneStatus(def, 'untrusted');
    const id = `${def.key}\0${root}`;
    let s = this.sessions.get(id);
    if (!s) {
      this.makeRoom();
      s = new Session(def, root);
      this.sessions.set(id, s);
      this.start(s);
    }
    if (s.idleTimer) clearTimeout(s.idleTimer);
    s.idleTimer = undefined;
    s.lastUsed = Date.now();
    const doc: Doc = { path, uri: fileUri(join(root, path)), languageId: languageIdFor(path, def.language), version, text };
    s.docs.set(path, doc);
    this.docSession.set(key, id);
    if (s.state === 'running') this.sendOpen(s, doc);
    return s.status();
  }

  change(root: string, path: string, version: number, text: string): void {
    const s = this.sessionOf(root, path);
    const doc = s?.docs.get(path);
    if (!s || !doc || version <= doc.version) return;
    doc.version = version;
    doc.text = text;
    s.lastUsed = Date.now();
    if (s.state !== 'running' || this.syncKind(s) === 0) return;
    s.conn?.notify('textDocument/didChange', { textDocument: { uri: doc.uri, version }, contentChanges: [{ text }] });
  }

  close(root: string, path: string): void {
    const key = this.docKey(root, path);
    const sid = this.docSession.get(key);
    this.docSession.delete(key);
    const s = sid ? this.sessions.get(sid) : undefined;
    const doc = s?.docs.get(path);
    if (!s || !doc) return;
    s.docs.delete(path);
    if (s.state === 'running' && this.syncKind(s) !== 0) s.conn?.notify('textDocument/didClose', { textDocument: { uri: doc.uri } });
    if (!s.docs.size) this.scheduleIdle(s);
  }

  /** files.write saved a file: tell the server of an open document (some lint on save). */
  saved(root: string, path: string): void {
    const s = this.sessionOf(root, path);
    const doc = s?.docs.get(path);
    if (!s || !doc || s.state !== 'running') return;
    const sync = s.caps.textDocumentSync;
    const save = isObj(sync) ? sync.save : undefined;
    if (!save) return;
    s.conn?.notify('textDocument/didSave', { textDocument: { uri: doc.uri }, ...(isObj(save) && save.includeText ? { text: doc.text } : {}) });
  }

  async restart(root: string, path: string): Promise<LspStatus> {
    const s = this.sessionOf(root, path);
    if (!s) return this.status(root, path);
    await this.stopProcess(s);
    s.crashes = [];
    s.message = undefined;
    this.start(s);
    return s.status();
  }

  /**
   * A feature request for an open document. `capability` is the server capability it needs (no
   * request is sent without it); answers `fallback` when there is no running server or it fails.
   */
  async request<T>(root: string, path: string, capability: string | null, method: string, params: (uri: string) => Obj, convert: (raw: unknown, s: { root: string; uri: string }) => T, fallback: T): Promise<T> {
    const s = this.sessionOf(root, path);
    const doc = s?.docs.get(path);
    if (!s || !doc || s.state !== 'running' || !s.conn) return fallback;
    if (capability && !s.caps[capability]) return fallback;
    s.lastUsed = Date.now();
    try {
      const raw = await s.conn.request(method, { textDocument: { uri: doc.uri }, ...params(doc.uri) }, this.o.requestTimeoutMs ?? 10_000);
      return convert(raw, { root: s.root, uri: doc.uri });
    } catch (err) {
      const code = err instanceof JsonRpcError ? err.code : undefined;
      if (code !== RPC.RequestCancelled && code !== RPC.ContentModified && code !== RPC.MethodNotFound) this.o.log.warn(`[lsp] ${s.def.language} ${method} failed:`, (err as Error).message);
      return fallback;
    }
  }

  async completion(root: string, path: string, position: { line: number; character: number }, triggerCharacter?: string): Promise<LspCompletionList | null> {
    const s = this.sessionOf(root, path);
    return this.request(
      root,
      path,
      'completionProvider',
      'textDocument/completion',
      () => ({ position, context: triggerCharacter ? { triggerKind: 2, triggerCharacter } : { triggerKind: 1 } }),
      (raw) => {
        const { raw: items, incomplete, defaults } = completionItems(raw);
        const resultId = completionSeq++;
        if (s) s.completion = { resultId, path, raw: items };
        return { resultId, incomplete, items: items.flatMap((it, i) => toCompletionItem(it, i, defaults) ?? []) };
      },
      null,
    );
  }

  async resolveCompletion(root: string, path: string, resultId: number, index: number): Promise<LspCompletionItem | null> {
    const s = this.sessionOf(root, path);
    const c = s?.completion;
    if (!s || !c || c.resultId !== resultId || c.path !== path || index >= c.raw.length) return null;
    const provider = s.caps.completionProvider;
    if (!isObj(provider) || !provider.resolveProvider || !s.conn || s.state !== 'running') return null;
    try {
      const raw = await s.conn.request('completionItem/resolve', c.raw[index], this.o.requestTimeoutMs ?? 10_000);
      return toCompletionItem(raw, index) ?? null;
    } catch {
      return null;
    }
  }

  /** Stop every server whose checkout is `dir` or inside it (a worktree or project going away). */
  async stopUnder(dir: string): Promise<void> {
    const hit = [...this.sessions.values()].filter((s) => isInside(dir, s.root));
    const inFlight = [...this.stopping].filter(([s]) => isInside(dir, s.root)).map(([, p]) => p);
    await Promise.all([...hit.map((s) => this.drop(s)), ...inFlight]);
  }

  /**
   * After a trust, project or extension change: stop servers whose checkout is gone or no longer
   * trusted, or whose extension is no longer on for the project (or changed its command).
   */
  async recheck(): Promise<void> {
    await Promise.all(
      [...this.sessions.values()].map(async (s) => {
        const info = this.o.checkout(s.root);
        if (!info) return this.drop(s, 'none');
        if (!info.trusted) return this.drop(s, 'untrusted');
        const defs = await this.o.servers(info.projectId).catch(() => []);
        const same = defs.find((d) => d.key === s.def.key);
        if (!same || same.command !== s.def.command || same.args.join('\0') !== s.def.args.join('\0')) return this.drop(s, 'none');
      }),
    );
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await Promise.all([...[...this.sessions.values()].map((s) => this.drop(s)), ...this.stopping.values()]);
  }

  // ------------------------------------------------------------------ internals

  private sessionOf(root: string, path: string): Session | undefined {
    const sid = this.docSession.get(this.docKey(root, path));
    return sid ? this.sessions.get(sid) : undefined;
  }

  /** 0 none, 1 full, 2 incremental (we always send the full text, which both accept). */
  private syncKind(s: Session): number {
    const sync = s.caps.textDocumentSync;
    if (typeof sync === 'number') return sync;
    if (isObj(sync) && typeof sync.change === 'number') return sync.change;
    return 1;
  }

  private sendOpen(s: Session, doc: Doc): void {
    if (this.syncKind(s) === 0 && !isObj(s.caps.textDocumentSync)) return;
    s.conn?.notify('textDocument/didOpen', { textDocument: { uri: doc.uri, languageId: doc.languageId, version: doc.version, text: doc.text } });
  }

  private setState(s: Session, state: LspState, message?: string): void {
    s.state = state;
    s.message = message;
    this.o.emitState({ root: s.root, ...s.status(), language: s.def.language });
  }

  private makeRoom(): void {
    const max = this.o.maxSessions ?? 8;
    while (this.sessions.size >= max) {
      const list = [...this.sessions.values()].sort((a, b) => Number(a.docs.size > 0) - Number(b.docs.size > 0) || a.lastUsed - b.lastUsed);
      const victim = list[0];
      if (!victim) return;
      void this.drop(victim, victim.docs.size ? 'failed' : undefined, `oIDE stopped it to keep at most ${max} language servers running. Restart it from the editor's status.`);
    }
  }

  private scheduleIdle(s: Session): void {
    if (s.idleTimer) clearTimeout(s.idleTimer);
    s.idleTimer = setTimeout(() => {
      if (!s.docs.size) void this.drop(s);
    }, this.o.idleMs ?? 180_000);
    s.idleTimer.unref?.();
  }

  /** Stop the process and forget the session (clears its diagnostics in the renderer). */
  private async drop(s: Session, state?: LspState, message?: string): Promise<void> {
    if (this.sessions.get(s.id) !== s) return;
    this.sessions.delete(s.id);
    for (const path of s.docs.keys()) this.docSession.delete(this.docKey(s.root, path));
    if (s.idleTimer) clearTimeout(s.idleTimer);
    const stopped = this.stopProcess(s);
    this.stopping.set(s, stopped);
    try {
      await stopped;
    } finally {
      this.stopping.delete(s);
    }
    if (state) this.setState(s, state, message);
  }

  private clearDiagnostics(s: Session): void {
    for (const path of s.withDiagnostics) this.o.emitDiagnostics({ root: s.root, path, diagnostics: [] });
    s.withDiagnostics.clear();
  }

  private async stopProcess(s: Session): Promise<void> {
    s.stopping = true;
    s.generation++;
    if (s.restartTimer) clearTimeout(s.restartTimer);
    s.restartTimer = undefined;
    const { child, conn } = s;
    s.child = undefined;
    s.conn = undefined;
    s.completion = undefined;
    this.clearDiagnostics(s);
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((r) => child.once('exit', () => r()));
      if (conn && !conn.isClosed && s.state === 'running') {
        await conn.request('shutdown', null, 2_000).catch(() => undefined);
        conn.notify('exit', null);
      }
      conn?.close();
      const timer = setTimeout(() => this.kill(child), 1_500);
      await Promise.race([exited, new Promise((r) => setTimeout(r, 3_000))]);
      clearTimeout(timer);
    } else conn?.close();
    s.stopping = false;
  }

  private kill(child: ChildProcess): void {
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (this.platform === 'win32' && child.pid) {
      // cmd.exe shims start the server as a grandchild: kill the whole tree.
      try {
        nodeSpawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => child.kill());
        return;
      } catch {
        /* fall through */
      }
    }
    child.kill('SIGKILL');
  }

  private start(s: Session): void {
    if (this.disposed) return;
    const gen = ++s.generation;
    s.stopping = false;
    s.stderrTail = '';
    this.setState(s, 'starting');
    const exe = (this.o.which ?? ((c, r) => whichCommand(c, r, process.env, this.platform)))(s.def.command, s.root);
    if (!exe) {
      this.setState(s, 'not-installed', `${s.def.command} was not found on PATH.`);
      this.o.onOutcome?.(s.def, 'not_installed');
      return;
    }
    let command = exe;
    let args = s.def.args;
    let verbatim = false;
    if (this.platform === 'win32' && /\.(cmd|bat)$/i.test(exe)) {
      // Inside quotes cmd.exe still expands %VAR%; outside them it also splits on & | < > ^ ( ).
      if (/["%\r\n]/.test(exe) || !args.every((a) => CMD_SAFE.test(a))) {
        this.setState(s, 'failed', 'The server command has characters cmd.exe would interpret.');
        this.o.onOutcome?.(s.def, 'failed');
        return;
      }
      command = process.env.ComSpec ?? 'cmd.exe';
      args = ['/d', '/s', '/c', `"${[`"${exe}"`, ...s.def.args].join(' ')}"`];
      verbatim = true;
    }
    let child: ChildProcess;
    try {
      const spawn = this.o.spawn ?? ((c, a, opts) => nodeSpawn(c, a, { ...opts, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false }));
      child = spawn(command, args, { cwd: s.root, env: (this.o.env ?? serverEnv)(), ...(verbatim ? { windowsVerbatimArguments: true } : {}) });
    } catch (err) {
      this.fail(s, `Could not start ${s.def.command}: ${(err as Error).message}`);
      return;
    }
    s.child = child;
    child.stderr?.on('data', (d: Buffer) => {
      s.stderrTail = (s.stderrTail + d.toString('utf8')).slice(-2000);
    });
    child.stdin?.on('error', () => undefined);
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (gen !== s.generation) return;
      if (err.code === 'ENOENT') {
        s.conn?.close();
        this.setState(s, 'not-installed', `${s.def.command} was not found.`);
        this.o.onOutcome?.(s.def, 'not_installed');
        return;
      }
      this.onExit(s, gen, `${s.def.command}: ${err.message}`);
    });
    child.on('exit', (code, signal) => this.onExit(s, gen, `${s.def.name} stopped (${signal ?? `exit code ${code}`}).`));
    const conn = new JsonRpcConnection(
      { onData: (l) => child.stdout?.on('data', l), write: (d) => child.stdin?.writable && child.stdin.write(d) },
      {
        onRequest: (method, params) => this.onServerRequest(s, method, params),
        onNotification: (method, params) => this.onServerNotification(s, gen, method, params),
        onProtocolError: (err) => this.o.log.warn(`[lsp] ${s.def.language}: ${err.message}`),
      },
    );
    s.conn = conn;
    void this.initialize(s, gen, conn);
  }

  private async initialize(s: Session, gen: number, conn: JsonRpcConnection): Promise<void> {
    const rootUri = fileUri(s.root);
    try {
      const res = await conn.request<{ capabilities?: unknown }>(
        'initialize',
        {
          processId: process.pid,
          clientInfo: { name: 'oIDE', version: this.o.appVersion ?? '0' },
          locale: 'en',
          rootPath: s.root,
          rootUri,
          workspaceFolders: [{ uri: rootUri, name: basename(s.root) }],
          initializationOptions: s.def.initializationOptions ?? null,
          trace: 'off',
          capabilities: CLIENT_CAPABILITIES,
        },
        this.o.initTimeoutMs ?? 45_000,
      );
      if (gen !== s.generation) return;
      s.caps = isObj(res?.capabilities) ? res.capabilities : {};
      conn.notify('initialized', {});
      this.setState(s, 'running');
      this.o.onOutcome?.(s.def, 'running');
      for (const doc of s.docs.values()) this.sendOpen(s, doc);
      if (!s.docs.size) this.scheduleIdle(s);
    } catch (err) {
      if (gen !== s.generation || s.state === 'not-installed') return;
      this.o.log.warn(`[lsp] ${s.def.language} initialize failed:`, (err as Error).message, s.stderrTail.slice(-500));
      await this.stopProcess(s);
      this.fail(s, `${s.def.name} did not start: ${(err as Error).message}`);
    }
  }

  private fail(s: Session, message: string): void {
    const tail = s.stderrTail.trim().split(/\r?\n/).pop();
    this.setState(s, 'failed', tail ? `${message} ${tail.slice(0, 300)}` : message);
    this.o.onOutcome?.(s.def, 'failed');
  }

  private onExit(s: Session, gen: number, message: string): void {
    if (gen !== s.generation || s.stopping || this.sessions.get(s.id) !== s) return;
    s.generation++;
    s.conn?.close();
    s.conn = undefined;
    s.child = undefined;
    this.clearDiagnostics(s);
    if (s.state === 'not-installed') return;
    const now = Date.now();
    s.crashes = [...s.crashes.filter((t) => now - t < CRASH_WINDOW_MS), now];
    this.o.log.warn(`[lsp] ${message}`, s.stderrTail.slice(-500));
    if (s.crashes.length >= MAX_CRASHES) {
      this.fail(s, `${message} It crashed ${MAX_CRASHES} times, so oIDE stopped restarting it.`);
      return;
    }
    if (!s.docs.size) {
      void this.drop(s);
      return;
    }
    this.setState(s, 'starting', message);
    const delay = Math.min(30_000, 1_000 * 2 ** (s.crashes.length - 1));
    s.restartTimer = setTimeout(() => this.start(s), delay);
    s.restartTimer.unref?.();
  }

  private onServerRequest(s: Session, method: string, params: unknown): unknown {
    switch (method) {
      case 'workspace/configuration':
        return isObj(params) && Array.isArray(params.items) ? params.items.map(() => null) : [];
      case 'workspace/workspaceFolders':
        return [{ uri: fileUri(s.root), name: basename(s.root) }];
      case 'client/registerCapability':
      case 'client/unregisterCapability':
      case 'window/workDoneProgress/create':
      case 'window/showMessageRequest':
      case 'workspace/codeLens/refresh':
      case 'workspace/semanticTokens/refresh':
      case 'workspace/inlayHint/refresh':
      case 'workspace/inlineValue/refresh':
      case 'workspace/diagnostic/refresh':
        return null;
      case 'window/showDocument':
        return { success: false };
      // The editor never lets a server write files.
      case 'workspace/applyEdit':
        return { applied: false, failureReason: 'oIDE does not apply workspace edits from language servers' };
      default:
        throw new JsonRpcError(RPC.MethodNotFound, `oIDE does not handle ${method}`);
    }
  }

  private onServerNotification(s: Session, gen: number, method: string, params: unknown): void {
    if (gen !== s.generation) return;
    if (method === 'textDocument/publishDiagnostics' && isObj(params)) {
      const path = toCheckoutPath(s.root, params.uri);
      if (!path) return;
      const diagnostics = toDiagnostics(params.diagnostics);
      if (diagnostics.length) {
        if (s.withDiagnostics.size >= 5000 && !s.withDiagnostics.has(path)) return;
        s.withDiagnostics.add(path);
      } else s.withDiagnostics.delete(path);
      const e: LspDiagnosticsEvent = { root: s.root, path, diagnostics };
      if (typeof params.version === 'number' && Number.isInteger(params.version)) e.version = params.version;
      this.o.emitDiagnostics(e);
      return;
    }
    if (method === 'window/showMessage' && isObj(params) && params.type === 1 && typeof params.message === 'string') {
      this.o.log.warn(`[lsp] ${s.def.language}: ${params.message.slice(0, 500)}`);
    }
  }
}

/** What the Files editor supports, sent in `initialize`. */
const CLIENT_CAPABILITIES = {
  general: { positionEncodings: ['utf-16'] },
  workspace: { configuration: true, workspaceFolders: true, applyEdit: false },
  window: { workDoneProgress: false, showMessage: { messageActionItem: { additionalPropertiesSupport: false } } },
  textDocument: {
    synchronization: { dynamicRegistration: false, didSave: true, willSave: false, willSaveWaitUntil: false },
    hover: { contentFormat: ['markdown', 'plaintext'] },
    completion: {
      contextSupport: true,
      completionItem: {
        snippetSupport: true,
        documentationFormat: ['markdown', 'plaintext'],
        deprecatedSupport: true,
        preselectSupport: true,
        tagSupport: { valueSet: [1] },
        insertReplaceSupport: true,
        labelDetailsSupport: true,
        resolveSupport: { properties: ['documentation', 'detail'] },
      },
      completionList: { itemDefaults: ['commitCharacters', 'editRange', 'insertTextFormat'] },
    },
    signatureHelp: { contextSupport: true, signatureInformation: { documentationFormat: ['markdown', 'plaintext'], parameterInformation: { labelOffsetSupport: true }, activeParameterSupport: true } },
    definition: { linkSupport: true },
    typeDefinition: { linkSupport: true },
    implementation: { linkSupport: true },
    references: {},
    documentHighlight: {},
    documentSymbol: { hierarchicalDocumentSymbolSupport: true },
    formatting: {},
    publishDiagnostics: { relatedInformation: false, versionSupport: true, tagSupport: { valueSet: [1, 2] } },
  },
};

/** Telemetry bucket of a server's language (a fixed list; other extensions' languages are `other`). */
export type LspLanguageBucket = 'typescript' | 'python' | 'rust' | 'go' | 'c_cpp' | 'css' | 'html' | 'json' | 'yaml' | 'shell' | 'other';
const BUCKETS: Record<string, LspLanguageBucket> = {
  typescript: 'typescript', python: 'python', rust: 'rust', go: 'go', cpp: 'c_cpp', c: 'c_cpp',
  css: 'css', html: 'html', json: 'json', yaml: 'yaml', shellscript: 'shell', bash: 'shell',
};
export function lspLanguageBucket(def: Pick<LanguageServerDef, 'language' | 'builtin'>): LspLanguageBucket {
  return def.builtin ? (BUCKETS[def.language] ?? 'other') : 'other';
}
