import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { InstalledExtension, MarketplaceIndex } from '@oide/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { InstallError, MarketplaceInstaller } from '../src/installer.js';
import { computeIntegrity, verifyIntegrity } from '../src/integrity.js';
import { extractTarball, inspectTarball, TarballError } from '../src/tarball.js';
import { extensionTarball, makeTar, samplePkg, tempDir } from './helpers.js';

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});
const tmp = () => {
  const t = tempDir();
  cleanups.push(t.cleanup);
  return t.dir;
};

describe('integrity', () => {
  const data = Buffer.from('hello tarball');
  it('accepts a matching sha512, sha384 or sha256', () => {
    expect(verifyIntegrity(data, computeIntegrity(data, 'sha512'))).toBe(true);
    expect(verifyIntegrity(data, computeIntegrity(data, 'sha384'))).toBe(true);
    expect(verifyIntegrity(data, computeIntegrity(data, 'sha256'))).toBe(true);
  });
  it('rejects a wrong hash, a tampered body and unsupported algorithms', () => {
    expect(verifyIntegrity(data, computeIntegrity(Buffer.from('other'), 'sha512'))).toBe(false);
    expect(verifyIntegrity(Buffer.from('hello tarbalL'), computeIntegrity(data))).toBe(false);
    expect(verifyIntegrity(data, 'md5-XrY7u+Ae7tCTyyK7j1rNww==')).toBe(false);
    expect(verifyIntegrity(data, '')).toBe(false);
  });
  it('uses the strongest hash when several are given', () => {
    const weakGood = computeIntegrity(data, 'sha256');
    const strongBad = computeIntegrity(Buffer.from('x'), 'sha512');
    expect(verifyIntegrity(data, `${weakGood} ${strongBad}`)).toBe(false);
  });
});

describe('tarball extraction', () => {
  it('extracts an npm tarball, stripping package/', async () => {
    const dest = path.join(tmp(), 'out');
    await extractTarball(extensionTarball({ name: 'x' }, { 'dist/a.js': 'A' }), dest);
    expect(readFileSync(path.join(dest, 'dist', 'a.js'), 'utf8')).toBe('A');
    expect(existsSync(path.join(dest, 'package.json'))).toBe(true);
  });

  const bad: Array<[string, Parameters<typeof makeTar>[0]]> = [
    ['.. traversal', [{ path: 'package/package.json', body: '{}' }, { path: 'package/../../evil.txt', body: 'x' }]],
    ['absolute path', [{ path: '/tmp/evil.txt', body: 'x' }]],
    ['drive path', [{ path: 'C:/evil.txt', body: 'x' }]],
    ['backslash traversal', [{ path: 'package/..\\..\\evil.txt', body: 'x' }]],
    ['symlink escaping', [{ path: 'package/package.json', body: '{}' }, { path: 'package/link', type: '2', linkpath: '../../etc/passwd' }]],
    ['absolute symlink', [{ path: 'package/link', type: '2', linkpath: '/etc/passwd' }]],
    ['hard link', [{ path: 'package/package.json', body: '{}' }, { path: 'package/hl', type: '1', linkpath: 'package/package.json' }]],
    ['device', [{ path: 'package/dev', type: '3' }]],
    ['two top folders', [{ path: 'package/a', body: 'x' }, { path: 'other/b', body: 'y' }]],
  ];
  for (const [name, entries] of bad) {
    it(`rejects ${name} and writes nothing`, async () => {
      const root = tmp();
      const dest = path.join(root, 'ext', 'out');
      await expect(extractTarball(makeTar(entries), dest)).rejects.toBeInstanceOf(TarballError);
      expect(existsSync(dest)).toBe(false);
      expect(existsSync(path.join(root, 'evil.txt'))).toBe(false);
      expect(existsSync(path.join(root, 'ext')) ? readdirSync(path.join(root, 'ext')) : []).toEqual([]);
    });
  }

  it('rejects every symlink, including chains that look inside the package', async () => {
    await expect(inspectTarball(makeTar([{ path: 'package/dist/a.js', body: 'A' }, { path: 'package/dist/b.js', type: '2', linkpath: 'a.js' }]))).rejects.toThrow(/symbolic link/);
    const chain = [
      { path: 'package/sub/x', type: '2', linkpath: '..' },
      { path: 'package/a', type: '2', linkpath: 'sub/x' },
      { path: 'package/esc', type: '2', linkpath: 'a/..' },
    ] as const;
    await expect(inspectTarball(makeTar([...chain]))).rejects.toThrow(/symbolic link/);
  });

  it('enforces size limits', async () => {
    await expect(inspectTarball(makeTar([{ path: 'package/a', body: 'x'.repeat(2000) }]), { maxTotalBytes: 1000 })).rejects.toThrow(/too large/);
  });
});

function indexWith(tarball: Buffer, over: Partial<MarketplaceIndex['extensions'][number]['versions'][number]> = {}): MarketplaceIndex {
  return {
    version: 1,
    generatedAt: '2026-11-24T00:00:00Z',
    extensions: [
      {
        name: '@oide-community/sample',
        displayName: 'Sample',
        publisher: 'oide-community',
        description: 'Sample',
        categories: ['agent-tools'],
        verified: true,
        source: 'npm',
        downloads: 0,
        versions: [
          {
            version: '1.2.0',
            tarball: 'https://registry.npmjs.org/@oide-community/sample/-/sample-1.2.0.tgz',
            integrity: computeIntegrity(tarball),
            engine: '^1.0.0',
            tools: [
              { name: 'db.schema', risk: 'read' },
              { name: 'db.write', risk: 'ask' },
            ],
            ...over,
          },
        ],
      },
    ],
  };
}

const goodTarball = () => extensionTarball(samplePkg(), { 'dist/host.js': 'export function activate() {}', 'dist/mcp.js': '', 'dist/panel.html': '<p>hi</p>' });

function fakeFetch(routes: Record<string, () => Response>): typeof fetch & { calls: string[] } {
  const calls: string[] = [];
  const f = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    const r = routes[url];
    if (!r) throw new Error('offline');
    return r();
  }) as typeof fetch & { calls: string[] };
  f.calls = calls;
  return f;
}

describe('MarketplaceInstaller', () => {
  it('installs after verifying the hash, and rejects a bad hash before extracting', async () => {
    const root = tmp();
    const tgz = goodTarball();
    const url = 'https://registry.npmjs.org/@oide-community/sample/-/sample-1.2.0.tgz';
    const index = indexWith(tgz);
    const fetch = fakeFetch({ 'https://idx/index.json': () => Response.json(index), [url]: () => new Response(tgz) });
    const inst = new MarketplaceInstaller({ extensionsDir: path.join(root, 'extensions'), cacheDir: path.join(root, 'cache'), indexUrl: 'https://idx/index.json', fetch });
    const r = await inst.install('@oide-community/sample');
    expect(r.record.source).toBe('marketplace');
    expect(r.record.reviewed).toBe(true);
    expect(existsSync(path.join(root, 'extensions', 'oide-community__sample@1.2.0', 'dist', 'host.js'))).toBe(true);

    const tampered = Buffer.from(tgz);
    tampered[tampered.length - 30] = (tampered[tampered.length - 30] ?? 0) ^ 0xff;
    const fetch2 = fakeFetch({ 'https://idx/index.json': () => Response.json(index), [url]: () => new Response(tampered) });
    const root2 = tmp();
    const inst2 = new MarketplaceInstaller({ extensionsDir: path.join(root2, 'extensions'), cacheDir: path.join(root2, 'cache'), indexUrl: 'https://idx/index.json', fetch: fetch2 });
    await expect(inst2.install('@oide-community/sample')).rejects.toThrow(/integrity/);
    expect(existsSync(path.join(root2, 'extensions'))).toBe(false);
  });

  it('rejects a package that declares tools the index does not list', async () => {
    const root = tmp();
    const tgz = goodTarball();
    const index = indexWith(tgz, { tools: [{ name: 'db.schema', risk: 'read' }] });
    const entry = index.extensions[0]!;
    const inst = new MarketplaceInstaller({ extensionsDir: path.join(root, 'ext'), cacheDir: path.join(root, 'cache'), fetch: fakeFetch({}) });
    await expect(inst.installTarball(tgz, entry, entry.versions[0]!)).rejects.toBeInstanceOf(InstallError);
    expect(existsSync(path.join(root, 'ext', 'oide-community__sample@1.2.0'))).toBe(false);
  });

  it('rejects code that is not bundled in dist/', async () => {
    const root = tmp();
    const pkg = samplePkg({}, { main: 'host.js', mcpServers: {}, contributes: {} });
    const tgz = extensionTarball(pkg, { 'host.js': '' });
    const index = indexWith(tgz, { tools: [] });
    const entry = index.extensions[0]!;
    const inst = new MarketplaceInstaller({ extensionsDir: path.join(root, 'ext'), cacheDir: path.join(root, 'cache'), fetch: fakeFetch({}) });
    await expect(inst.installTarball(tgz, entry, entry.versions[0]!)).rejects.toThrow(/dist/);
  });

  it('caches the index for a day and falls back to the cache, then the bundled index, offline', async () => {
    const root = tmp();
    const index = indexWith(goodTarball());
    let now = 1_000_000;
    let online = true;
    const fetch = (async () => {
      if (!online) throw new Error('offline');
      return Response.json(index);
    }) as typeof globalThis.fetch;
    const mk = () => new MarketplaceInstaller({ extensionsDir: path.join(root, 'ext'), cacheDir: path.join(root, 'cache'), indexUrl: 'https://idx/i.json', fetch, now: () => now });
    expect((await mk().getIndex()).from).toBe('network');
    expect((await mk().getIndex()).from).toBe('cache');
    now += 25 * 60 * 60 * 1000;
    online = false;
    expect((await mk().getIndex()).from).toBe('cache');

    const bundled = path.join(root, 'bundled.json');
    writeFileSync(bundled, JSON.stringify(index));
    const offline = new MarketplaceInstaller({ extensionsDir: path.join(root, 'e2'), cacheDir: path.join(root, 'c2'), bundledIndexPath: bundled, fetch });
    const r = await offline.getIndex();
    expect(r.from).toBe('bundled');
    expect(r.index.extensions).toHaveLength(1);
  });

  it('flags updates that add tools or capabilities', async () => {
    const root = tmp();
    const tgz = goodTarball();
    const index = indexWith(tgz);
    const entry = index.extensions[0]!;
    const v = entry.versions[0]!;
    entry.versions.push({ ...v, version: '1.3.0', tools: [...v.tools, { name: 'db.drop', risk: 'ask' }], capabilities: { network: ['db.example.com'], spawn: false } });
    entry.versions.push({ ...v, version: '1.2.1' });
    const inst = new MarketplaceInstaller({ extensionsDir: path.join(root, 'ext'), cacheDir: path.join(root, 'cache'), fetch: (async () => Response.json(index)) as typeof fetch });
    const installed = await inst.installTarball(tgz, entry, v);
    const ups = await inst.checkUpdates([installed.record as InstalledExtension]);
    expect(ups).toHaveLength(1);
    expect(ups[0]).toMatchObject({ from: '1.2.0', to: '1.3.0', needsConsent: true, addedTools: ['db.drop'], addedCapabilities: ['network:db.example.com'] });
  });
});
