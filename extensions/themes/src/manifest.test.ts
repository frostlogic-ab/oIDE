import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CommandHandler, ExtensionContext } from '@oide/extension-api';
import { loadManifest, requireBundled } from '@oide/extension-host';
import { describe, expect, it } from 'vitest';
import { activate, nextAccent } from '../dist/host.js';

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

  it('cycles the accent setting', async () => {
    expect(nextAccent('blue')).toBe('green');
    expect(nextAccent('amber')).toBe('blue');
    expect(nextAccent(undefined)).toBe('blue');
    const settings = new Map<string, unknown>([['themes.accent', 'violet']]);
    const commands = new Map<string, CommandHandler>();
    const ctx = {
      subscriptions: [],
      commands: { register: (id: string, fn: CommandHandler) => (commands.set(id, fn), { dispose() {} }) },
      settings: { get: async (k: string) => settings.get(k), set: async (k: string, v: unknown) => void settings.set(k, v) },
    } as unknown as ExtensionContext;
    activate(ctx);
    expect(await commands.get('themes.nextAccent')?.()).toEqual({ accent: 'amber' });
    expect(settings.get('themes.accent')).toBe('amber');
  });
});
