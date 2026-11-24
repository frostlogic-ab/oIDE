import { execFile } from 'node:child_process';

/**
 * Optional GitHub CLI wrapper used for PR state and "Open pull request". It uses the user's own
 * `gh` login; oIDE never reads gh's token. Everything returns `undefined` (and the UI hides PR
 * state) when `gh` is missing, signed out, or the repo has no GitHub remote.
 */

export interface PrInfo {
  /** `open`, `draft`, `closed` or `merged`. */
  state: string;
  number?: number;
  url?: string;
}

interface Run {
  stdout: string;
  stderr: string;
  code: number | null;
}

export class GhCli {
  private readonly bin: string;
  private readonly timeoutMs: number;
  private availableCache: Promise<boolean> | undefined;

  constructor(opts: { ghBinary?: string; timeoutMs?: number } = {}) {
    this.bin = opts.ghBinary ?? 'gh';
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  private run(args: string[], cwd?: string): Promise<Run> {
    return new Promise((resolve) => {
      execFile(
        this.bin,
        args,
        {
          cwd,
          timeout: this.timeoutMs,
          windowsHide: true,
          maxBuffer: 16 * 1024 * 1024,
          env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', GIT_TERMINAL_PROMPT: '0', NO_COLOR: '1' },
        },
        (err, stdout, stderr) => {
          const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : null) : 0;
          resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), code });
        },
      );
    });
  }

  /** True when `gh` is installed and signed in. Cached; call `refresh()` after the user signs in. */
  available(): Promise<boolean> {
    this.availableCache ??= (async () => {
      const v = await this.run(['--version']);
      if (v.code !== 0) return false;
      const auth = await this.run(['auth', 'status']);
      return auth.code === 0;
    })();
    return this.availableCache;
  }

  refresh(): void {
    this.availableCache = undefined;
  }

  /** PR for a branch, or undefined when there is none or gh is unavailable. */
  async prView(cwd: string, branch: string): Promise<PrInfo | undefined> {
    if (!(await this.available())) return undefined;
    const r = await this.run(['pr', 'view', branch, '--json', 'state,number,url,isDraft'], cwd);
    if (r.code !== 0) return undefined;
    return parsePrView(r.stdout);
  }

  /** Create a PR. Returns its URL, or undefined when gh is unavailable. Throws with gh's message on failure. */
  async prCreate(cwd: string, opts: { title: string; body: string; base?: string; head?: string; draft?: boolean }): Promise<{ url: string } | undefined> {
    if (!(await this.available())) return undefined;
    const args = ['pr', 'create', '--title', opts.title, '--body', opts.body];
    if (opts.base) args.push('--base', opts.base);
    if (opts.head) args.push('--head', opts.head);
    if (opts.draft) args.push('--draft');
    const r = await this.run(args, cwd);
    if (r.code !== 0) throw new Error(`gh pr create failed: ${(r.stderr || r.stdout).trim()}`);
    const url = r.stdout.trim().split(/\r?\n/).reverse().find((l) => /^https?:\/\//.test(l.trim()));
    return { url: (url ?? r.stdout).trim() };
  }
}

export function parsePrView(json: string): PrInfo | undefined {
  try {
    const v = JSON.parse(json) as { state?: string; number?: number; url?: string; isDraft?: boolean };
    if (!v.state) return undefined;
    const state = v.isDraft && v.state === 'OPEN' ? 'draft' : v.state.toLowerCase();
    return { state, number: v.number, url: v.url };
  } catch {
    return undefined;
  }
}
