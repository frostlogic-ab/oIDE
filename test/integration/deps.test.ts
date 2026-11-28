import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, makeRepo, startHarness, tempDir, type Harness } from './harness.js';

/**
 * deps.latest (apps/desktop/src/main/handlers/deps.ts) through the real IPC router and core
 * services: Zod validation of the names, the path guard, and the package.json-only rule. Lookups
 * are turned off (`OIDE_NPM_REGISTRY=off`, as in e2e), so nothing reaches the network.
 */

const open: Array<{ h: Harness; dirs: string[] }> = [];
const prev = process.env.OIDE_NPM_REGISTRY;
afterEach(async () => {
  if (prev === undefined) delete process.env.OIDE_NPM_REGISTRY;
  else process.env.OIDE_NPM_REGISTRY = prev;
  while (open.length) {
    const { h, dirs } = open.pop()!;
    await h.close().catch(() => undefined);
    cleanup(h.userData, ...dirs);
  }
});

async function setup() {
  process.env.OIDE_NPM_REGISTRY = 'off';
  const repo = makeRepo();
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ dependencies: { react: '^18.0.0' } }));
  const outside = tempDir('oide-int-deps-outside-');
  writeFileSync(join(outside, 'package.json'), '{}');
  const h = await startHarness({ trust: true });
  open.push({ h, dirs: [repo, outside] });
  h.allowOpen(repo);
  await h.call('projects.open', { path: repo });
  return { h, repo, outside };
}

describe('deps handlers', () => {
  it('validates package names and guards the path', async () => {
    const { h, repo, outside } = await setup();
    expect(await h.fails('deps.latest', { root: repo, path: 'package.json', names: ['Not A Name'] })).toBe('invalid_input');
    expect(await h.fails('deps.latest', { root: repo, path: 'package.json', names: ['../../etc'] })).toBe('invalid_input');
    expect(await h.fails('deps.latest', { root: repo, path: '', names: [] })).toBe('invalid_input');
    expect(await h.fails('deps.latest', { root: outside, path: 'package.json', names: ['react'] })).toBe('forbidden_path');
    expect(await h.fails('deps.latest', { root: repo, path: '../escape/package.json', names: ['react'] })).toBe('forbidden_path');
    expect(await h.fails('deps.latest', { root: repo, path: '.git/package.json', names: ['react'] })).toBe('forbidden_path');
    expect(await h.fails('deps.latest', { root: repo, path: 'README.md', names: ['react'] })).toBe('invalid_input');
  });

  it('answers off without reaching the network when lookups are off', async () => {
    const { h, repo } = await setup();
    expect(await h.call('deps.latest', { root: repo, path: 'package.json', names: ['react', '@types/node'] })).toEqual({ status: 'off', packages: {} });
    await h.call('settings.update', { patch: { editor: { npmVersions: false } } });
    delete process.env.OIDE_NPM_REGISTRY;
    expect(await h.call('deps.latest', { root: repo, path: 'package.json', names: ['react'] })).toEqual({ status: 'off', packages: {} });
  });
});
