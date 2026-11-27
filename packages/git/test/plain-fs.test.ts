import { execFileSync } from 'node:child_process';
import * as nodeFs from 'node:fs';
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { plainFs, plainFsPromises } from '../src/plain-fs.js';
import { cleanup, tempDir } from './helpers.js';

afterAll(cleanup);

const repoRoot = resolve(import.meta.dirname, '..', '..', '..');

/** The dev Electron binary (apps/desktop devDependency), or undefined when it was not downloaded. */
function electronBinary(): string | undefined {
  try {
    const p = createRequire(join(repoRoot, 'apps', 'desktop', 'package.json'))('electron') as unknown;
    return typeof p === 'string' && existsSync(p) ? p : undefined;
  } catch {
    return undefined;
  }
}

/** Electron's own `default_app.asar`: a real archive, as found in every worktree's node_modules. */
function defaultAppAsar(exe: string): string | undefined {
  const dir = process.platform === 'darwin' ? join(dirname(exe), '..', 'Resources') : join(dirname(exe), 'resources');
  const p = join(dir, 'default_app.asar');
  return existsSync(p) ? p : undefined;
}

describe('plainFs', () => {
  it('is node:fs outside Electron', () => {
    expect(plainFs).toBe(nodeFs);
    expect(plainFsPromises).toBe(nodeFs.promises);
  });

  const exe = electronBinary();
  const asar = exe ? defaultAppAsar(exe) : undefined;

  // The incident: inside Electron, fs.rm of a worktree with node_modules/electron failed with
  // "EBUSY: rmdir '…\default_app.asar'" and the archive stayed open until oIDE quit.
  it.skipIf(!exe || !asar)('deletes a folder holding an .asar archive inside Electron, where node:fs cannot', () => {
    const base = tempDir('oide-asar-');
    const tree = (name: string) => {
      const res = join(base, name, 'node_modules', 'electron', 'dist', 'resources');
      mkdirSync(res, { recursive: true });
      copyFileSync(asar!, join(res, 'default_app.asar'));
      return join(base, name);
    };
    const patched = tree('patched');
    const plain = tree('plain');
    const script = join(base, 'probe.mjs');
    writeFileSync(
      script,
      `import { rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
const { plainFs, plainFsPromises } = await import(process.argv[2]);
const out = { isOriginal: plainFs !== (await import('node:fs')).default };
try { await rm(process.argv[3], { recursive: true, force: true, maxRetries: 0 }); out.patched = 'ok'; } catch (e) { out.patched = e.code; }
out.patchedLeft = existsSync(process.argv[3]);
try { await plainFsPromises.rm(process.argv[4], { recursive: true, force: true, maxRetries: 0 }); out.plain = 'ok'; } catch (e) { out.plain = e.code; }
out.plainLeft = existsSync(process.argv[4]);
console.log(JSON.stringify(out));
`,
    );
    const stdout = execFileSync(exe!, [script, pathToFileURL(join(repoRoot, 'packages', 'git', 'src', 'plain-fs.ts')).href, patched, plain], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      encoding: 'utf8',
      timeout: 60_000,
    });
    const r = JSON.parse(stdout.trim().split(/\r?\n/).pop()!) as Record<string, unknown>;
    expect(r.isOriginal).toBe(true);
    expect(r).toMatchObject({ plain: 'ok', plainLeft: false });
    // What oIDE used to do (Windows, where an open file blocks its folder's deletion).
    if (process.platform === 'win32') expect(r).toMatchObject({ patched: 'EBUSY', patchedLeft: true });
  }, 90_000);
});
