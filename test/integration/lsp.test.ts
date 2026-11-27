import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { REPO, cleanup, makeRepo, startHarness, tempDir, waitFor, type Harness } from './harness.js';

/**
 * lsp.* (apps/desktop/src/main/handlers/lsp.ts) through the real IPC router and core services:
 * Zod validation, the path guard on every root and document, the trust gate, and one language
 * server run end to end. The server is the fixture (`services/lsp/fixtures/fake-lsp.mjs`),
 * contributed by a test built-in extension for `.fk` files and run with `node` from PATH, so the
 * test never depends on which real servers the machine has. The real Languages extension is
 * loaded too and only asked for its status (which never starts a server).
 */

const FIXTURE = join(REPO, 'apps', 'desktop', 'src', 'main', 'services', 'lsp', 'fixtures', 'fake-lsp.mjs');
const TEXT = 'export function main() {\n  ERR here\n}\n';

const open: Array<{ h: Harness; dirs: string[] }> = [];
afterEach(async () => {
  while (open.length) {
    const { h, dirs } = open.pop()!;
    await h.close().catch(() => undefined);
    cleanup(h.userData, ...dirs);
  }
});

/** A built-ins folder with one extension whose language server is the fixture. */
function fakeBuiltins(): string {
  const dir = tempDir('oide-int-lsp-builtins-');
  const ext = join(dir, 'fake-lsp');
  mkdirSync(ext);
  copyFileSync(FIXTURE, join(ext, 'fake-lsp.mjs'));
  const manifest = {
    name: '@oide-test/fake-lsp',
    version: '1.0.0',
    private: true,
    type: 'module',
    oide: {
      engine: '^1.0.0',
      displayName: 'Fake languages',
      publisher: 'oide-test',
      categories: ['languages'],
      activation: [],
      capabilities: { spawn: true },
      contributes: { languages: [{ id: 'fake', name: 'Fake LSP', extensions: ['.fk'], command: 'node', args: ['./fake-lsp.mjs'], install: 'npm install -g fake-lsp' }] },
    },
  };
  writeFileSync(join(ext, 'package.json'), JSON.stringify(manifest, null, 2));
  // The same server for `.nospawn` files, from an extension that does not declare `capabilities.spawn`.
  const quiet = join(dir, 'no-spawn');
  mkdirSync(quiet);
  copyFileSync(FIXTURE, join(quiet, 'fake-lsp.mjs'));
  const languages = [{ ...manifest.oide.contributes.languages[0]!, id: 'nospawn', extensions: ['.nospawn'] }];
  const { capabilities: _omit, ...rest } = manifest.oide;
  writeFileSync(join(quiet, 'package.json'), JSON.stringify({ ...manifest, name: '@oide-test/no-spawn', oide: { ...rest, displayName: 'No spawn', contributes: { languages } } }, null, 2));
  return dir;
}

async function setup(opts: { trust?: boolean } = {}) {
  const repo = makeRepo();
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(repo, 'src', 'b.fk'), TEXT);
  const outside = tempDir('oide-int-lsp-outside-');
  writeFileSync(join(outside, 'c.fk'), TEXT);
  const builtins = fakeBuiltins();
  const h = await startHarness({ trust: opts.trust ?? true, platform: { builtinExtensionDirs: [join(REPO, 'extensions'), builtins] } });
  open.push({ h, dirs: [repo, outside, builtins] });
  h.allowOpen(repo);
  const project = (await h.call('projects.open', { path: repo }))!;
  return { h, repo, outside, project };
}

describe('lsp handlers', () => {
  it('validates input', async () => {
    const { h, repo } = await setup();
    const bad = async (command: string, input: unknown) => h.fails(command as 'lsp.open', input as never);
    expect(await bad('lsp.open', { root: repo, path: 'src/b.fk', version: 1 })).toBe('invalid_input');
    expect(await bad('lsp.open', { root: repo, path: 'src/b.fk', version: -1, text: '' })).toBe('invalid_input');
    expect(await bad('lsp.open', { root: repo, path: '', version: 1, text: '' })).toBe('invalid_input');
    expect(await bad('lsp.change', { root: repo, path: 'src/b.fk', version: 1.5, text: '' })).toBe('invalid_input');
    expect(await bad('lsp.hover', { root: repo, path: 'src/b.fk' })).toBe('invalid_input');
    expect(await bad('lsp.hover', { root: repo, path: 'src/b.fk', position: { line: -1, character: 0 } })).toBe('invalid_input');
    expect(await bad('lsp.completion', { root: repo, path: 'src/b.fk', position: { line: 0, character: 0 }, triggerCharacter: 'toolong' })).toBe('invalid_input');
    expect(await bad('lsp.resolveCompletion', { root: repo, path: 'src/b.fk', resultId: 1, index: -1 })).toBe('invalid_input');
    expect(await bad('lsp.format', { root: repo, path: 'src/b.fk', tabSize: 0 })).toBe('invalid_input');
    expect(await bad('lsp.status', { root: '', path: 'src/b.fk' })).toBe('invalid_input');
  });

  it('refuses roots outside known checkouts, artifact folders, paths leaving the checkout and .git', async () => {
    const { h, repo, outside } = await setup();
    const doc = { version: 1, text: TEXT };
    expect(await h.fails('lsp.open', { root: outside, path: 'c.fk', ...doc })).toBe('forbidden_path');
    expect(await h.fails('lsp.open', { root: join(repo, '..'), path: 'x.fk', ...doc })).toBe('forbidden_path');
    expect(await h.fails('lsp.open', { root: repo, path: '../escape.fk', ...doc })).toBe('forbidden_path');
    expect(await h.fails('lsp.open', { root: repo, path: join(outside, 'c.fk'), ...doc })).toBe('forbidden_path');
    expect(await h.fails('lsp.open', { root: repo, path: '.git/config', ...doc })).toBe('forbidden_path');
    expect(await h.fails('lsp.status', { root: repo, path: 'src/../.git/HEAD' })).toBe('forbidden_path');
    expect(await h.fails('lsp.hover', { root: repo, path: '.git/x.fk', position: { line: 0, character: 0 } })).toBe('forbidden_path');
    expect(await h.fails('lsp.status', { root: repo, path: '.' })).toBe('forbidden_path');
    const artifactRoots = h.ctx.roots.list('artifact');
    expect(artifactRoots.length).toBeGreaterThan(0);
    for (const root of artifactRoots) {
      mkdirSync(root, { recursive: true });
      expect(await h.fails('lsp.open', { root, path: 'x.fk', ...doc })).toBe('forbidden_path');
    }
    expect(h.services.lsp.list()).toEqual([]);
  });

  it("reports the built-in Languages extension's server without starting it", async () => {
    const { h, repo } = await setup();
    expect(await h.call('lsp.status', { root: repo, path: 'src/a.ts' })).toEqual({ state: 'none', language: 'typescript', server: 'TypeScript language server', extension: 'Languages' });
    expect(await h.call('lsp.status', { root: repo, path: 'notes.txt' })).toEqual({ state: 'none' });
    expect(h.services.lsp.list()).toEqual([]);
  });

  it('runs a server for a trusted project: diagnostics, hover, definition, completion, then trust revoked', async () => {
    const { h, repo, project } = await setup();
    const doc = { root: repo, path: 'src/b.fk' };
    const st = await h.call('lsp.open', { ...doc, version: 1, text: TEXT });
    expect(st).toMatchObject({ language: 'fake', server: 'Fake LSP', extension: 'Fake languages' });
    expect(['starting', 'running']).toContain(st.state);
    await waitFor(() => h.eventsOf('lsp.state').some((e) => e.state === 'running' && e.language === 'fake'), 'server running');
    const diag = await waitFor(() => h.eventsOf('lsp.diagnostics').find((e) => e.path === 'src/b.fk'), 'diagnostics');
    expect(diag).toMatchObject({ root: repo, version: 1, diagnostics: [{ severity: 1, message: 'ERR on line 2', range: { start: { line: 1, character: 2 } } }] });

    const at = { line: 1, character: 3 };
    expect(await h.call('lsp.hover', { ...doc, position: at })).toMatchObject({ contents: '**ERR**' });
    // The fixture also answers a location in the OS temp folder: dropped by the path guard.
    expect(await h.call('lsp.definition', { ...doc, position: at })).toEqual([{ root: repo, path: 'src/b.fk', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } } }]);
    expect(await h.call('lsp.typeDefinition', { ...doc, position: at })).toEqual([]); // no capability
    expect(await h.call('lsp.references', { ...doc, position: at })).toHaveLength(1);
    expect((await h.call('lsp.symbols', doc)).map((s) => s.name)).toEqual(['main']);
    expect(await h.call('lsp.signatureHelp', { ...doc, position: at })).toMatchObject({ activeParameter: 1 });
    expect(await h.call('lsp.format', { ...doc, tabSize: 2, insertSpaces: true })).toHaveLength(1);
    const list = (await h.call('lsp.completion', { ...doc, position: at, triggerCharacter: '.' }))!;
    expect(list.items.map((i) => i.label)).toEqual(['alpha', 'beta']);
    expect(await h.call('lsp.resolveCompletion', { ...doc, resultId: list.resultId, index: 0 })).toMatchObject({ documentation: 'Docs for `alpha`' });

    // A change, a save through files.write (didSave) and the cleared diagnostics.
    await h.call('lsp.change', { ...doc, version: 2, text: 'fine\n' });
    const v2 = () => h.eventsOf('lsp.diagnostics').filter((e) => e.path === 'src/b.fk' && e.version === 2 && e.diagnostics.length === 0);
    await waitFor(() => v2().length === 1, 'cleared diagnostics');
    await h.call('files.write', { ...doc, content: 'fine\n' });
    await waitFor(() => v2().length === 2, 'diagnostics after didSave');
    expect(h.emitErrors).toEqual([]);

    // Trust revoked: the server stops and the document reports untrusted.
    await h.call('projects.trust', { projectId: project.id, trusted: false });
    await waitFor(() => h.eventsOf('lsp.state').some((e) => e.state === 'untrusted'), 'untrusted state');
    expect(h.services.lsp.list()).toEqual([]);
    expect(await h.call('lsp.open', { ...doc, version: 3, text: TEXT })).toMatchObject({ state: 'untrusted' });
    expect(await h.call('lsp.hover', { ...doc, position: at })).toBeNull();
    await h.call('lsp.close', doc);
    expect(h.emitErrors).toEqual([]);
  });

  it('ignores languages of an extension that does not declare capabilities.spawn', async () => {
    const { h, repo } = await setup();
    expect(await h.call('lsp.open', { root: repo, path: 'src/x.nospawn', version: 1, text: TEXT })).toEqual({ state: 'none' });
    expect(h.services.lsp.list()).toEqual([]);
  });

  it('an untrusted project never starts a server', async () => {
    const { h, repo, project } = await setup({ trust: false });
    expect(project.trusted).toBe(false);
    expect(await h.call('lsp.open', { root: repo, path: 'src/b.fk', version: 1, text: TEXT })).toEqual({ state: 'untrusted', language: 'fake', server: 'Fake LSP', extension: 'Fake languages' });
    expect(await h.call('lsp.status', { root: repo, path: 'src/a.ts' })).toMatchObject({ state: 'untrusted', language: 'typescript' });
    expect(h.services.lsp.list()).toEqual([]);
    expect(h.eventsOf('lsp.state')).toEqual([]);
  });
});
