import { mkdtempSync, readFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { ArtifactMeta, ArtifactUse, CheckResult, PermissionRequest } from '@oide/protocol';
import { OideMcpServer } from './server.js';
import type { AgentToolHandlers, ArtifactsBackend } from './types.js';
import { suggestRule, summarizeTool } from './rules.js';

const servers: OideMcpServer[] = [];
afterEach(async () => {
  while (servers.length) await servers.pop()!.close();
});

function recorder() {
  const requests: PermissionRequest[] = [];
  const resolved: Array<[string, string]> = [];
  const reviews: Array<{ summary: string; checks: CheckResult[] }> = [];
  const handlers: AgentToolHandlers = {
    onPermissionRequest: (r) => requests.push(r),
    onPermissionResolved: (id, b) => resolved.push([id, b]),
    onReview: (r) => reviews.push(r),
  };
  return { requests, resolved, reviews, handlers };
}

function memoryArtifacts(): ArtifactsBackend {
  const meta: ArtifactMeta = { id: 'art-1', slug: 'login', title: 'Login design', kind: 'design', location: 'app-data', version: 1, entry: 'index.html', createdAt: 1, updatedAt: 1 };
  let content = '<h1>Login</h1>';
  return {
    list: async () => [meta],
    read: async () => ({ meta, content }),
    write: async (_c, _id, c) => {
      content = c;
      meta.version++;
      return meta;
    },
    create: async (_c, input) => ({ ...meta, id: 'art-2', title: input.title, kind: input.kind }),
  };
}

async function setup(opts: { artifacts?: boolean } = {}) {
  const uses: ArtifactUse[] = [];
  const appDataDir = mkdtempSync(join(tmpdir(), 'oide-mcp-'));
  const server = new OideMcpServer({ appDataDir, ...(opts.artifacts ? { artifacts: memoryArtifacts(), onArtifactUse: (u: ArtifactUse) => uses.push(u) } : {}) });
  servers.push(server);
  await server.start();
  const rec = recorder();
  const reg = await server.registerAgent('agent-1', rec.handlers, { github: { type: 'http', url: 'http://127.0.0.1:9/mcp/github', headers: { 'X-Oide-Secret': 'other' } }, oide: { command: 'evil' } }, { projectId: 'p1' });
  return { server, reg, rec, uses, appDataDir };
}

async function connect(url: string, secret: string) {
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { 'X-Oide-Secret': secret } } }));
  return client;
}

function raw(port: number, path: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '1' } } }));
  });
}

const textOf = (r: unknown) => ((r as { content: Array<{ text: string }> }).content[0]!.text);

describe('OideMcpServer', () => {
  it('writes mcp.json with the per-agent endpoint and secret, merging extra servers but never replacing oide', async () => {
    const { reg } = await setup();
    const cfg = JSON.parse(readFileSync(reg.mcpConfigPath, 'utf8'));
    expect(reg.mcpConfigPath.replace(/\\/g, '/')).toMatch(/agents\/agent-1\/mcp\.json$/);
    expect(cfg.mcpServers.oide).toEqual({ type: 'http', url: reg.url, headers: { 'X-Oide-Secret': reg.secret } });
    expect(cfg.mcpServers.github.url).toBe('http://127.0.0.1:9/mcp/github');
    expect(reg.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp\/agent-1$/);
    expect(reg.secret).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects missing or wrong secrets, foreign Host and Origin, unknown endpoints', async () => {
    const { server, reg } = await setup();
    const port = Number(new URL(reg.url).port);
    const ok = { host: `127.0.0.1:${port}`, 'x-oide-secret': reg.secret };
    expect(await raw(port, '/mcp/agent-1', ok)).toBe(200);
    expect(await raw(port, '/mcp/agent-1', { host: ok.host })).toBe(401);
    expect(await raw(port, '/mcp/agent-1', { ...ok, 'x-oide-secret': 'nope' })).toBe(401);
    expect(await raw(port, '/mcp/agent-2', ok)).toBe(404);
    expect(await raw(port, '/mcp/agent-1', { ...ok, host: `evil.example:${port}` })).toBe(403);
    expect(await raw(port, '/mcp/agent-1', { ...ok, origin: 'https://evil.example' })).toBe(403);
    expect(await raw(port, '/mcp/agent-1', { ...ok, origin: `http://localhost:${port}` })).toBe(200);
    await server.unregisterAgent('agent-1');
    expect(await raw(port, '/mcp/agent-1', ok)).toBe(404);
  });

  it('permission_prompt blocks until answered with the exact pending id', async () => {
    const { server, reg, rec } = await setup();
    const client = await connect(reg.url, reg.secret);
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toEqual(['permission_prompt', 'submit_for_review']);
    const call = client.callTool({ name: 'permission_prompt', arguments: { tool_name: 'Bash', input: { command: 'npm test' }, tool_use_id: 'toolu_1' } });
    for (let i = 0; i < 100 && !rec.requests.length; i++) await new Promise((r) => setTimeout(r, 10));
    const req = rec.requests[0]!;
    expect(req).toMatchObject({ agentId: 'agent-1', toolName: 'Bash', toolUseId: 'toolu_1', summary: 'Run npm test', suggestedRule: 'Bash(npm test)' });
    expect(server.pendingRequests('agent-1')).toHaveLength(1);
    expect(server.answer('perm-wrong', { requestId: 'perm-wrong', behavior: 'allow', always: false })).toBe(false);
    expect(server.answer(req.requestId, { requestId: 'mismatch', behavior: 'allow', always: false })).toBe(false);
    expect(server.answer(req.requestId, { requestId: req.requestId, behavior: 'allow', always: true, updatedInput: { command: 'npm test -- --run' } })).toBe(true);
    expect(JSON.parse(textOf(await call))).toEqual({ behavior: 'allow', updatedInput: { command: 'npm test -- --run' } });
    expect(rec.resolved).toEqual([[req.requestId, 'allow']]);
    expect(server.answer(req.requestId, { requestId: req.requestId, behavior: 'deny', message: 'x' })).toBe(false); // already answered

    const call2 = client.callTool({ name: 'permission_prompt', arguments: { tool_name: 'Write', input: { file_path: 'a.txt' } } });
    for (let i = 0; i < 100 && rec.requests.length < 2; i++) await new Promise((r) => setTimeout(r, 10));
    server.answer(rec.requests[1]!.requestId, { requestId: rec.requests[1]!.requestId, behavior: 'deny', message: 'No thanks' });
    expect(JSON.parse(textOf(await call2))).toEqual({ behavior: 'deny', message: 'No thanks' });
    await client.close();
  });

  it('pending prompts deny on shutdown', async () => {
    const { server, reg, rec } = await setup();
    const client = await connect(reg.url, reg.secret);
    const call = client.callTool({ name: 'permission_prompt', arguments: { tool_name: 'Bash', input: { command: 'rm -rf build' } } });
    for (let i = 0; i < 100 && !rec.requests.length; i++) await new Promise((r) => setTimeout(r, 10));
    const closing = server.close();
    servers.splice(servers.indexOf(server), 1);
    const res = await call.catch((e: Error) => ({ content: [{ text: JSON.stringify({ behavior: 'deny', message: e.message }) }] }));
    expect(JSON.parse(textOf(res)).behavior).toBe('deny');
    expect(rec.resolved[0]![1]).toBe('deny');
    await closing;
  });

  it('submit_for_review hands structured summary and checks to the agent handler', async () => {
    const { reg, rec } = await setup();
    const client = await connect(reg.url, reg.secret);
    const res = await client.callTool({ name: 'submit_for_review', arguments: { summary: 'Fixed login', checks: [{ name: 'npm test', status: 'passed' }, { name: 'lint', status: 'FAIL', detail: '2 errors' }] } });
    expect(textOf(res)).toMatch(/Submitted for review/);
    expect(rec.reviews).toEqual([{ summary: 'Fixed login', checks: [{ name: 'npm test', status: 'passed' }, { name: 'lint', status: 'failed', detail: '2 errors' }] }]);
    const bad = await client.callTool({ name: 'submit_for_review', arguments: {} });
    expect(bad.isError).toBe(true);
    await client.close();
  });

  it('artifacts tools and resources go through the backend and log every use', async () => {
    const { reg, uses } = await setup({ artifacts: true });
    const client = await connect(reg.url, reg.secret);
    expect((await client.listTools()).tools.map((t) => t.name)).toContain('artifacts_write');
    expect(JSON.parse(textOf(await client.callTool({ name: 'artifacts_list', arguments: {} })))[0].id).toBe('art-1');
    expect(JSON.parse(textOf(await client.callTool({ name: 'artifacts_read', arguments: { id: 'art-1' } }))).content).toBe('<h1>Login</h1>');
    expect(JSON.parse(textOf(await client.callTool({ name: 'artifacts_write', arguments: { id: 'art-1', content: '<h1>v2</h1>' } }))).version).toBe(2);
    expect(JSON.parse(textOf(await client.callTool({ name: 'artifacts_create', arguments: { title: 'Notes', kind: 'doc', content: '# Notes' } }))).id).toBe('art-2');
    const res = await client.readResource({ uri: 'oide://artifacts/art-1' });
    expect((res.contents[0] as { text: string }).text).toBe('<h1>v2</h1>');
    expect(uses.map((u) => `${u.op}:${u.artifactId}:${u.agentId}`)).toEqual(['list:*:agent-1', 'read:art-1:agent-1', 'write:art-1:agent-1', 'create:art-2:agent-1', 'read:art-1:agent-1']);
    await client.close();
  });

  it('rejects unsafe agent ids', async () => {
    const { server } = await setup();
    await expect(server.registerAgent('../evil', recorder().handlers)).rejects.toThrow(/Invalid agent id/);
  });
});

describe('rules', () => {
  it('summaries and Always rules', () => {
    expect(summarizeTool('Bash', { command: 'npm test' })).toBe('Run npm test');
    expect(summarizeTool('mcp__github__create_pr', {})).toBe('Use create_pr (github)');
    expect(suggestRule('Bash', { command: 'npm test' })).toBe('Bash(npm test)');
    expect(suggestRule('Bash', { command: 'a\nb' })).toBeUndefined();
    expect(suggestRule('WebFetch', { url: 'https://docs.example.com/x' })).toBe('WebFetch(domain:docs.example.com)');
    expect(suggestRule('Edit', { file_path: 'x' })).toBe('Edit');
  });
});
