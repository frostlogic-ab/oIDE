import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { arch, platform, release } from 'node:os';
import { join } from 'node:path';
import { removeSync } from './fs-safe.js';
import type { Redactor } from './redact.js';

/**
 * Opt-in crash reports (Settings › Privacy › Crash reports; off by default). v1 never uploads
 * anything: reports are written to `<userData>/crash-reports/` only, and the user can copy one
 * into a bug report themselves.
 *
 * - `<id>.json` summaries written by oIDE for main-process exceptions, renderer and child process
 *   crashes, an unresponsive window and extension host crashes. They hold the kind, reason, exit
 *   code, versions, OS and a stack reduced to function names and file base names. Messages are
 *   redacted, then stripped of every path and every quoted string, so no paths, prompts or code.
 * - `native/` holds Electron's own minidumps when crash reports are on (`crashReporter` with
 *   `uploadToServer: false`). Minidumps can hold fragments of process memory, so they never leave
 *   the machine, only the newest few are kept, and turning crash reports off deletes them.
 *
 * The preference is mirrored to `<userData>/privacy.json` so it can be read before the database
 * opens (the native crash reporter must start before the app is ready).
 */

export type CrashKind = 'main-exception' | 'unhandled-rejection' | 'renderer-gone' | 'renderer-unresponsive' | 'child-process-gone' | 'extension-host';

export interface CrashSummary {
  id: string;
  at: string;
  kind: CrashKind;
  app: { version: string; electron?: string; chrome?: string; node: string };
  os: { platform: string; release: string; arch: string };
  uptimeSec: number;
  process?: string;
  reason?: string;
  exitCode?: number | null;
  error?: { name: string; message: string; stack: string[] };
}

export interface CrashDetails {
  process?: string;
  reason?: string;
  exitCode?: number | null;
  error?: unknown;
}

const PREF_FILE = 'privacy.json';

export function readCrashReportsPref(userDataDir: string): boolean {
  try {
    const v = JSON.parse(readFileSync(join(userDataDir, PREF_FILE), 'utf8')) as { crashReports?: unknown };
    return v.crashReports === true;
  } catch {
    return false;
  }
}

export function writeCrashReportsPref(userDataDir: string, enabled: boolean): void {
  try {
    mkdirSync(userDataDir, { recursive: true });
    writeFileSync(join(userDataDir, PREF_FILE), JSON.stringify({ crashReports: enabled }, null, 2), 'utf8');
  } catch {}
}

const ABS_PATH = /(?:file:\/\/\/?)?(?:[A-Za-z]:[\\/]|\\\\[^\\\s]+\\|\/(?:Users|home|private|var|tmp|opt|Applications|Volumes|mnt|root|usr|etc|srv|snap)\/)[^\s'"`()<>|]*/g;

/** Replace absolute paths with `<path>/<base name>`. */
export function stripPaths(s: string): string {
  return s.replace(ABS_PATH, (m) => {
    const clean = m.replace(/[\\/]+$/, '');
    const base = clean.split(/[\\/]/).pop() ?? '';
    return base && !/^[A-Za-z]:$/.test(base) ? `<path>/${base}` : '<path>';
  });
}

/** Remove quoted content (could be a prompt or code) and long lines. */
export function stripContent(s: string): string {
  return s
    .replace(/`[^`]*`/g, '`…`')
    .replace(/"(?:[^"\\]|\\.){12,}"/g, '"…"')
    .replace(/'(?:[^'\\]|\\.){12,}'/g, "'…'")
    .slice(0, 300);
}

/** `at fn (C:\x\y\file.js:10:5)` → `at fn (file.js:10:5)`. Other lines are dropped. */
export function reduceStack(stack: string | undefined, maxFrames = 20): string[] {
  if (!stack) return [];
  const out: string[] = [];
  for (const raw of stack.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith('at ')) continue;
    const m = /^at (?:(.+?) )?\(?(.*?)(?::(\d+):(\d+))?\)?$/.exec(line);
    if (!m) continue;
    const fn = (m[1] ?? '<anonymous>').replace(/[^\w.$<> [\]-]/g, '').slice(0, 80);
    const loc = m[2] ?? '';
    const base = loc.split(/[\\/]/).pop()?.replace(/[?#].*$/, '') ?? '';
    out.push(`at ${fn} (${base}${m[3] ? `:${m[3]}:${m[4]}` : ''})`);
    if (out.length >= maxFrames) break;
  }
  return out;
}

export interface CrashReportsOptions {
  /** `<userData>/crash-reports`. */
  dir: string;
  userDataDir: string;
  enabled: boolean;
  redactor: Redactor;
  appVersion: string;
  /** Summaries kept (default 20). */
  keep?: number;
  /** Native minidumps kept (default 5). */
  keepNative?: number;
  now?: () => number;
}

export class CrashReports {
  private on: boolean;

  constructor(private readonly o: CrashReportsOptions) {
    this.on = o.enabled;
  }

  get enabled(): boolean {
    return this.on;
  }

  get dir(): string {
    return this.o.dir;
  }

  get nativeDir(): string {
    return join(this.o.dir, 'native');
  }

  /** Turn on or off; off deletes every local report (summaries and minidumps). */
  setEnabled(on: boolean): void {
    if (on === this.on) return;
    this.on = on;
    writeCrashReportsPref(this.o.userDataDir, on);
    if (!on) {
      try {
        removeSync(this.o.dir);
      } catch {}
    }
  }

  /** Build a summary (exposed for tests and the copyable report). */
  summarize(kind: CrashKind, d: CrashDetails = {}): CrashSummary {
    const now = (this.o.now ?? Date.now)();
    const s: CrashSummary = {
      id: randomUUID(),
      at: new Date(now).toISOString(),
      kind,
      app: { version: this.o.appVersion, node: process.versions.node, ...(process.versions.electron ? { electron: process.versions.electron } : {}), ...(process.versions.chrome ? { chrome: process.versions.chrome } : {}) },
      os: { platform: platform(), release: release(), arch: arch() },
      uptimeSec: Math.round(process.uptime()),
    };
    if (d.process) s.process = d.process.replace(/[^\w .:-]/g, '').slice(0, 60);
    if (d.reason) s.reason = stripContent(stripPaths(this.o.redactor.string(d.reason)));
    if (d.exitCode !== undefined) s.exitCode = d.exitCode;
    if (d.error !== undefined) {
      const e = d.error instanceof Error ? d.error : new Error(typeof d.error === 'string' ? d.error : 'Non-error value thrown');
      s.error = { name: e.name.replace(/[^\w]/g, '').slice(0, 60) || 'Error', message: stripContent(stripPaths(this.o.redactor.string(e.message))), stack: reduceStack(e.stack) };
    }
    return s;
  }

  /** Write a summary when crash reports are on. Never throws. Returns the file, or null. */
  record(kind: CrashKind, d: CrashDetails = {}): string | null {
    if (!this.on) return null;
    try {
      const s = this.summarize(kind, d);
      mkdirSync(this.o.dir, { recursive: true });
      const file = join(this.o.dir, `${s.at.replace(/[:.]/g, '-')}-${kind}.json`);
      writeFileSync(file, JSON.stringify(s, null, 2), 'utf8');
      this.prune();
      return file;
    } catch {
      return null;
    }
  }

  list(): CrashSummary[] {
    try {
      return readdirSync(this.o.dir)
        .filter((f) => f.endsWith('.json'))
        .sort()
        .reverse()
        .flatMap((f) => {
          try {
            return [JSON.parse(readFileSync(join(this.o.dir, f), 'utf8')) as CrashSummary];
          } catch {
            return [];
          }
        });
    } catch {
      return [];
    }
  }

  /** Keep the newest summaries and minidumps. */
  prune(): void {
    const trim = (dir: string, keep: number, match: (f: string) => boolean) => {
      let files: Array<{ p: string; t: number }>;
      try {
        files = readdirSync(dir, { recursive: true, encoding: 'utf8' })
          .filter(match)
          .map((f) => join(dir, f))
          .flatMap((p) => {
            try {
              const st = statSync(p);
              return st.isFile() ? [{ p, t: st.mtimeMs }] : [];
            } catch {
              return [];
            }
          })
          .sort((a, b) => b.t - a.t);
      } catch {
        return;
      }
      for (const f of files.slice(keep)) {
        try {
          removeSync(f.p);
        } catch {}
      }
    };
    trim(this.o.dir, this.o.keep ?? 20, (f) => !f.includes('native') && f.endsWith('.json'));
    trim(this.nativeDir, this.o.keepNative ?? 5, (f) => f.endsWith('.dmp'));
  }
}
