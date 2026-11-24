import { createServer, type Server } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CustomServer } from '@oide/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CustomTools, mcpJsonEntry, parseCommandLine, parsePastedJson, probeCommand, probeUrl, riskFromAnnotations } from '../src/custom-tools.js';
import { customEnvSecretKey } from '../src/mcp-config.js';
// @ts-expect-error plain JS fixture
import { addTools } from './fixtures/mcp-tools.mjs';
import { memoryCustomRepo, memorySecrets, tempDir } from './helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const stdioFixture = path.join(here, 'fixtures', 'stdio-server.mjs');

describe('riskFromAnnotations', () => {
  it('maps hints to labels', () => {
    expect(riskFromAnnotations({ readOnlyHint: true })).toBe('read');
    expect(riskFromAnnotations({ readOnlyHint: true, destructiveHint: true })).toBe('ask');
    expect(riskFromAnnotations({ destructiveHint: true })).toBe('ask');
    expect(riskFromAnnotations({ readOnlyHint: false })).toBe('ask');
    expect(riskFromAnnotations({})).toBe('ask');
    expect(riskFromAnnotations(undefined)).toBe('ask');
  });
});

describe('probeCommand', () => {
  it('starts a local stdio server, lists its tools with annotations, then stops it', async () => {
    const r = await probeCommand(process.execPath, [stdioFixture]);
    expect(r.error).toBeUndefined();
    expect(r.started).toBe(true);
    expect(r.serverInfo).toBe('Fixture stdio v0.4.1');
    expect(r.tools.map((t) => [t.name, t.risk])).toEqual([
      ['metrics.query', 'read'],
      ['alerts.silence', 'ask'],
      ['annotations.create', 'ask'],
    ]);
    expect(r.tools[0]?.readOnlyHint).toBe(true);
  });

  it('passes env and reports a failing start', async () => {
    const ok = await probeCommand(process.execPath, [stdioFixture], { FIXTURE_REQUIRE: 'API_KEY', API_KEY: 'x' });
    expect(ok.started).toBe(true);
    const bad = await probeCommand(process.execPath, [stdioFixture], { FIXTURE_REQUIRE: 'API_KEY' }, { timeoutMs: 5000 });
    expect(bad.started).toBe(false);
    expect(bad.error).toMatch(/missing API_KEY|closed/i);
  });
});

describe('probeUrl', () => {
  let httpServer: Server;
  let authServer: Server;
  let base = '';
  let authBase = '';

  beforeAll(async () => {
    httpServer = createServer(async (req, res) => {
      if (req.url !== '/mcp') {
        res.writeHead(404).end();
        return;
      }
      const server = new McpServer({ name: 'Metrics API', version: '2.3.0' });
      addTools(server);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
      await transport.handleRequest(req, res, body);
    });
    authServer = createServer((_req, res) => {
      res.writeHead(401, { 'www-authenticate': 'Bearer resource_metadata="http://127.0.0.1/.well-known/oauth-protected-resource"' }).end();
    });
    await new Promise<void>((r) => httpServer.listen(0, '127.0.0.1', r));
    await new Promise<void>((r) => authServer.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
    authBase = `http://127.0.0.1:${(authServer.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    httpServer.closeAllConnections();
    httpServer.close();
    authServer.closeAllConnections();
    authServer.close();
  });

  it('reaches a Streamable HTTP server and reads info and tools', async () => {
    const r = await probeUrl(`${base}/mcp`);
    expect(r).toMatchObject({ reached: true, transport: 'Streamable HTTP', needsAuth: false, serverInfo: 'Metrics API v2.3.0', serverName: 'Metrics API', serverVersion: '2.3.0' });
    expect(r.tools.map((t) => t.risk)).toEqual(['read', 'ask', 'ask']);
  });

  it('detects a 401 as needing sign-in', async () => {
    const r = await probeUrl(`${authBase}/mcp`);
    expect(r.reached).toBe(true);
    expect(r.needsAuth).toBe(true);
  });

  it('reports an unreachable server', async () => {
    const r = await probeUrl('http://127.0.0.1:1/mcp', { timeoutMs: 3000 });
    expect(r.reached).toBe(false);
    expect(r.error).toBeTruthy();
    expect((await probeUrl('file:///etc/passwd')).reached).toBe(false);
  });
});

describe('command and JSON parsing', () => {
  it('splits a command line', () => {
    expect(parseCommandLine('npx -y "@example/search mcp" --root .')).toEqual({ command: 'npx', args: ['-y', '@example/search mcp', '--root', '.'] });
  });
  it('reads pasted mcpServers JSON', () => {
    const r = parsePastedJson('{ "mcpServers": { "local-search": { "command": "npx", "args": ["-y", "@example/search-mcp"], "env": { "SEARCH_API_KEY": "s3cret" } } } }');
    expect(r).toEqual([{ name: 'local-search', config: { kind: 'stdio', command: 'npx', args: ['-y', '@example/search-mcp'], env: { SEARCH_API_KEY: 's3cret' } } }]);
    expect(() => parsePastedJson('{"x": 1}')).toThrow();
  });
});

describe('CustomTools.save', () => {
  it('stores secrets in the keychain and writes .mcp.json with ${VAR} placeholders only', async () => {
    const t = tempDir();
    try {
      writeFileSync(path.join(t.dir, '.mcp.json'), JSON.stringify({ mcpServers: { keep: { command: 'x' } }, other: true }));
      const repo = memoryCustomRepo();
      const secrets = memorySecrets();
      const tools = new CustomTools({ repo, secrets, openExternal: () => undefined, project: (id) => (id === 'p1' ? { id, name: 'billing-api', root: t.dir, trusted: true } : undefined) });
      const server = CustomServer.parse({
        id: 's1',
        name: 'local-search',
        route: 'command',
        transport: { kind: 'stdio', command: 'npx', args: ['-y', '@example/search-mcp'] },
        tools: [{ name: 'search', risk: 'read' }],
        projects: ['p1'],
        savedTo: 'project-mcp-json',
      });
      const saved = await tools.save(server, { SEARCH_API_KEY: 's3cret' });
      expect(saved.transport.kind === 'stdio' && saved.transport.envKeys).toEqual(['SEARCH_API_KEY']);
      expect(secrets.data.get(customEnvSecretKey('s1', 'SEARCH_API_KEY'))).toBe('s3cret');
      const text = readFileSync(path.join(t.dir, '.mcp.json'), 'utf8');
      expect(text).not.toContain('s3cret');
      const doc = JSON.parse(text);
      expect(doc.other).toBe(true);
      expect(doc.mcpServers.keep).toEqual({ command: 'x' });
      expect(doc.mcpServers['local-search']).toEqual({ command: 'npx', args: ['-y', '@example/search-mcp'], env: { SEARCH_API_KEY: '${SEARCH_API_KEY}' } });
      expect(JSON.stringify([...repo.items.values()])).not.toContain('s3cret');

      await tools.remove('s1');
      expect(JSON.parse(readFileSync(path.join(t.dir, '.mcp.json'), 'utf8')).mcpServers['local-search']).toBeUndefined();
      expect(secrets.data.size).toBe(0);
    } finally {
      t.cleanup();
    }
  });

  it('writes remote servers in the standard http format', () => {
    const s = CustomServer.parse({ id: 'r', name: 'wiki', route: 'url', transport: { kind: 'http', url: 'https://wiki.example/mcp', auth: 'header' }, savedTo: 'project-mcp-json' });
    expect(mcpJsonEntry(s)).toEqual({ type: 'http', url: 'https://wiki.example/mcp', headers: { Authorization: '${WIKI_TOKEN}' } });
  });
});
