import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isPublicRegistry, npmrcFor, NpmRegistryService, parseNpmrc, registryPath, toPackageVersions } from './npm-registry.js';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('parseNpmrc', () => {
  it('keeps only registry keys', () => {
    const rc = parseNpmrc(
      ['# comment', 'registry=https://registry.npmjs.org', '@corp:registry = "https://npm.corp.example/"', '//npm.corp.example/:_authToken=${NPM_TOKEN}', 'save-exact=true', '; other'].join('\n'),
    );
    expect(rc).toEqual({ registry: 'https://registry.npmjs.org/', scopes: { '@corp': 'https://npm.corp.example/' } });
    expect(JSON.stringify(rc)).not.toContain('Token');
  });
});

describe('isPublicRegistry', () => {
  it('knows the public registry and its yarn mirror', () => {
    expect(isPublicRegistry('https://registry.npmjs.org/')).toBe(true);
    expect(isPublicRegistry('https://registry.yarnpkg.com')).toBe(true);
    expect(isPublicRegistry('https://npm.pkg.github.com/')).toBe(false);
    expect(isPublicRegistry('not a url')).toBe(false);
  });
});

describe('npmrcFor', () => {
  it('merges .npmrc files from the root down to the file, nearest wins, never above the root', async () => {
    const root = resolve('/repo');
    const files: Record<string, string> = {
      [join(resolve('/'), '.npmrc')]: 'registry=https://outside.example/',
      [join(root, '.npmrc')]: 'registry=https://registry.npmjs.org/\n@a:registry=https://a.example/',
      [join(root, 'packages', 'x', '.npmrc')]: '@a:registry=https://registry.npmjs.org/',
    };
    const read = async (p: string) => {
      const t = files[p];
      if (t === undefined) throw new Error('ENOENT');
      return t;
    };
    expect(await npmrcFor(root, 'packages/x/package.json', read)).toEqual({ registry: 'https://registry.npmjs.org/', scopes: { '@a': 'https://registry.npmjs.org/' } });
    expect(await npmrcFor(root, 'package.json', read)).toEqual({ registry: 'https://registry.npmjs.org/', scopes: { '@a': 'https://a.example/' } });
  });
});

describe('registryPath', () => {
  it('encodes the whole name as one path segment, keeping the scope @', () => {
    expect(registryPath('react')).toBe('react');
    expect(registryPath('@types/node')).toBe('@types%2Fnode');
    // Names are Zod-validated before this, but nothing can still split the path.
    expect(registryPath('@a/b/c')).toBe('@a%2Fb%2Fc');
    expect(registryPath('a?b#c')).toBe('a%3Fb%23c');
  });
});

describe('toPackageVersions', () => {
  it('validates the dist-tags', () => {
    expect(toPackageVersions({ latest: '1.2.3', next: '2.0.0-rc.1', bad: 'nope', n: 5 })).toEqual({ latest: '1.2.3', tags: { latest: '1.2.3', next: '2.0.0-rc.1' } });
    expect(toPackageVersions({ next: '1.0.0' })).toBeNull();
    expect(toPackageVersions({ latest: '<script>' })).toBeNull();
    expect(toPackageVersions([])).toBeNull();
    expect(toPackageVersions(null)).toBeNull();
  });
});

describe('NpmRegistryService', () => {
  afterEach(() => {
    delete process.env.OIDE_NPM_REGISTRY;
  });
  const noRc = async () => {
    throw new Error('ENOENT');
  };

  it('asks the dist-tags endpoint once per package and caches the answer', async () => {
    const fetchFn = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.endsWith('/-/package/react/dist-tags')) return json({ latest: '19.1.0' });
      if (u.endsWith('/-/package/@types%2Fnode/dist-tags')) return json({ latest: '24.0.0', next: '25.0.0-beta.1' });
      return json({ error: 'not found' }, 404);
    });
    const svc = new NpmRegistryService({ fetch: fetchFn as typeof fetch, enabled: () => true, read: noRc });
    const res = await svc.latest('/repo', 'package.json', ['react', '@types/node', 'private-thing', 'react']);
    expect(res).toEqual({
      status: 'ok',
      packages: {
        react: { latest: '19.1.0', tags: { latest: '19.1.0' } },
        '@types/node': { latest: '24.0.0', tags: { latest: '24.0.0', next: '25.0.0-beta.1' } },
        'private-thing': null,
      },
    });
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(String(fetchFn.mock.calls[0]![0])).toBe('https://registry.npmjs.org/-/package/react/dist-tags');
    await svc.latest('/repo', 'package.json', ['react', 'private-thing']);
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it('refreshes after the cache expires, sooner after a failure', async () => {
    let now = 0;
    let fail = true;
    const fetchFn = vi.fn(async () => (fail ? json({}, 500) : json({ latest: '1.0.0' })));
    const svc = new NpmRegistryService({ fetch: fetchFn as typeof fetch, enabled: () => true, now: () => now, read: noRc });
    expect((await svc.latest('/r', 'package.json', ['a'])).packages.a).toBeNull();
    fail = false;
    now = 60_000;
    await svc.latest('/r', 'package.json', ['a']);
    expect(fetchFn).toHaveBeenCalledTimes(1); // still within the failure TTL: no retry loop
    now = 3 * 60_000;
    expect((await svc.latest('/r', 'package.json', ['a'])).packages.a).toEqual({ latest: '1.0.0', tags: { latest: '1.0.0' } });
    now += 10 * 60_000;
    await svc.latest('/r', 'package.json', ['a']);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    now += 31 * 60_000;
    await svc.latest('/r', 'package.json', ['a']);
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it('sends nothing when turned off', async () => {
    const fetchFn = vi.fn();
    const off = new NpmRegistryService({ fetch: fetchFn as unknown as typeof fetch, enabled: () => false, read: noRc });
    expect(await off.latest('/r', 'package.json', ['a'])).toEqual({ status: 'off', packages: {} });
    process.env.OIDE_NPM_REGISTRY = 'off';
    const env = new NpmRegistryService({ fetch: fetchFn as unknown as typeof fetch, enabled: () => true, read: noRc });
    expect(await env.latest('/r', 'package.json', ['a'])).toEqual({ status: 'off', packages: {} });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('honours the .npmrc: a private default registry stops every lookup, private scopes are skipped', async () => {
    const fetchFn = vi.fn(async () => json({ latest: '1.0.0' }));
    const rc = (text: string) => async (p: string) => {
      if (p === join(resolve('/r'), '.npmrc')) return text;
      throw new Error('ENOENT');
    };
    const priv = new NpmRegistryService({ fetch: fetchFn as typeof fetch, enabled: () => true, read: rc('registry=https://npm.corp.example/') });
    expect(await priv.latest('/r', 'package.json', ['a'])).toEqual({ status: 'private-registry', packages: {} });
    expect(fetchFn).not.toHaveBeenCalled();

    const scoped = new NpmRegistryService({ fetch: fetchFn as typeof fetch, enabled: () => true, read: rc('@corp:registry=https://npm.corp.example/') });
    const res = await scoped.latest('/r', 'package.json', ['@corp/ui', 'a']);
    expect(Object.keys(res.packages)).toEqual(['a']);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('keeps at most 8 requests in flight', async () => {
    let inFlight = 0;
    let peak = 0;
    const fetchFn = vi.fn(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return json({ latest: '1.0.0' });
    });
    const svc = new NpmRegistryService({ fetch: fetchFn as typeof fetch, enabled: () => true, read: noRc });
    const names = Array.from({ length: 30 }, (_, i) => `p${i}`);
    const res = await svc.latest('/r', 'package.json', names);
    expect(Object.values(res.packages).every((p) => p?.latest === '1.0.0')).toBe(true);
    expect(peak).toBeLessThanOrEqual(8);
  });
});
