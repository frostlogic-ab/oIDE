import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, makeRepo, startHarness, tempDir, type Harness } from './harness.js';

/**
 * files.create / files.rename / files.copy / files.delete (apps/desktop/src/main/handlers/files.ts)
 * through the real IPC router: the path guard on both ends, refusing existing targets, " copy"
 * names, moves across checkouts, and acting on a symlink itself rather than its target.
 */

const open: Array<{ h: Harness; dirs: string[] }> = [];
afterEach(async () => {
  while (open.length) {
    const { h, dirs } = open.pop()!;
    await h.close().catch(() => undefined);
    cleanup(h.userData, ...dirs);
  }
});

async function setup() {
  const repo = makeRepo();
  const other = makeRepo();
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
  const outside = tempDir('oide-int-outside-');
  writeFileSync(join(outside, 'secret.txt'), 'x\n');
  const h = await startHarness();
  open.push({ h, dirs: [repo, other, outside] });
  h.allowOpen(repo);
  h.allowOpen(other);
  await h.call('projects.open', { path: repo });
  await h.call('projects.open', { path: other });
  return { h, repo, other, outside };
}

describe('files tree management', () => {
  it('creates files and folders (with missing parents) and refuses an existing name', async () => {
    const { h, repo } = await setup();
    await h.call('files.create', { root: repo, path: 'src/new.ts', kind: 'file' });
    expect(readFileSync(join(repo, 'src', 'new.ts'), 'utf8')).toBe('');
    await h.call('files.create', { root: repo, path: 'lib/deep/x.ts', kind: 'file' });
    expect(existsSync(join(repo, 'lib', 'deep', 'x.ts'))).toBe(true);
    await h.call('files.create', { root: repo, path: 'empty', kind: 'dir' });
    expect((await h.call('files.tree', { root: repo, dir: '' })).find((n) => n.name === 'empty')?.kind).toBe('dir');
    expect(await h.fails('files.create', { root: repo, path: 'src/a.ts', kind: 'file' })).toBe('conflict');
    expect(readFileSync(join(repo, 'src', 'a.ts'), 'utf8')).toBe('export const a = 1;\n');
  });

  it('refuses paths outside the checkout, .git, and unknown roots', async () => {
    const { h, repo, outside } = await setup();
    expect(await h.fails('files.create', { root: repo, path: '../escape.ts', kind: 'file' })).not.toBe('ok');
    expect(existsSync(join(repo, '..', 'escape.ts'))).toBe(false);
    expect(await h.fails('files.create', { root: repo, path: '.git/hooks/pre-commit', kind: 'file' })).toBe('forbidden_path');
    expect(await h.fails('files.delete', { root: repo, path: '.git' })).toBe('forbidden_path');
    expect(await h.fails('files.create', { root: outside, path: 'x.ts', kind: 'file' })).toBe('forbidden_path');
    expect(await h.fails('files.copy', { fromRoot: outside, from: 'secret.txt', toRoot: repo, toDir: '' })).toBe('forbidden_path');
    expect(await h.fails('files.copy', { fromRoot: repo, from: 'src/a.ts', toRoot: outside, toDir: '' })).toBe('forbidden_path');
    expect(await h.fails('files.rename', { root: repo, from: 'src/a.ts', to: '../../a.ts' })).not.toBe('ok');
    expect(existsSync(join(repo, 'src', 'a.ts'))).toBe(true);
  });

  it('renames (also into a new folder) and refuses a taken name or moving a folder into itself', async () => {
    const { h, repo } = await setup();
    await h.call('files.rename', { root: repo, from: 'src/a.ts', to: 'src/b.ts' });
    expect(existsSync(join(repo, 'src', 'b.ts'))).toBe(true);
    await h.call('files.rename', { root: repo, from: 'src/b.ts', to: 'src/util/b.ts' });
    expect(existsSync(join(repo, 'src', 'util', 'b.ts'))).toBe(true);
    writeFileSync(join(repo, 'src', 'c.ts'), '');
    expect(await h.fails('files.rename', { root: repo, from: 'src/c.ts', to: 'src/util/b.ts' })).toBe('conflict');
    expect(await h.fails('files.rename', { root: repo, from: 'src', to: 'src/inner/src' })).toBe('invalid_input');
    expect(await h.fails('files.rename', { root: repo, from: 'nope.ts', to: 'x.ts' })).toBe('not_found');
  });

  it('copy names a duplicate " copy", " copy 2"; move refuses a taken name and works across checkouts', async () => {
    const { h, repo, other } = await setup();
    expect(await h.call('files.copy', { fromRoot: repo, from: 'src/a.ts', toRoot: repo, toDir: 'src' })).toEqual({ path: 'src/a copy.ts' });
    expect(await h.call('files.copy', { fromRoot: repo, from: 'src/a.ts', toRoot: repo, toDir: 'src' })).toEqual({ path: 'src/a copy 2.ts' });
    expect(await h.call('files.copy', { fromRoot: repo, from: 'src', toRoot: repo, toDir: '' })).toEqual({ path: 'src copy' });
    expect(existsSync(join(repo, 'src copy', 'a copy.ts'))).toBe(true);
    expect(await h.fails('files.copy', { fromRoot: repo, from: 'src', toRoot: repo, toDir: 'src' })).toBe('invalid_input');

    expect(await h.fails('files.copy', { fromRoot: repo, from: 'src/a.ts', toRoot: repo, toDir: 'src copy', move: true })).toBe('conflict');
    expect(await h.call('files.copy', { fromRoot: repo, from: 'src/a.ts', toRoot: repo, toDir: 'src', move: true })).toEqual({ path: 'src/a.ts' });
    expect(await h.call('files.copy', { fromRoot: repo, from: 'src/a.ts', toRoot: other, toDir: '', move: true })).toEqual({ path: 'a.ts' });
    expect(existsSync(join(repo, 'src', 'a.ts'))).toBe(false);
    expect(readFileSync(join(other, 'a.ts'), 'utf8')).toBe('export const a = 1;\n');
  });

  it('deletes files and folders (plain-Node tests delete; the app moves them to the trash)', async () => {
    const { h, repo } = await setup();
    await h.call('files.delete', { root: repo, path: 'src/a.ts' });
    expect(existsSync(join(repo, 'src', 'a.ts'))).toBe(false);
    await h.call('files.delete', { root: repo, path: 'src' });
    expect(existsSync(join(repo, 'src'))).toBe(false);
    expect(await h.fails('files.delete', { root: repo, path: 'src' })).toBe('not_found');
    expect(await h.fails('files.delete', { root: repo, path: '' })).not.toBe('ok');
    expect(existsSync(repo)).toBe(true);
  });

  it('acts on a symlink itself, never on what it points to', async () => {
    const { h, repo } = await setup();
    try {
      symlinkSync(join(repo, 'src'), join(repo, 'link'), 'junction');
    } catch {
      return; // no symlink rights on this machine
    }
    await h.call('files.rename', { root: repo, from: 'link', to: 'link2' });
    expect(existsSync(join(repo, 'src', 'a.ts'))).toBe(true);
    await h.call('files.delete', { root: repo, path: 'link2' });
    expect(existsSync(join(repo, 'link2'))).toBe(false);
    expect(existsSync(join(repo, 'src', 'a.ts'))).toBe(true);
  });
});
