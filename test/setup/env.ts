import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Vitest setup (runs in every test worker before the test file loads): make the machine's
 * environment irrelevant, so a test that passes on a developer's machine passes on CI too.
 *
 * 1. A canonical temp folder. `os.tmpdir()` is not always a real path: macOS gives `/var/folders/…`
 *    (a link to `/private/var/…`) and GitHub's Windows runners give `C:\Users\RUNNER~1\…` (an 8.3
 *    short name). git, `realpath` and the path guards report the real path, so comparisons with
 *    paths built from the temp folder failed, and a `~` looks like a protected path to SEC-12.
 * 2. No system or global git config. GitHub's Windows runners set `core.autocrlf=true`, which turned
 *    files merged by the tests into CRLF; a developer's signing, hooks or default branch would leak
 *    in the same way. Tests that need an identity set it on their repo or with `GIT_CONFIG_GLOBAL`.
 */
const realTmp = realpathSync.native(tmpdir());
for (const key of ['TMPDIR', 'TEMP', 'TMP']) process.env[key] = realTmp;

const gitHome = mkdtempSync(join(realTmp, 'oide-test-gitconfig-'));
writeFileSync(join(gitHome, 'gitconfig'), '');
process.env.GIT_CONFIG_GLOBAL = join(gitHome, 'gitconfig');
process.env.GIT_CONFIG_NOSYSTEM = '1';
delete process.env.GIT_CONFIG_SYSTEM;
