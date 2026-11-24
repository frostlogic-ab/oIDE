import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { loadManifest, mcpToolName, probeCommand, requireBundled } from '@oide/extension-host';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CommandHandler, ExtensionContext } from '@oide/extension-api';
import { activate } from '../dist/host.js';
import { checkLocalUrl, titleOf } from '../dist/preview.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mcp = path.join(root, 'dist', 'mcp.js');

let site: Server;
let base = '';
beforeAll(async () => {
  site = createServer((req, res) => {
    if (req.url === '/moved') {
      res.writeHead(302, { location: '/' }).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html><head><title>  My &amp; App </title></head><body>hi</body></html>');
  });
  await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
});
afterAll(() => {
  site.closeAllConnections();
  site.close();
});

describe('browser-preview extension', () => {
  it('has a valid manifest with one read-only tool and a panel', () => {
    const l = loadManifest(root);
    expect(requireBundled(l)).toEqual([]);
    expect(l.tools).toEqual([{ server: 'browser-preview', tool: 'preview_url', risk: 'read', description: expect.any(String) }]);
    expect(mcpToolName('browser-preview', 'preview_url')).toBe('mcp__browser-preview__preview_url');
    expect(l.panels.map((p) => p.id)).toEqual(['browserPreview.panel']);
    expect(l.mcpServers['browser-preview']?.args).toEqual([mcp]);
  });

  it('its MCP server lists preview_url with readOnlyHint', async () => {
    const r = await probeCommand(process.execPath, [mcp]);
    expect(r.error).toBeUndefined();
    expect(r.tools).toEqual([expect.objectContaining({ name: 'preview_url', readOnlyHint: true, risk: 'read' })]);
  });

  it('preview_url reports status and title of a localhost page, and refuses other hosts', async () => {
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [mcp] }));
    try {
      const ok = await client.callTool({ name: 'preview_url', arguments: { url: `${base}/` } });
      expect(ok.isError).toBeFalsy();
      expect(ok.structuredContent).toMatchObject({ status: 200, title: 'My & App' });
      const moved = await client.callTool({ name: 'preview_url', arguments: { url: `${base}/moved` } });
      expect(moved.structuredContent).toMatchObject({ status: 302, redirectedTo: `${base}/` });
      const remote = await client.callTool({ name: 'preview_url', arguments: { url: 'https://example.com/' } });
      expect(remote.isError).toBe(true);
    } finally {
      await client.close();
    }
  });

  it('only accepts loopback URLs', () => {
    expect(checkLocalUrl('http://localhost:3000').hostname).toBe('localhost');
    expect(() => checkLocalUrl('http://169.254.169.254/')).toThrow();
    expect(() => checkLocalUrl('file:///etc/passwd')).toThrow();
    expect(() => checkLocalUrl('http://user:pw@localhost/')).toThrow();
    expect(titleOf('<title>a\n b</title>')).toBe('a b');
  });
});

describe('browser-preview host code (panel bridge)', () => {
  function fakeCtx(saved?: string) {
    const commands = new Map<string, CommandHandler>();
    const listeners: Array<(d: unknown) => void> = [];
    const posted: unknown[] = [];
    const opened: unknown[] = [];
    const ctx = {
      subscriptions: [],
      log: { debug() {}, info() {}, warn() {}, error() {} },
      commands: { register: (id: string, fn: CommandHandler) => (commands.set(id, fn), { dispose() {} }) },
      settings: { get: async () => saved, set: async () => {} },
      panels: {
        open: async (id: string, o?: unknown) => void opened.push([id, o]),
        postMessage: async (id: string, d: unknown) => void posted.push([id, d]),
        onMessage: (_id: string, l: (d: unknown) => void) => (listeners.push(l), { dispose() {} }),
      },
    } as unknown as ExtensionContext;
    activate(ctx);
    return { commands, listeners, posted, opened };
  }

  it('answers a panel that says ready with the saved default URL (no navigation)', async () => {
    const f = fakeCtx('http://localhost:5173/');
    f.listeners[0]!({ type: 'ready' });
    await new Promise((r) => setTimeout(r, 0));
    expect(f.posted).toEqual([['browserPreview.panel', { type: 'init', url: 'http://localhost:5173/' }]]);
  });

  it('"Open browser preview" opens the panel for the agent and navigates it', async () => {
    const f = fakeCtx();
    expect(await f.commands.get('browserPreview.open')!({ agentId: 'a1' })).toEqual({ url: 'http://localhost:3000' });
    expect(f.opened).toEqual([['browserPreview.panel', { agentId: 'a1' }]]);
    expect(f.posted).toEqual([['browserPreview.panel', { type: 'navigate', url: 'http://localhost:3000' }]]);
  });
});
