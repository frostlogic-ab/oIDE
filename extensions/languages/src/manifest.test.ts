import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadManifest, requireBundled } from '@oide/extension-host';
import { describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('languages extension', () => {
  it('has a valid manifest with one language server per language', () => {
    const l = loadManifest(root);
    expect(requireBundled(l)).toEqual([]);
    expect(l.languages.map((x) => x.id)).toEqual(['typescript', 'python', 'rust', 'go', 'cpp', 'css', 'html', 'json', 'yaml', 'shellscript']);
    expect(l.languages.find((x) => x.id === 'typescript')).toMatchObject({ command: 'typescript-language-server', args: ['--stdio'], name: 'TypeScript language server' });
  });

  it('is pure manifest: servers are commands on PATH that main starts, with an install hint each', () => {
    const l = loadManifest(root);
    expect(l.main).toBeUndefined();
    const exts = new Set<string>();
    for (const lang of l.languages) {
      // A bare executable name (looked up on PATH), never a path or a shell line.
      expect(lang.command).toMatch(/^[a-z][a-z0-9-]*$/);
      for (const a of lang.args) expect(a).toMatch(/^[\w-]+$/);
      expect(lang.install).toBeTruthy();
      for (const e of lang.extensions) {
        expect(e).toMatch(/^\.[a-z]+$/);
        expect(exts.has(e)).toBe(false);
        exts.add(e);
      }
    }
  });
});
