import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeIntegrity } from '@oide/extension-host';
import { MarketplaceIndex } from '@oide/protocol';
import { describe, expect, it } from 'vitest';
import { checkTarball, entryFromLoaded, validateAll, validateIndex } from '../lib.mjs';
import { extensionTarball } from '../../../packages/extension-host/test/helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const bundledFile = path.join(here, '..', 'bundled', 'index.json');

const pkg = {
  name: '@someone/tool',
  version: '0.3.0',
  type: 'module',
  oide: {
    engine: '^1.0.0',
    displayName: 'Tool',
    categories: ['agent-tools'],
    mcpServers: { tool: { command: 'node', args: ['dist/mcp.js'], tools: { 'tool.read': { risk: 'read' }, 'tool.write': { risk: 'ask' } } } },
  },
};
const tgz = extensionTarball(pkg, { 'dist/mcp.js': '' });
const entry = (over: Record<string, unknown> = {}, vOver: Record<string, unknown> = {}) => ({
  name: '@someone/tool',
  displayName: 'Tool',
  publisher: 'someone',
  description: 'A tool',
  categories: ['agent-tools'],
  verified: false,
  source: 'npm',
  versions: [
    {
      version: '0.3.0',
      tarball: 'https://registry.npmjs.org/@someone/tool/-/tool-0.3.0.tgz',
      integrity: computeIntegrity(tgz),
      engine: '^1.0.0',
      tools: [
        { name: 'tool.read', risk: 'read' },
        { name: 'tool.write', risk: 'ask' },
      ],
      capabilities: { network: [], spawn: false },
      ...vOver,
    },
  ],
  ...over,
});
const index = (...extensions: unknown[]) => ({ version: 1, generatedAt: '2026-11-24T00:00:00Z', extensions });

describe('marketplace index validation', () => {
  it('accepts a good index and checks the tarball', async () => {
    expect(validateIndex(index(entry())).errors).toEqual([]);
    const fetch = (async () => new Response(tgz)) as typeof globalThis.fetch;
    expect(await validateAll(index(entry()), { fetch })).toEqual([]);
  });

  it('rejects schema errors, duplicates, unknown categories and bad versions', () => {
    expect(validateIndex({ version: 2, extensions: [] }).errors.length).toBeGreaterThan(0);
    expect(validateIndex(index(entry(), entry())).errors).toContain('@someone/tool: listed twice');
    expect(validateIndex(index(entry({ categories: ['games'] }))).errors).toContain('@someone/tool: unknown category games');
    expect(validateIndex(index(entry({}, { version: 'latest' }))).errors[0]).toMatch(/semver/);
    expect(validateIndex(index(entry({}, { tarball: 'http://insecure.example/x.tgz' }))).errors[0]).toMatch(/https/);
  });

  it('fails a tarball whose hash does not match', async () => {
    const e = MarketplaceIndex.parse(index(entry({}, { integrity: computeIntegrity(Buffer.from('other')) }))).extensions[0]!;
    expect(await checkTarball(e, e.versions[0]!, tgz)).toEqual(['@someone/tool@0.3.0: tarball does not match its integrity hash']);
  });

  it('fails when the index hides a tool or lowers its risk', async () => {
    const hidden = MarketplaceIndex.parse(index(entry({}, { tools: [{ name: 'tool.read', risk: 'read' }] }))).extensions[0]!;
    expect((await checkTarball(hidden, hidden.versions[0]!, tgz)).join()).toMatch(/tool.write is not listed/);
    const lowered = MarketplaceIndex.parse(
      index(entry({}, { tools: [{ name: 'tool.read', risk: 'read' }, { name: 'tool.write', risk: 'read' }] })),
    ).extensions[0]!;
    expect((await checkTarball(lowered, lowered.versions[0]!, tgz)).join()).toMatch(/tool.write is ask in the manifest, read in the index/);
  });

  it('the bundled index only lists the built-in extensions, verified', () => {
    const json = JSON.parse(readFileSync(bundledFile, 'utf8'));
    const { index: idx, errors } = validateIndex(json);
    expect(errors).toEqual([]);
    expect(idx!.extensions.map((e: { name: string }) => e.name)).toEqual(['@oide/ext-browser-preview', '@oide/ext-git', '@oide/ext-themes']);
    expect(idx!.extensions.every((e: { source: string; verified: boolean }) => e.source === 'builtin' && e.verified)).toBe(true);
    expect(typeof entryFromLoaded).toBe('function');
  });
});
