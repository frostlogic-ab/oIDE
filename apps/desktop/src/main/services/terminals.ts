import { randomUUID } from 'node:crypto';
import type { Emit } from '../ipc/emit.js';
import { IpcError } from '../ipc/router.js';

/**
 * Pseudo-terminals for the Raw terminal tab, the Focus inspector Terminal tab and the sign-in
 * terminal (`claude` run through Anthropic's own flow). Backed by @lydell/node-pty (ADR 0003),
 * loaded lazily so a missing native prebuild never blocks app start.
 *
 * Output is coalesced per terminal for ~8 ms and sent as `terminal.data`; exit as `terminal.exit`.
 */

export interface Disposable {
  dispose(): void;
}

export interface PtyLike {
  readonly pid: number;
  onData(listener: (data: string) => void): Disposable;
  onExit(listener: (e: { exitCode: number; signal?: number }) => void): Disposable;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

export interface PtySpawnOptions {
  name: string;
  cols: number;
  rows: number;
  cwd: string;
  env: Record<string, string>;
}

export type PtySpawn = (file: string, args: string[], options: PtySpawnOptions) => PtyLike;

export interface CreateTerminalOptions {
  cwd: string;
  /** Run this command line in the user's shell instead of an interactive shell. */
  command?: string;
  cols?: number;
  rows?: number;
  /** Extra env vars (merged over the base env). */
  env?: Record<string, string>;
}

export interface TerminalServiceOptions {
  emit: Emit;
  /** Injected in tests; defaults to @lydell/node-pty's spawn. */
  spawn?: PtySpawn;
  platform?: NodeJS.Platform;
  baseEnv?: () => Record<string, string>;
  flushMs?: number;
}

/** Env vars that must never leak from Electron into a user shell. */
const STRIP_ENV = /^(ELECTRON_|NODE_OPTIONS$|VITE_|OIDE_USER_DATA$|CHROME_)/;

export function defaultShell(platform: NodeJS.Platform, command?: string): { file: string; args: string[] } {
  if (platform === 'win32') {
    const file = 'powershell.exe';
    return command ? { file, args: ['-NoLogo', '-NoProfile', '-Command', command] } : { file, args: ['-NoLogo'] };
  }
  const file = process.env.SHELL || (platform === 'darwin' ? '/bin/zsh' : '/bin/bash');
  return command ? { file, args: ['-l', '-c', command] } : { file, args: ['-l'] };
}

function defaultEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !STRIP_ENV.test(k)) env[k] = v;
  }
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  return env;
}

let ptyModule: Promise<PtySpawn> | null = null;
async function loadNodePty(): Promise<PtySpawn> {
  ptyModule ??= import('@lydell/node-pty').then((mod) => {
    const m = (mod as unknown as { default?: typeof mod }).default ?? mod;
    return m.spawn as unknown as PtySpawn;
  });
  return ptyModule;
}

interface Entry {
  pty: PtyLike;
  buffer: string;
  timer: ReturnType<typeof setTimeout> | null;
  disposables: Disposable[];
}

export class TerminalService {
  private readonly terminals = new Map<string, Entry>();
  private readonly platform: NodeJS.Platform;
  private readonly flushMs: number;

  constructor(private readonly opts: TerminalServiceOptions) {
    this.platform = opts.platform ?? process.platform;
    this.flushMs = opts.flushMs ?? 8;
  }

  async create({ cwd, command, cols = 100, rows = 30, env }: CreateTerminalOptions): Promise<{ terminalId: string }> {
    const spawn = this.opts.spawn ?? (await loadNodePty());
    const { file, args } = defaultShell(this.platform, command);
    const terminalId = randomUUID();
    let pty: PtyLike;
    try {
      pty = spawn(file, args, {
        name: 'xterm-256color',
        cols: Math.max(2, cols),
        rows: Math.max(1, rows),
        cwd,
        env: { ...(this.opts.baseEnv ?? defaultEnv)(), ...env },
      });
    } catch (err) {
      throw new IpcError(`Could not start a terminal: ${err instanceof Error ? err.message : String(err)}`, 'unavailable');
    }
    const entry: Entry = { pty, buffer: '', timer: null, disposables: [] };
    entry.disposables.push(
      pty.onData((data) => {
        entry.buffer += data;
        entry.timer ??= setTimeout(() => this.flush(terminalId), this.flushMs);
      }),
      pty.onExit(({ exitCode }) => {
        this.flush(terminalId);
        this.cleanup(terminalId);
        this.opts.emit('terminal.exit', { terminalId, code: exitCode ?? null });
      }),
    );
    this.terminals.set(terminalId, entry);
    return { terminalId };
  }

  write(terminalId: string, data: string): void {
    this.get(terminalId).pty.write(data);
  }

  resize(terminalId: string, cols: number, rows: number): void {
    this.get(terminalId).pty.resize(Math.max(2, cols), Math.max(1, rows));
  }

  kill(terminalId: string): void {
    const entry = this.terminals.get(terminalId);
    if (!entry) return;
    this.flush(terminalId);
    try {
      entry.pty.kill();
    } finally {
      this.cleanup(terminalId);
    }
  }

  has(terminalId: string): boolean {
    return this.terminals.has(terminalId);
  }

  list(): string[] {
    return [...this.terminals.keys()];
  }

  disposeAll(): void {
    for (const id of this.list()) {
      try {
        this.kill(id);
      } catch {
        /* already gone */
      }
    }
  }

  private get(terminalId: string): Entry {
    const entry = this.terminals.get(terminalId);
    if (!entry) throw new IpcError(`No terminal ${terminalId}`, 'not_found');
    return entry;
  }

  private flush(terminalId: string): void {
    const entry = this.terminals.get(terminalId);
    if (!entry) return;
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    if (!entry.buffer) return;
    const data = entry.buffer;
    entry.buffer = '';
    this.opts.emit('terminal.data', { terminalId, data });
  }

  private cleanup(terminalId: string): void {
    const entry = this.terminals.get(terminalId);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    for (const d of entry.disposables) d.dispose();
    this.terminals.delete(terminalId);
  }
}
