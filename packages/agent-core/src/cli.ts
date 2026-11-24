import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { delimiter, extname, isAbsolute, join } from 'node:path';
import { TESTED_CLI_RANGE, type CliInfo } from '@oide/protocol';
import { allowListEnv, cliCommand } from './args.js';

/**
 * CLI discovery and health. Runs `claude --version` and `claude --help` (no model call, no
 * credentials touched) and derives feature flags used to hide unsupported controls.
 */

export interface SpawnTarget {
  file: string;
  args: string[];
  /** Needed for `.cmd`/`.bat` shims on Windows: args were quoted for cmd.exe by us. */
  windowsVerbatimArguments?: boolean;
}

// cmd.exe quoting, after cross-spawn: escape for CommandLineToArgvW, then caret-escape metacharacters.
const META = /([()\][%!^"`<>&|;, *?])/g;

export function escapeCmdArgument(arg: string, doubleEscape = true): string {
  let a = `${arg}`;
  a = a.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"');
  a = a.replace(/(?=(\\+?)?)\1$/, '$1$1');
  a = `"${a}"`;
  a = a.replace(META, '^$1');
  if (doubleEscape) a = a.replace(META, '^$1');
  return a;
}

export function escapeCmdCommand(cmd: string): string {
  return cmd.replace(META, '^$1');
}

/**
 * How to spawn a command without a shell. On Windows a `.cmd`/`.bat` shim cannot be executed
 * directly, so it goes through `cmd.exe /d /s /c` with every argument escaped (no expansion).
 */
export function resolveSpawn(command: string, args: string[], platform: NodeJS.Platform = process.platform): SpawnTarget {
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(command)) {
    const line = [escapeCmdCommand(command), ...args.map((a) => escapeCmdArgument(a, true))].join(' ');
    return { file: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`], windowsVerbatimArguments: true };
  }
  return { file: command, args };
}

/** Find `claude` on PATH. Windows: honours PATHEXT, prefers claude.exe over claude.cmd. */
export function findOnPath(name: string, env: Record<string, string | undefined> = process.env, platform: NodeJS.Platform = process.platform): string | undefined {
  const pathVar = env.PATH ?? env.Path ?? env.path ?? '';
  const dirs = pathVar.split(platform === 'win32' ? ';' : delimiter).filter(Boolean);
  const exts =
    platform === 'win32'
      ? ['.exe', ...(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').map((e) => e.toLowerCase()).filter((e) => e && e !== '.exe')]
      : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir.replace(/^"|"$/g, ''), name + ext);
      try {
        if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
      } catch {
        /* unreadable entry */
      }
    }
  }
  return undefined;
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((x) => parseInt(x, 10) || 0);
  const pb = b.split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

export function inTestedRange(version: string): boolean {
  return compareVersions(version, TESTED_CLI_RANGE.min) >= 0 && compareVersions(version, TESTED_CLI_RANGE.max) <= 0;
}

/** Flags oIDE cares about; each becomes `features[name]`. */
const FLAG_FEATURES = [
  'effort',
  'forward-subagent-text',
  'include-partial-messages',
  'permission-prompt-tool',
  'permission-prompts',
  'agents',
  'append-system-prompt',
  'mcp-config',
  'session-id',
  'resume',
  'fork-session',
  'replay-user-messages',
  'allowedTools',
  'disallowedTools',
  'input-format',
  'include-hook-events',
];

/** Parse `claude --help` into feature flags (`effort`, `mode:auto`, …). */
export function parseHelpFeatures(help: string): Record<string, boolean> {
  const features: Record<string, boolean> = {};
  for (const f of FLAG_FEATURES) features[f] = new RegExp(`--${f.replace(/[-]/g, '\\-')}\\b`).test(help);
  const modeMatch = /--permission-mode <mode>[\s\S]*?\(choices:([^)]*)\)/.exec(help);
  const modes = modeMatch ? [...modeMatch[1]!.matchAll(/"([A-Za-z]+)"/g)].map((m) => m[1]!) : [];
  for (const m of ['default', 'manual', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions']) features[`mode:${m}`] = modes.includes(m);
  // `default` is accepted as a hidden alias of `manual` (verified on 2.1.325).
  if (features['mode:manual']) features['mode:default'] = true;
  const effortMatch = /--effort <level>[\s\S]*?\(([^)]*)\)/.exec(help);
  if (effortMatch) for (const e of effortMatch[1]!.split(/[,\s]+/).filter(Boolean)) features[`effort:${e}`] = true;
  return features;
}

function run(file: string, args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string; code: number | null }> {
  const target = resolveSpawn(file, args);
  return new Promise((resolve) => {
    execFile(
      target.file,
      target.args,
      {
        timeout: timeoutMs,
        windowsHide: true,
        env: allowListEnv(process.env),
        maxBuffer: 4 * 1024 * 1024,
        ...(target.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
      },
      (err, stdout, stderr) => {
        const code = err && typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : err ? 1 : 0;
        resolve({ stdout: String(stdout), stderr: String(stderr), code });
      },
    );
  });
}

export interface DetectOptions {
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
}

/** Find the CLI, read its version and help, and report what it supports. */
export async function detectCli(pathOverride?: string, opts: DetectOptions = {}): Promise<CliInfo> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  let path = pathOverride;
  if (path && !isAbsolute(path) && !extname(path)) path = findOnPath(path, opts.env) ?? path;
  if (!path) path = findOnPath('claude', opts.env);
  if (!path || (isAbsolute(path) && !existsSync(path))) return { found: false, inTestedRange: false, signedIn: 'unknown', features: {} };

  const cmd = cliCommand(path);
  const ver = await run(cmd.command, [...cmd.args, '--version'], timeoutMs);
  const version = /(\d+\.\d+\.\d+)/.exec(ver.stdout)?.[1];
  if (ver.code !== 0 || !version) return { found: false, path, inTestedRange: false, signedIn: 'unknown', features: {} };
  const help = await run(cmd.command, [...cmd.args, '--help'], timeoutMs);
  return {
    found: true,
    path,
    version,
    inTestedRange: inTestedRange(version),
    // Learned later from the first init event or an auth error; oIDE never reads credential stores.
    signedIn: 'unknown',
    features: help.code === 0 ? parseHelpFeatures(help.stdout) : {},
  };
}
