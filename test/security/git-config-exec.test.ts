import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { status } from '../../packages/git/src/index.js';

/**
 * SEC-03 (high). oIDE runs git (status watcher, background fetch, diff, commit, merge) against
 * every opened project, trusted or not, with the repo's own `.git/config` in force. A project that
 * arrives with its `.git` folder (zip/tarball/shared drive, a nested bare repo) can set
 * `core.fsmonitor`, `core.hooksPath`, `diff.external`, `core.sshCommand`, filter drivers,
 * `gpg.program`, ... and get code execution from oIDE's own git calls. Shown with core.fsmonitor
 * on `git status`.
 *
 * Secure behaviour for untrusted projects: neutralise exec-capable config on every call
 * (`-c core.fsmonitor=false -c core.hooksPath=<empty> -c diff.external= --no-ext-diff ...`) or
 * refuse to run git until trusted. Flip `it.fails` to `it` once fixed.
 */
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('SEC-03 repo-controlled git config', () => {
  it('git status does not run core.fsmonitor from the repo config', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oide-sec-fsm-'));
    dirs.push(dir);
    const g = (...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' });
    g('init', '-q');
    writeFileSync(join(dir, 'a.txt'), 'x');
    const marker = join(dir, 'pwned').replace(/\\/g, '/');
    g('config', 'core.fsmonitor', `node -e "require('fs').writeFileSync('${marker}','x')"`);
    await status(dir).catch(() => undefined);
    expect(existsSync(marker)).toBe(false);
  });
});
