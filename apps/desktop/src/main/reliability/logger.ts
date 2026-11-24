import { appendFileSync, mkdirSync, readdirSync, renameSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { Logger } from '../ipc/router.js';
import { removeSync } from './fs-safe.js';
import { Redactor } from './redact.js';

/**
 * Rotating file logs in `<userData>/logs/`:
 *
 *   main.log                 main process (services, IPC errors, crashes)
 *   extension-host.log       extension host processes (start, crash, restart)
 *   agents/<agentId>.log     one supervisor log per agent (status changes, exit codes, errors)
 *
 * Every line goes through the Redactor (tokens, keys, env values, home and userData paths).
 * Files rotate at `maxBytes` (`main.log` → `main.1.log` …, `maxFiles` kept) and files older than
 * `retentionDays` are deleted at startup. Writes are buffered (flushed every 250 ms, and at once
 * for errors) and never throw: a failed write (disk full) pauses file logging for a minute and
 * falls back to the console.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface AppLogger extends Logger {
  info(...args: unknown[]): void;
}

export interface LogManagerOptions {
  dir: string;
  level?: LogLevel;
  /** Rotate a file when it grows past this (default 5 MB). */
  maxBytes?: number;
  /** Rotated files kept per log (default 3). */
  maxFiles?: number;
  /** Delete log files not written for this many days (default 14). */
  retentionDays?: number;
  /** Also print to the console (dev). Errors and warnings always reach the console. */
  console?: boolean;
  redactor?: Redactor;
  /** Test seam. */
  now?: () => number;
  flushMs?: number;
}

export function parseLevel(v: string | undefined, fallback: LogLevel): LogLevel {
  const l = v?.toLowerCase();
  return l === 'debug' || l === 'info' || l === 'warn' || l === 'error' ? l : fallback;
}

/** One append-only file with size-based rotation. */
export class RotatingFile {
  private size = -1;

  constructor(
    readonly file: string,
    private readonly maxBytes: number,
    private readonly maxFiles: number,
  ) {}

  /** Throws on I/O errors; the manager decides what to do. */
  write(text: string): void {
    if (this.size < 0) {
      mkdirSync(dirname(this.file), { recursive: true });
      try {
        this.size = statSync(this.file).size;
      } catch {
        this.size = 0;
      }
    }
    const bytes = Buffer.byteLength(text);
    if (this.size > 0 && this.size + bytes > this.maxBytes) this.rotate();
    appendFileSync(this.file, text, 'utf8');
    this.size += bytes;
  }

  /** `x.log` → `x.1.log` → `x.2.log` …; the oldest beyond `maxFiles` is deleted. */
  rotate(): void {
    const ext = '.log';
    const stem = this.file.endsWith(ext) ? this.file.slice(0, -ext.length) : this.file;
    const nth = (n: number) => `${stem}.${n}${ext}`;
    try {
      removeSync(nth(this.maxFiles));
    } catch {}
    for (let n = this.maxFiles - 1; n >= 1; n--) {
      try {
        renameSync(nth(n), nth(n + 1));
      } catch {}
    }
    try {
      renameSync(this.file, nth(1));
    } catch {}
    this.size = 0;
  }
}

export class LogManager {
  readonly dir: string;
  readonly redactor: Redactor;
  private level: LogLevel;
  private readonly files = new Map<string, RotatingFile>();
  private readonly buffers = new Map<string, string[]>();
  private timer: NodeJS.Timeout | null = null;
  /** File logging is off until this time after a failed write (disk full); then it retries. */
  private disabledUntil = 0;
  private closed = false;
  readonly main: AppLogger;

  constructor(private readonly o: LogManagerOptions) {
    this.dir = o.dir;
    this.level = o.level ?? 'info';
    this.redactor = o.redactor ?? new Redactor();
    this.main = this.channel('main');
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  getLevel(): LogLevel {
    return this.level;
  }

  /** True after a write failed (disk full, read-only folder); logs then go to the console only. */
  get fileLoggingDisabled(): boolean {
    return this.disabled;
  }

  private get disabled(): boolean {
    return (this.o.now ?? Date.now)() < this.disabledUntil;
  }

  /** A logger writing to `<dir>/<name>.log`. Names may contain one `/` (e.g. `agents/<id>`). */
  channel(name: string): AppLogger {
    const safe = name
      .split('/')
      .map((p) => p.replace(/[^A-Za-z0-9_.-]/g, '_').replace(/^\.+/, '_'))
      .filter(Boolean)
      .slice(0, 2)
      .join('/');
    const tag = basename(safe);
    const at = (level: LogLevel) => (...args: unknown[]) => this.write(safe, tag, level, args);
    return { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
  }

  /** Per-agent supervisor log. */
  agent(agentId: string): AppLogger {
    return this.channel(`agents/${agentId}`);
  }

  private write(name: string, tag: string, level: LogLevel, args: unknown[]): void {
    if (ORDER[level] < ORDER[this.level]) return;
    let text: string;
    try {
      text = this.redactor.format(args);
    } catch {
      text = '[unformattable log message]';
    }
    const ts = new Date((this.o.now ?? Date.now)()).toISOString();
    const line = `${ts} ${level.toUpperCase().padEnd(5)} [${tag}] ${text}\n`;
    if (this.o.console || level === 'error' || level === 'warn') {
      const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
      fn(`[oide:${tag}] ${text}`);
    }
    if (this.disabled || this.closed) return;
    let buf = this.buffers.get(name);
    if (!buf) this.buffers.set(name, (buf = []));
    buf.push(line);
    if (level === 'error') this.flush();
    else if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), this.o.flushMs ?? 250);
      this.timer.unref?.();
    }
  }

  /** Write buffered lines now (also called on crash paths and at quit). */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.disabled) {
      this.buffers.clear();
      return;
    }
    for (const [name, lines] of this.buffers) {
      if (!lines.length) continue;
      const text = lines.join('');
      lines.length = 0;
      let f = this.files.get(name);
      if (!f) this.files.set(name, (f = new RotatingFile(join(this.dir, `${name}.log`), this.o.maxBytes ?? 5 * 1024 * 1024, this.o.maxFiles ?? 3)));
      try {
        f.write(text);
      } catch (err) {
        this.disabledUntil = (this.o.now ?? Date.now)() + 60_000;
        this.buffers.clear();
        console.error('[oide] could not write logs (retrying in a minute):', (err as Error).message);
        break;
      }
    }
  }

  /** Delete log files older than `retentionDays` (main folder and agents/). Returns removed paths. */
  prune(): string[] {
    const maxAge = (this.o.retentionDays ?? 14) * 24 * 60 * 60 * 1000;
    const now = (this.o.now ?? Date.now)();
    const removed: string[] = [];
    const sweep = (dir: string) => {
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        return;
      }
      for (const n of names) {
        const p = join(dir, n);
        try {
          const st = statSync(p);
          if (st.isDirectory()) {
            if (n === 'agents') sweep(p);
            continue;
          }
          if (n.endsWith('.log') && now - st.mtimeMs > maxAge) {
            removeSync(p);
            removed.push(p);
          }
        } catch {}
      }
    };
    sweep(this.dir);
    return removed;
  }

  close(): void {
    this.flush();
    this.closed = true;
  }
}

/** A Logger that drops everything (tests, plain-Node harnesses). */
export const NULL_LOGGER: AppLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
