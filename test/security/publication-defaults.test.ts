import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_MARKETPLACE_INDEX_URL, PLANNED_GITHUB_OWNER } from '../../packages/protocol/src/index.js';
import { setConfirmOverride, type ConfirmOptions } from '../../apps/desktop/src/main/security/confirm.js';
import { cleanup, startHarness, type Harness } from '../integration/harness.js';

/**
 * Publication blockers (docs/wiki/pages/review-publication.md): no runtime default may fetch from
 * the unclaimed `oide-dev` GitHub org or the `@oide` npm scope someone else owns, a remote
 * marketplace index needs the user's native confirmation, and there is no telemetry switch.
 */
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const open: Harness[] = [];
afterEach(async () => {
  setConfirmOverride(null);
  while (open.length) {
    const h = open.pop()!;
    await h.close().catch(() => undefined);
    cleanup(h.userData);
  }
});
async function harness(opts: Parameters<typeof startHarness>[0] = {}): Promise<Harness> {
  const h = await startHarness(opts);
  open.push(h);
  return h;
}

/** Shipped sources: what electron-vite bundles (no tests, mocks or docs). */
function shippedSources(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) {
        if (!['node_modules', 'dist', 'out', 'test', 'mock', 'e2e', 'fixtures'].includes(name)) walk(p);
      } else if (/\.(ts|tsx|mjs|js)$/.test(name) && !/\.(test|spec)\.|\.d\.ts$/.test(name)) out.push(p);
    }
  };
  for (const d of ['apps/desktop/src/main', 'apps/desktop/src/preload', 'packages/extension-host/src', 'packages/protocol/src', 'packages/store/src', 'packages/agent-core/src']) walk(join(ROOT, d));
  return out;
}

describe('distribution defaults', () => {
  it('no shipped source builds a fetch URL from the unclaimed org or the foreign npm scope', () => {
    expect(DEFAULT_MARKETPLACE_INDEX_URL).toBe('');
    const offenders: string[] = [];
    for (const file of shippedSources()) {
      const rel = relative(ROOT, file).split(sep).join('/');
      if (rel === 'packages/protocol/src/distribution.ts') continue; // the documented PLANNED_* names
      const text = readFileSync(file, 'utf8');
      if (/raw\.githubusercontent\.com\/oide-dev|github\.com\/oide-dev|registry\.npmjs\.org\/@oide\//.test(text)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
    expect(PLANNED_GITHUB_OWNER).toBe('oide-dev');
  });

  it('electron-builder has no default release feed', () => {
    const yml = readFileSync(join(ROOT, 'apps/desktop/electron-builder.yml'), 'utf8');
    expect(yml).toMatch(/^publish: null$/m);
    expect(yml).not.toMatch(/^\s*owner:/m);
  });

  it('the marketplace uses the bundled index and fetches nothing until a URL is configured', async () => {
    const h = await harness();
    expect((await h.call('settings.get', undefined)).marketplace.indexUrl).toBe('');
    expect(h.services.extensions.installer.indexUrl).toBe('');
  });

  it('setting a remote marketplace index URL needs a native confirmation in main', async () => {
    const h = await harness(); // plain Node, no override: Cancel
    expect(await h.fails('settings.update', { patch: { marketplace: { indexUrl: 'https://index.example.com/index.json' } } })).toBe('forbidden');
    expect((await h.call('settings.get', undefined)).marketplace.indexUrl).toBe('');
    // Not https, or with credentials: refused before any dialog.
    expect(await h.fails('settings.update', { patch: { marketplace: { indexUrl: 'http://index.example.com/index.json' } } })).toBe('invalid_input');
    expect(await h.fails('settings.update', { patch: { marketplace: { indexUrl: 'https://u:p@index.example.com/i.json' } } })).toBe('invalid_input');

    const seen: ConfirmOptions[] = [];
    setConfirmOverride((o) => (seen.push(o), true));
    const url = 'https://index.example.com/index.json';
    expect((await h.call('settings.update', { patch: { marketplace: { indexUrl: url } } })).marketplace.indexUrl).toBe(url);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.detail).toContain('Origin: https://index.example.com');
    expect(h.services.extensions.installer.indexUrl).toBe(url);
    // The same value again, or clearing it, asks nothing.
    await h.call('settings.update', { patch: { marketplace: { indexUrl: url } } });
    await h.call('settings.update', { patch: { marketplace: { indexUrl: '' } } });
    expect(seen).toHaveLength(1);
    expect(h.services.extensions.installer.indexUrl).toBe('');
  });
});

describe('no telemetry', () => {
  it('Settings › Privacy has no usage-statistics switch and nothing reads ui.telemetry', () => {
    const privacy = readFileSync(join(ROOT, 'apps/desktop/src/renderer/src/screens/Settings/OtherSections.tsx'), 'utf8');
    expect(privacy).not.toMatch(/Share anonymous usage statistics|ui\.telemetry|\{ telemetry:/);
    expect(privacy).toMatch(/no telemetry/);
    const readers = shippedSources().filter((f) => /\.telemetry\b/.test(readFileSync(f, 'utf8')));
    expect(readers.map((f) => relative(ROOT, f))).toEqual([]);
  });
});
