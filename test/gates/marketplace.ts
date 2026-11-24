import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { computeIntegrity } from '../../packages/extension-host/src/integrity.js';
import { DEFAULT_INDEX_URL } from '../../packages/extension-host/src/installer.js';
import { extensionTarball } from '../../packages/extension-host/test/helpers.js';
import type { MarketplaceIndex } from '../../packages/protocol/src/index.js';

/**
 * A third-party extension published to a local marketplace: an npm-style tarball of
 * `@acme/oide-textkit` (one stdio MCP server `textkit` with the tool `text.reverse`, risk `read`)
 * and an index whose entry carries the tarball's real sha512 integrity. `fetch` serves both, so the
 * real MarketplaceInstaller downloads, verifies and unpacks it (Platform.fetch).
 */

export const TEXTKIT = {
  name: '@acme/oide-textkit',
  version: '1.0.0',
  server: 'textkit',
  tool: 'text.reverse',
  /** The CLI's name for it: characters outside [A-Za-z0-9_-] become `_`. */
  cliTool: 'mcp__textkit__text_reverse',
  tarballUrl: 'https://registry.npmjs.invalid/@acme/oide-textkit/-/oide-textkit-1.0.0.tgz',
} as const;

const SERVER_JS = readFileSync(
  fileURLToPath(new URL('./fixtures/ext-textkit/server.mjs', import.meta.url)),
  'utf8',
);

export function textkitTarball(): Buffer {
  return extensionTarball(
    {
      name: TEXTKIT.name,
      version: TEXTKIT.version,
      description: 'Text tools for agents',
      type: 'module',
      oide: {
        engine: '^1.0.0',
        displayName: 'Textkit',
        publisher: 'acme',
        categories: ['agent-tools'],
        mcpServers: {
          [TEXTKIT.server]: {
            command: 'node',
            args: ['dist/server.mjs'],
            tools: { [TEXTKIT.tool]: { risk: 'read', description: 'Reverse a string' } },
          },
        },
        capabilities: { spawn: true },
      },
    },
    { 'dist/server.mjs': SERVER_JS },
  );
}

export interface LocalMarketplace {
  index: MarketplaceIndex;
  tarball: Buffer;
  /** Requests the installer made (URLs). */
  requests: string[];
  fetch: typeof fetch;
}

export function localMarketplace(opts: { tamper?: boolean } = {}): LocalMarketplace {
  const tarball = textkitTarball();
  const index: MarketplaceIndex = {
    version: 1,
    generatedAt: '2026-11-24T00:00:00.000Z',
    extensions: [
      {
        name: TEXTKIT.name,
        displayName: 'Textkit',
        publisher: 'acme',
        description: 'Text tools for agents',
        categories: ['agent-tools'],
        verified: false,
        source: 'npm',
        downloads: 12,
        versions: [
          {
            version: TEXTKIT.version,
            tarball: TEXTKIT.tarballUrl,
            integrity: computeIntegrity(tarball, 'sha512'),
            engine: '^1.0.0',
            tools: [{ name: TEXTKIT.tool, risk: 'read', description: 'Reverse a string' }],
            capabilities: { network: [], spawn: true },
          },
        ],
      },
    ],
  };
  const served = opts.tamper ? Buffer.concat([tarball, Buffer.from([0])]) : tarball;
  const requests: string[] = [];
  const fetchFn = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    requests.push(url);
    if (url === DEFAULT_INDEX_URL)
      return new Response(JSON.stringify(index), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    if (url === TEXTKIT.tarballUrl)
      return new Response(new Uint8Array(served), {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
      });
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  return { index, tarball, requests, fetch: fetchFn };
}
