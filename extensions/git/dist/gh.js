// GitHub CLI helpers for the Git extension. No shell: args go straight to execFile.
import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';
import path from 'node:path';

export const PR_FIELDS = ['number', 'title', 'url', 'state', 'isDraft', 'headRefName', 'baseRefName', 'reviewDecision'];

/**
 * Arguments for `gh` per command.
 * @param {'open' | 'view' | 'view-web'} what
 * @param {{ base?: string, draft?: boolean }} [opts]
 * @returns {string[]}
 */
export function ghArgs(what, opts = {}) {
  if (what === 'open') {
    // --web opens the "create pull request" page in the system browser, prefilled from commits.
    const args = ['pr', 'create', '--web', '--fill'];
    if (opts.base) {
      if (!/^[\w./-]+$/.test(opts.base)) throw new Error('Invalid base branch name');
      args.push('--base', opts.base);
    }
    if (opts.draft) args.push('--draft');
    return args;
  }
  if (what === 'view-web') return ['pr', 'view', '--web'];
  return ['pr', 'view', '--json', PR_FIELDS.join(',')];
}

/** @param {unknown} cwd */
export function checkCwd(cwd) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw new Error('A worktree folder is needed');
  if (!statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`Not a folder: ${cwd}`);
  return cwd;
}

/**
 * @param {string} gh
 * @param {string[]} args
 * @param {string} cwd
 * @returns {Promise<string>}
 */
export function runGh(gh, args, cwd) {
  return new Promise((resolve, reject) => {
    execFile(gh, args, { cwd, timeout: 60_000, windowsHide: true, env: { ...process.env, GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0' } }, (err, stdout, stderr) => {
      if (err) {
        const code = /** @type {NodeJS.ErrnoException} */ (err).code;
        if (code === 'ENOENT') reject(new Error('The GitHub CLI (gh) is not installed or not on PATH'));
        else reject(new Error(String(stderr || err.message).trim().split('\n').slice(-3).join(' ')));
        return;
      }
      resolve(String(stdout));
    });
  });
}
