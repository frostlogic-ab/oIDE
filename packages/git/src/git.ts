import { execFile, spawn } from 'node:child_process';

/**
 * Typed runner for the system `git` binary. Never goes through a shell: arguments are passed as an
 * array to `execFile`, so paths, branch names and messages cannot inject commands.
 *
 * - Inherits the user's environment unchanged (their credential helpers, SSH agent, config) and only
 *   adds variables that stop git from ever prompting (`GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never`).
 * - Adds `-c core.quotepath=false` everywhere and `-c core.longpaths=true` on Windows.
 * - Rejects with a `GitError` carrying stderr and the exit code.
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

export interface GitOptions {
  cwd: string;
  /** Path to git; default `git` on PATH. */
  gitBinary?: string;
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
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
  const args = ['-c', 'core.quotepath=false', '-c', 'color.ui=false'];
  if (platform === 'win32') args.push('-c', 'core.longpaths=true');
  return args;
}

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

  constructor(opts: GitOptions) {
    this.cwd = opts.cwd;
    this.gitBinary = opts.gitBinary ?? 'git';
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.env = opts.env;
  }

  /** Same settings, different working directory. */
  at(cwd: string): Git {
    return new Git({ cwd, gitBinary: this.gitBinary, timeoutMs: this.timeoutMs, env: this.env });
  }

  run(args: readonly string[], opts: GitRunOptions = {}): Promise<GitResult> {
    const fullArgs = [...baseConfigArgs(), ...args];
    const ok = opts.okExitCodes ?? [0];
    const cwd = opts.cwd ?? this.cwd;
    const timeout = opts.timeoutMs ?? this.timeoutMs;
    return new Promise<GitResult>((resolve, reject) => {
      const child = execFile(
        this.gitBinary,
        fullArgs,
        {
          cwd,
          env: buildEnv(NO_PROMPT_ENV, this.env, opts.env),
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
    try {
      const r = await this.run(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { okExitCodes: [0, 1] });
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
    const kill = () => {
      if (child.exitCode === null) child.kill();
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
