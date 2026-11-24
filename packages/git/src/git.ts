import { execFile, spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveTool } from './bin.js';

/**
 * Typed runner for the system `git` binary. Never goes through a shell: arguments are passed as an
 * array to `execFile`, so paths, branch names and messages cannot inject commands.
 *
 * - Inherits the user's environment unchanged (their credential helpers, SSH agent, config) and only
 *   adds variables that stop git from ever prompting (`GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never`).
 * - Adds `-c core.quotepath=false` everywhere and `-c core.longpaths=true` on Windows.
 * - Rejects with a `GitError` carrying stderr and the exit code.
 * - Runs the absolute `git` from PATH, never a `git.exe` shipped in the repository (SEC-01).
 * - Repository config is not trusted by default (SEC-03): in a checkout that is not trusted, every
 *   exec-capable key the repo's own config sets (`.git/config`, worktree config and what they
 *   include) is overridden with a harmless value, and hooks, fsmonitor and signing are off. The
 *   user's global and system config are left alone. See `repoConfigOverrides`.
 * - diff/log/show always get `--no-ext-diff --no-textconv`.
 */

export interface GitRunOptions {
  cwd?: string;
  /** Milliseconds; 0 disables. Default from the runner (60 s). */
  timeoutMs?: number;
  /** Extra env for this call (merged over the runner env). */
  env?: Record<string, string | undefined>;
  /** Exit codes that count as success (default `[0]`). The result carries the code. */
  okExitCodes?: number[];
  /** Text written to stdin. */
  input?: string;
}

export interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Whether the repository's own config (hooks, filters, fsmonitor, …) may run code. */
export type RepoTrust = 'trusted' | 'untrusted';

export interface GitOptions {
  cwd: string;
  /** Path to git; default the absolute `git` found on PATH (never the cwd). */
  gitBinary?: string;
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
  /** Default: what the trust resolver says for the cwd (`untrusted` unless main configured one). */
  trust?: RepoTrust;
}

let trustResolver: (cwd: string) => boolean = () => false;

/**
 * Main tells the git layer which checkouts are trusted (trusted projects and their worktrees).
 * Everything else runs with the repo's exec-capable config neutralised.
 */
export function setRepoTrustResolver(fn: (cwd: string) => boolean): void {
  trustResolver = fn;
}

export class GitError extends Error {
  constructor(
    message: string,
    readonly args: readonly string[],
    readonly exitCode: number | null,
    readonly stderr: string,
    readonly stdout: string,
    readonly timedOut = false,
  ) {
    super(message);
    this.name = 'GitError';
  }
}

const MAX_BUFFER = 256 * 1024 * 1024;

/** Env additions that make sure git never waits for a human. Credentials stay the user's own. */
export const NO_PROMPT_ENV: Readonly<Record<string, string>> = {
  GIT_TERMINAL_PROMPT: '0',
  GCM_INTERACTIVE: 'never',
  GIT_ASKPASS: '',
  SSH_ASKPASS: '',
  // Keep stderr in English so messages like "CONFLICT" can be matched.
  LC_MESSAGES: 'C',
  LANGUAGE: 'C',
};

export function baseConfigArgs(platform: NodeJS.Platform = process.platform): string[] {
  // protocol.ext.allow=never: an `ext::` remote (or an insteadOf rewrite to one) never runs a command.
  const args = ['-c', 'core.quotepath=false', '-c', 'color.ui=false', '-c', 'protocol.ext.allow=never', '-c', 'log.showSignature=false'];
  if (platform === 'win32') args.push('-c', 'core.longpaths=true');
  return args;
}

/** diff/log/show can run `diff.external` and textconv programs; oIDE parses raw diffs anyway. */
const DIFF_COMMANDS = new Set(['diff', 'log', 'show']);

/** Inserts `--no-ext-diff --no-textconv` right after the subcommand of diff/log/show. */
export function withSafeDiffFlags(args: readonly string[]): string[] {
  let i = 0;
  while (i < args.length && args[i]!.startsWith('-')) i += args[i] === '-c' || args[i] === '-C' ? 2 : 1;
  const sub = args[i];
  if (!sub || !DIFF_COMMANDS.has(sub)) return [...args];
  return [...args.slice(0, i + 1), '--no-ext-diff', '--no-textconv', ...args.slice(i + 1)];
}

let emptyHooksDir: string | undefined;
/** An empty folder of our own for `core.hooksPath`, so no hook (also not `.git/hooks/*`) runs. */
export function noHooksDir(): string {
  emptyHooksDir ??= mkdtempSync(join(tmpdir(), 'oide-nohooks-'));
  return emptyHooksDir;
}

/** Exec-capable config keys and the value that makes each harmless. */
const NEUTRAL: ReadonlyArray<readonly [RegExp, string]> = [
  [/^core\.fsmonitor$/i, 'false'],
  [/^core\.hookspath$/i, ''],
  [/^core\.sshcommand$/i, 'ssh'],
  [/^core\.gitproxy$/i, ''],
  [/^core\.askpass$/i, ''],
  [/^core\.pager$/i, 'cat'],
  [/^pager\..+$/i, 'false'],
  [/^core\.editor$/i, ':'],
  [/^sequence\.editor$/i, ':'],
  [/^core\.alternaterefscommand$/i, ''],
  [/^diff\.external$/i, ''],
  [/^diff\..+\.(command|textconv)$/i, ''],
  [/^filter\..+\.(clean|smudge|process)$/i, ''],
  [/^filter\..+\.required$/i, 'false'],
  [/^merge\..+\.driver$/i, ''],
  [/^gpg\.program$/i, ''],
  [/^gpg\..+\.program$/i, ''],
  [/^credential\.(.+\.)?helper$/i, ''],
  [/^remote\..+\.uploadpack$/i, 'git-upload-pack'],
  [/^remote\..+\.receivepack$/i, 'git-receive-pack'],
  [/^trailer\..+\.(command|cmd)$/i, ''],
  [/^uploadpack\.packobjectshook$/i, ''],
  [/^submodule\..+\.update$/i, 'none'],
];

/** `git config --list --show-scope -z` output → rows. Each record is `scope\0key\nvalue\0`. */
export function parseConfigList(out: string): Array<{ scope: string; key: string; value: string }> {
  const parts = out.split('\0');
  const rows: Array<{ scope: string; key: string; value: string }> = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const kv = parts[i + 1]!;
    const nl = kv.indexOf('\n');
    rows.push({ scope: parts[i]!, key: nl < 0 ? kv : kv.slice(0, nl), value: nl < 0 ? '' : kv.slice(nl + 1) });
  }
  return rows;
}

/**
 * Overrides for a checkout that is not trusted: every exec-capable key the repository's own
 * config sets gets a harmless value; hooks, fsmonitor and signing are always off. Passed through
 * `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n`, so a subsection name that contains
 * `=` cannot dodge an override the way it could with `-c key=value`.
 */
export function repoConfigOverrides(rows: ReadonlyArray<{ scope: string; key: string }>): Array<[string, string]> {
  const out = new Map<string, string>();
  for (const { scope, key } of rows) {
    if (scope !== 'local' && scope !== 'worktree') continue;
    const hit = NEUTRAL.find(([re]) => re.test(key));
    if (hit) out.set(key, hit[1]);
  }
  // Last wins: these come after any same-named repo key.
  out.set('core.hooksPath', noHooksDir());
  out.set('core.fsmonitor', 'false');
  out.set('commit.gpgSign', 'false');
  out.set('tag.gpgSign', 'false');
  out.set('push.gpgSign', 'false');
  return [...out];
}

function configEnv(pairs: Array<[string, string]>, base: NodeJS.ProcessEnv): Record<string, string> {
  const start = Math.max(0, parseInt(base.GIT_CONFIG_COUNT ?? '0', 10) || 0);
  const env: Record<string, string> = { GIT_CONFIG_COUNT: String(start + pairs.length) };
  pairs.forEach(([k, v], i) => {
    env[`GIT_CONFIG_KEY_${start + i}`] = k;
    env[`GIT_CONFIG_VALUE_${start + i}`] = v;
  });
  return env;
}

const OVERRIDE_TTL_MS = 2000;
const overrideCache = new Map<string, { at: number; pairs: Promise<Array<[string, string]>> }>();

function buildEnv(...layers: Array<Record<string, string | undefined> | undefined>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const layer of layers) {
    if (!layer) continue;
    for (const [k, v] of Object.entries(layer)) {
      if (v === undefined) delete env[k];
      else env[k] = v;
    }
  }
  return env;
}

export class Git {
  readonly cwd: string;
  readonly gitBinary: string;
  readonly timeoutMs: number;
  private readonly env: Record<string, string | undefined> | undefined;
  private readonly trust: RepoTrust | undefined;

  constructor(opts: GitOptions) {
    this.cwd = opts.cwd;
    this.gitBinary = opts.gitBinary ?? resolveTool('git');
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.env = opts.env;
    this.trust = opts.trust;
  }

  /** Same settings, different working directory. */
  at(cwd: string): Git {
    return new Git({ cwd, gitBinary: this.gitBinary, timeoutMs: this.timeoutMs, env: this.env, ...(this.trust ? { trust: this.trust } : {}) });
  }

  /** True when the repo's own config may run code in `cwd` (see `setRepoTrustResolver`). */
  isTrusted(cwd = this.cwd): boolean {
    return (this.trust ?? (trustResolver(cwd) ? 'trusted' : 'untrusted')) === 'trusted';
  }

  /** The neutralising overrides for an untrusted checkout (cached for 2 s per folder). */
  private overridesFor(cwd: string): Promise<Array<[string, string]>> {
    const hit = overrideCache.get(cwd);
    if (hit && Date.now() - hit.at < OVERRIDE_TTL_MS) return hit.pairs;
    // Listing config runs nothing; it still gets the always-on overrides.
    const pairs = this.exec(['config', '--list', '--show-scope', '-z'], { cwd, okExitCodes: [0, 1, 128] }, repoConfigOverrides([]))
      .then((r) => repoConfigOverrides(r.exitCode === 0 ? parseConfigList(r.stdout) : []))
      .catch(() => repoConfigOverrides([]));
    overrideCache.set(cwd, { at: Date.now(), pairs });
    if (overrideCache.size > 256) overrideCache.delete(overrideCache.keys().next().value!);
    return pairs;
  }

  async run(args: readonly string[], opts: GitRunOptions = {}): Promise<GitResult> {
    const cwd = opts.cwd ?? this.cwd;
    const overrides = this.isTrusted(cwd) ? [] : await this.overridesFor(cwd);
    return this.exec(args, opts, overrides);
  }

  private exec(args: readonly string[], opts: GitRunOptions, overrides: Array<[string, string]>): Promise<GitResult> {
    const fullArgs = [...baseConfigArgs(), ...withSafeDiffFlags(args)];
    const ok = opts.okExitCodes ?? [0];
    const cwd = opts.cwd ?? this.cwd;
    const timeout = opts.timeoutMs ?? this.timeoutMs;
    const env = buildEnv(NO_PROMPT_ENV, this.env, opts.env);
    if (overrides.length) Object.assign(env, configEnv(overrides, env));
    return new Promise<GitResult>((resolve, reject) => {
      const child = execFile(
        this.gitBinary,
        fullArgs,
        {
          cwd,
          env,
          maxBuffer: MAX_BUFFER,
          timeout: timeout > 0 ? timeout : undefined,
          windowsHide: true,
          encoding: 'utf8',
        },
        (err, stdout, stderr) => {
          const out = String(stdout ?? '');
          const errText = String(stderr ?? '');
          if (err) {
            const e = err as NodeJS.ErrnoException & { code?: unknown; killed?: boolean; signal?: string };
            if (typeof e.code === 'number' && ok.includes(e.code)) {
              resolve({ stdout: out, stderr: errText, exitCode: e.code });
              return;
            }
            if (e.code === 'ENOENT') {
              reject(new GitError(`git not found (${this.gitBinary}). Install git and make sure it is on PATH.`, args, null, errText, out));
              return;
            }
            const timedOut = !!e.killed && e.signal === 'SIGTERM';
            const code = typeof e.code === 'number' ? e.code : null;
            const first = errText.trim().split(/\r?\n/).filter(Boolean).slice(-3).join(' ') || e.message;
            reject(new GitError(`git ${args[0] ?? ''} failed${timedOut ? ' (timed out)' : ''}: ${first}`, args, code, errText, out, timedOut));
            return;
          }
          resolve({ stdout: out, stderr: errText, exitCode: 0 });
        },
      );
      if (opts.input !== undefined) {
        child.stdin?.end(opts.input);
      }
    });
  }

  /** Runs and returns stdout. */
  async out(args: readonly string[], opts?: GitRunOptions): Promise<string> {
    return (await this.run(args, opts)).stdout;
  }

  /** Runs and returns true for exit 0, false for exit 1 (e.g. `rev-parse --verify`, `diff --quiet`). */
  async test(args: readonly string[], opts?: GitRunOptions): Promise<boolean> {
    try {
      const r = await this.run(args, { ...opts, okExitCodes: [0, 1, 128] });
      return r.exitCode === 0;
    } catch {
      return false;
    }
  }

  async isRepo(): Promise<boolean> {
    return this.test(['rev-parse', '--git-dir']);
  }

  /** Top-level folder of the checkout `cwd` is in. */
  async topLevel(): Promise<string> {
    return (await this.out(['rev-parse', '--show-toplevel'])).trim();
  }

  async revParse(ref: string): Promise<string | undefined> {
    if (!isSafeRef(ref)) return undefined;
    try {
      const r = await this.run(['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`], { okExitCodes: [0, 1] });
      const sha = r.stdout.trim();
      return r.exitCode === 0 && sha ? sha : undefined;
    } catch {
      return undefined;
    }
  }

  /** Current branch name, or undefined when detached / unborn without a name. */
  async currentBranch(): Promise<string | undefined> {
    const r = await this.run(['symbolic-ref', '--quiet', '--short', 'HEAD'], { okExitCodes: [0, 1, 128] });
    const name = r.stdout.trim();
    return r.exitCode === 0 && name ? name : undefined;
  }

  async branchExists(name: string): Promise<boolean> {
    return this.test(['show-ref', '--verify', '--quiet', `refs/heads/${name}`]);
  }
}

/**
 * A ref, branch or sha that is safe to put on a git command line (SEC-21): no leading `-` (would
 * read as an option such as `--output=…`), no whitespace, control characters or `..`.
 */
export const SAFE_REF = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/@{}~^+-]{1,255}$/;
export function isSafeRef(ref: string): boolean {
  return SAFE_REF.test(ref);
}

/** Accept either a path or a ready runner. */
export type Repo = string | Git;
export function toGit(repo: Repo): Git {
  return typeof repo === 'string' ? new Git({ cwd: repo }) : repo;
}

export interface StreamResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

/**
 * Runs a user-supplied command line (e.g. `.oide/setup`: `pnpm install`) in `cwd`, streaming output.
 * The command is a shell line by nature, so it goes through the platform shell explicitly
 * (`cmd.exe /d /s /c` on Windows, `/bin/sh -c` elsewhere). The caller decides trust; this function
 * does not check it.
 */
export function runShellCommand(
  cwd: string,
  command: string,
  opts: {
    onOutput?: (chunk: string, stream: 'stdout' | 'stderr') => void;
    signal?: AbortSignal;
    timeoutMs?: number;
    env?: Record<string, string | undefined>;
  } = {},
): Promise<StreamResult> {
  return new Promise<StreamResult>((resolve, reject) => {
    const isWin = process.platform === 'win32';
    const file = isWin ? process.env.ComSpec || 'cmd.exe' : '/bin/sh';
    const args = isWin ? ['/d', '/s', '/c', `"${command}"`] : ['-c', command];
    const child = spawn(file, args, {
      cwd,
      env: buildEnv(NO_PROMPT_ENV, opts.env),
      windowsHide: true,
      windowsVerbatimArguments: isWin,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let timer: NodeJS.Timeout | undefined;
    // Setup commands start trees (cmd → npm → node …). On Windows `child.kill()` only ends cmd.exe
    // and the rest keeps running (and keeps the worktree locked), so end the whole tree.
    const kill = () => {
      if (child.exitCode !== null) return;
      if (isWin && child.pid !== undefined) {
        try {
          const tk = spawn(windowsTaskkill(), ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
          tk.on('error', () => child.kill());
          return;
        } catch {}
      }
      child.kill();
    };
    if (opts.timeoutMs && opts.timeoutMs > 0) timer = setTimeout(kill, opts.timeoutMs);
    opts.signal?.addEventListener('abort', kill, { once: true });
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (d: string) => opts.onOutput?.(d, 'stdout'));
    child.stderr?.on('data', (d: string) => opts.onOutput?.(d, 'stderr'));
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', kill);
      resolve({ exitCode: code, signal });
    });
  });
}

/** `%SystemRoot%/System32/taskkill.exe` as an absolute path (never a bare name: SEC-01). */
export function windowsTaskkill(env: Record<string, string | undefined> = process.env): string {
  const root = env.SystemRoot ?? env.SYSTEMROOT ?? env.windir ?? 'C:\\Windows';
  return join(root, 'System32', 'taskkill.exe');
}
