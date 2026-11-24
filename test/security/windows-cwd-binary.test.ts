import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Git } from '../../packages/git/src/index.js';

/**
 * SEC-01 (critical). On Windows, Node/libuv resolves a bare command name (`git`, `gh`, `node`)
 * in the child's `cwd` BEFORE PATH, unless NoDefaultCurrentDirectoryInExePath is set (it is not
 * on a normal user machine). oIDE runs `git` with cwd = the folder the user opens, so a cloned
 * repo that ships `git.exe` (or `git.com`) at its root runs attacker code on `projects.open`,
 * before the trust dialog. The planted binary here is a renamed copy of hostname.exe; git's own
 * "not a git repository" error is replaced by hostname.exe's usage error.
 *
 * Secure behaviour: the Git runner resolves `git` to an absolute path from PATH (never from cwd),
 * and main sets NoDefaultCurrentDirectoryInExePath=1 at startup. Flip `it.fails` to `it` once fixed.
 */
describe.skipIf(process.platform !== 'win32')('SEC-01 planted git.exe in an opened folder', () => {
  let dir: string;
  let saved: string | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'oide-sec-plant-'));
    copyFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'hostname.exe'), join(dir, 'git.exe'));
    // Simulate a default Windows machine (some shells set this; most users never do).
    saved = process.env.NoDefaultCurrentDirectoryInExePath;
    delete process.env.NoDefaultCurrentDirectoryInExePath;
  });
  afterEach(() => {
    if (saved !== undefined) process.env.NoDefaultCurrentDirectoryInExePath = saved;
    rmSync(dir, { recursive: true, force: true });
  });

  it('does not execute git.exe from the opened folder', async () => {
    // Real git answers "not a git repository"; the planted binary answers with its own error.
    await expect(new Git({ cwd: dir, timeoutMs: 5000 }).topLevel()).rejects.toThrow(/not a git repository/i);
  });
});
