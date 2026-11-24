import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  clonePanelMessage,
  extensionOrigin,
  extensionPanelCsp,
  extensionUrl,
  panelFrameSrc,
  resolveExtensionUrl,
  type ExtensionUiSite,
} from './extension-ui.js';

let root: string;
let dir: string;
let outside: string;
const NAME = '@oide-test/ui';

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'oide-extui-'));
  dir = join(root, 'ext');
  outside = join(root, 'secret');
  mkdirSync(join(dir, 'dist', 'assets'), { recursive: true });
  mkdirSync(join(dir, 'node_modules', 'dep'), { recursive: true });
  mkdirSync(join(dir, '.git'), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(dir, 'dist', 'panel.html'), '<!doctype html><title>p</title>');
  writeFileSync(join(dir, 'dist', 'assets', 'app.js'), 'console.log(1)');
  writeFileSync(join(dir, 'dist', 'app.js.map'), '{}');
  writeFileSync(join(dir, 'dist', '.env'), 'TOKEN=1');
  writeFileSync(join(dir, 'node_modules', 'dep', 'index.js'), '');
  writeFileSync(join(dir, '.git', 'config'), '');
  writeFileSync(join(outside, 'keys.json'), '{"k":1}');
  try {
    symlinkSync(outside, join(dir, 'dist', 'linked'), 'junction');
  } catch {
    // symlinks may be unavailable; the test below then checks nothing extra
  }
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

const site = (frameSrc: string[] = []): ExtensionUiSite => ({ name: NAME, dir, frameSrc });
const lookup = (s: ExtensionUiSite) => (origin: string) =>
  origin === extensionOrigin(s.name) ? s : undefined;
const url = (p: string) => `oide-ext://${extensionOrigin(NAME)}/${p}`;

describe('oide-ext:// protocol', () => {
  it('gives every extension its own stable, host-safe origin', () => {
    expect(extensionOrigin(NAME)).toMatch(/^x[0-9a-f]{24}$/);
    expect(extensionOrigin(NAME)).toBe(extensionOrigin(NAME));
    expect(extensionOrigin('@oide-test/other')).not.toBe(extensionOrigin(NAME));
    expect(extensionUrl(NAME, dir, join(dir, 'dist', 'panel.html'))).toBe(url('dist/panel.html'));
    expect(extensionUrl(NAME, dir, join(root, 'secret', 'keys.json'))).toBeNull();
  });

  it('serves files inside the extension folder with the no-network CSP', () => {
    const hit = resolveExtensionUrl(lookup(site()), url('dist/panel.html'));
    expect(hit).toMatchObject({ mime: 'text/html; charset=utf-8', extension: NAME });
    expect(hit?.csp).toContain("connect-src 'none'");
    expect(hit?.csp).toContain("frame-src 'none'");
    expect(hit?.csp).toContain("default-src 'none'");
    expect(hit?.csp).toContain("form-action 'none'");
    expect(resolveExtensionUrl(lookup(site()), url('dist/assets/app.js'))?.mime).toMatch(/javascript/);
  });

  it('refuses traversal, dot files, node_modules, unknown types, other origins and symlinks out', () => {
    const l = lookup(site());
    for (const p of [
      'dist/../../secret/keys.json',
      'dist/%2e%2e/%2e%2e/secret/keys.json',
      'dist/.env',
      '.git/config',
      'node_modules/dep/index.js',
      'NODE_MODULES/dep/index.js',
      'dist/app.js.map',
      'dist/linked/keys.json',
      'dist/panel.html:stream',
      'dist/',
      'dist/missing.html',
    ]) {
      expect(resolveExtensionUrl(l, url(p)), p).toBeNull();
    }
    expect(
      resolveExtensionUrl(l, `oide-ext://${extensionOrigin('@oide-test/other')}/dist/panel.html`),
    ).toBeNull();
    expect(resolveExtensionUrl(l, 'oide-artifact://x/dist/panel.html')).toBeNull();
    expect(resolveExtensionUrl(() => undefined, url('dist/panel.html'))).toBeNull();
  });

  it('allows loopback frames only for extensions that declare localhost', () => {
    expect(panelFrameSrc(['localhost'])).toContain('http://localhost:*');
    expect(panelFrameSrc(['github.com'])).toEqual([]);
    expect(panelFrameSrc([])).toEqual([]);
    const csp = extensionPanelCsp(panelFrameSrc(['localhost']));
    expect(csp).toContain('frame-src http://localhost:* http://127.0.0.1:*');
    expect(csp).toContain("connect-src 'none'");
    expect(
      resolveExtensionUrl(lookup(site(panelFrameSrc(['localhost']))), url('dist/panel.html'))?.csp,
    ).toContain('http://127.0.0.1:*');
  });

  it('panel messages must be JSON data under the size limit', () => {
    expect(clonePanelMessage({ a: [1, 'b'] })).toEqual({ ok: true, value: { a: [1, 'b'] } });
    expect(clonePanelMessage(undefined)).toEqual({ ok: true, value: null });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(clonePanelMessage(cyclic).ok).toBe(false);
    expect(clonePanelMessage('x'.repeat(300 * 1024)).ok).toBe(false);
  });
});
