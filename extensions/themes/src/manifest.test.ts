import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadManifest, requireBundled } from '@oide/extension-host';
import { describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('themes extension', () => {
  it('has a valid manifest with the four accent themes', () => {
    const l = loadManifest(root);
    expect(requireBundled(l)).toEqual([]);
    expect(l.manifest.oide.contributes.themes.map((t) => [t.label, t.tokens['accent']])).toEqual([
      ['Blue', '#7AA2F7'],
      ['Green', '#7FC8A9'],
      ['Violet', '#C4A7E7'],
      ['Amber', '#F2C078'],
    ]);
  });

  it('is pure manifest: themes are applied by the renderer (Settings › Appearance), no host code runs', () => {
    const l = loadManifest(root);
    expect(l.main).toBeUndefined();
    expect(l.manifest.oide.contributes.commands).toEqual([]);
    for (const t of l.manifest.oide.contributes.themes) for (const v of Object.values(t.tokens)) expect(v).toMatch(/^#[0-9A-F]{6}$/i);
  });
});
