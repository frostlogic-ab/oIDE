import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AGENT_SECRET_HEADER, isLoopbackOrigin, McpProxy } from '../src/mcp-proxy.js';

let upstream: Server;
let upstreamUrl = '';
const seen: Array<{ auth?: string; secret?: string; body: string; method?: string }> = [];
const token = 'tok-1';

beforeAll(async () => {
  upstream = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const s: { auth?: string; secret?: string; body: string; method?: string } = { body: Buffer.concat(chunks).toString('utf8') };
      if (req.headers.authorization) s.auth = req.headers.authorization;
      const sec = req.headers[AGENT_SECRET_HEADER];
      if (typeof sec === 'string') s.secret = sec;
      if (req.method) s.method = req.method;
      seen.push(s);
      if (req.headers.authorization !== `Bearer ${token}`) {
        res.writeHead(401).end();
        return;
      }
      if (req.headers.accept?.includes('text/event-stream')) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'mcp-session-id': 'sess-9' });
        res.write('event: message\ndata: {"n":1}\n\n');
        setTimeout(() => res.end('event: message\ndata: {"n":2}\n\n'), 30);
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'sess-9' });
      res.end(JSON.stringify({ echo: s.body }));
    });
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/mcp`;
});
afterAll(() => {
  upstream.closeAllConnections();
  upstream.close();
});

function makeProxy() {
  let refreshes = 0;
  const proxy = new McpProxy({
    resolve: (name) =>
      name === 'wiki'
        ? {
            url: upstreamUrl,
            headers: () => ({ authorization: 'Bearer stale' }),
            refresh: () => {
              refreshes++;
              return true;
            },
          }
        : name === 'metrics'
          ? { url: upstreamUrl, headers: () => ({ authorization: `Bearer ${token}` }) }
          : undefined,
  });
  return { proxy, refreshes: () => refreshes };
}

/** Raw request so tests can set Host and Origin freely. */
function raw(port: number, opts: { path?: string; headers?: Record<string, string>; body?: string; method?: string }): Promise<{ status: number; headers: Record<string, unknown>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: opts.path ?? '/mcp/metrics', method: opts.method ?? 'POST', headers: opts.headers ?? {} }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(opts.body);
  });
}

describe('McpProxy', () => {
  it('requires the per-agent secret and injects the token', async () => {
    const { proxy } = makeProxy();
    const { port } = await proxy.start();
    try {
      const secret = proxy.issueAgentSecret('agent-1');
      expect((await raw(port, { body: '{}' })).status).toBe(401);
      expect((await raw(port, { body: '{}', headers: { [AGENT_SECRET_HEADER]: 'wrong' } })).status).toBe(401);
      seen.length = 0;
      const ok = await raw(port, { body: '{"jsonrpc":"2.0"}', headers: { [AGENT_SECRET_HEADER]: secret, 'content-type': 'application/json', authorization: 'Bearer agent-supplied' } });
      expect(ok.status).toBe(200);
      expect(JSON.parse(ok.body)).toEqual({ echo: '{"jsonrpc":"2.0"}' });
      expect(ok.headers['mcp-session-id']).toBe('sess-9');
      expect(seen[0]?.auth).toBe('Bearer tok-1');
      expect(seen[0]?.secret).toBeUndefined(); // the agent secret never reaches the upstream
      proxy.revokeAgent('agent-1');
      expect((await raw(port, { body: '{}', headers: { [AGENT_SECRET_HEADER]: secret } })).status).toBe(401);
    } finally {
      await proxy.stop();
    }
  });

  it('refuses non-loopback origins and foreign Host headers', async () => {
    const { proxy } = makeProxy();
    const { port } = await proxy.start();
    try {
      const secret = proxy.issueAgentSecret('a');
      const h = { [AGENT_SECRET_HEADER]: secret };
      expect((await raw(port, { headers: { ...h, origin: 'https://evil.example' } })).status).toBe(403);
      expect((await raw(port, { headers: { ...h, host: `evil.example:${port}` } })).status).toBe(403);
      expect((await raw(port, { headers: { ...h, origin: `http://localhost:${port}` }, body: '{}' })).status).toBe(200);
      expect(isLoopbackOrigin('http://127.0.0.1:3000')).toBe(true);
      expect(isLoopbackOrigin('http://127.0.0.1.evil.example')).toBe(false);
      expect(isLoopbackOrigin('null')).toBe(false);
    } finally {
      await proxy.stop();
    }
  });

  it('limits an agent to its servers and 404s unknown ones', async () => {
    const { proxy } = makeProxy();
    const { port } = await proxy.start();
    try {
      const secret = proxy.issueAgentSecret('a', ['wiki']);
      expect((await raw(port, { headers: { [AGENT_SECRET_HEADER]: secret } })).status).toBe(403);
      const all = proxy.issueAgentSecret('b');
      expect((await raw(port, { path: '/mcp/nope', headers: { [AGENT_SECRET_HEADER]: all } })).status).toBe(404);
    } finally {
      await proxy.stop();
    }
  });

  it('refreshes the token once on 401 and retries', async () => {
    const { proxy, refreshes } = makeProxy();
    const { port } = await proxy.start();
    try {
      const secret = proxy.issueAgentSecret('a');
      const r = await raw(port, { path: '/mcp/wiki', body: '{}', headers: { [AGENT_SECRET_HEADER]: secret } });
      // The fake refresh does not change the stale token, so the retry also fails: one refresh, no loop.
      expect(r.status).toBe(401);
      expect(refreshes()).toBe(1);
    } finally {
      await proxy.stop();
    }
  });

  it('streams SSE responses', async () => {
    const { proxy } = makeProxy();
    const { port } = await proxy.start();
    try {
      const secret = proxy.issueAgentSecret('a');
      const r = await raw(port, { method: 'GET', headers: { [AGENT_SECRET_HEADER]: secret, accept: 'text/event-stream' } });
      expect(r.status).toBe(200);
      expect(r.headers['content-type']).toBe('text/event-stream');
      expect(r.body).toContain('{"n":1}');
      expect(r.body).toContain('{"n":2}');
    } finally {
      await proxy.stop();
    }
  });
});
