import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
  const broken: ArtifactMeta = { ...meta, id: 'art-9', slug: 'site', title: 'Site', importedFrom: 'https://claude.ai/artifact/NFaggV4JC9X6prTgKhobKm', brokenImport: true };
  return {
    list: async () => [meta, broken],
    read: async (_c, id) => (id === 'art-9' ? { meta: broken, content: '<p>oIDE cannot fetch claude.ai artifacts</p>' } : { meta, content }),
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
    // SEC-16: no secret in the file; the CLI expands the placeholders from this agent's env only.
    expect(cfg.mcpServers.oide).toEqual({ type: 'http', url: reg.url, headers: { 'X-Oide-Secret': '${OIDE_MCP_HANDSHAKE}' } });
    expect(reg.env.OIDE_MCP_HANDSHAKE).toBe(reg.secret);
    expect(readFileSync(reg.mcpConfigPath, 'utf8')).not.toContain(reg.secret);
    expect(cfg.mcpServers.github.url).toBe('http://127.0.0.1:9/mcp/github');
    expect(cfg.mcpServers.github.headers['X-Oide-Secret']).toBe('${OIDE_MCP_HEADER_0}');
    expect(reg.env.OIDE_MCP_HEADER_0).toBe('other');
    expect(readFileSync(reg.mcpConfigPath, 'utf8')).not.toContain('"other"');
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

  it('unregisterAgent deletes the whole <app-data>/agents/<id>/ folder (m5)', async () => {
    const { server, reg } = await setup();
    const dir = join(reg.mcpConfigPath, '..');
    writeFileSync(join(dir, 'scratch.txt'), 'x');
    await server.unregisterAgent('agent-1');
    expect(existsSync(dir)).toBe(false);
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

    // SEC-22: the renderer cannot rewrite the input of tools whose prompt does not edit it.
    const call3 = client.callTool({ name: 'permission_prompt', arguments: { tool_name: 'Write', input: { file_path: 'a.txt', content: 'x' } } });
    for (let i = 0; i < 100 && rec.requests.length < 3; i++) await new Promise((r) => setTimeout(r, 10));
    const id3 = rec.requests[2]!.requestId;
    server.answer(id3, { requestId: id3, behavior: 'allow', always: false, updatedInput: { file_path: '../../.bashrc', content: 'evil' } });
    expect(JSON.parse(textOf(await call3))).toEqual({ behavior: 'allow', updatedInput: { file_path: 'a.txt', content: 'x' } });
    await client.close();
  });

  it('caps the prompts one agent may have open at once (SEC-16)', async () => {
    const { reg, rec } = await setup();
    const client = await connect(reg.url, reg.secret);
    const calls = Array.from({ length: 6 }, (_, i) => client.callTool({ name: 'permission_prompt', arguments: { tool_name: 'Bash', input: { command: `echo ${i}` } } }));
    for (let i = 0; i < 200 && rec.requests.length < 5; i++) await new Promise((r) => setTimeout(r, 10));
    const settled = await Promise.race([Promise.any(calls), new Promise((r) => setTimeout(() => r('none'), 2000))]);
    expect(rec.requests).toHaveLength(5);
    expect(JSON.parse(textOf(settled)).behavior).toBe('deny');
    await client.close();
  });

  it('launches secret-bearing stdio servers through the launcher; secrets never reach the file or agent env (SEC-11)', async () => {
    const appDataDir = mkdtempSync(join(tmpdir(), 'oide-mcp-'));
    const server = new OideMcpServer({ appDataDir, nodeBinary: process.execPath });
    servers.push(server);
    await server.start();
    const out = join(appDataDir, 'child-env.txt');
    const script = `require('fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify({ key: process.env.API_KEY, arg: process.argv[1], agent: process.env.OIDE_MCP_HANDSHAKE ?? null }))`;
    const reg = await server.registerAgent(
      'agent-1',
      recorder().handlers,
      { db: { type: 'stdio', command: process.execPath, args: ['-e', script, '--', '--token=${OIDE_MCP_DB_TOKEN}'], env: { API_KEY: '${OIDE_MCP_DB_API_KEY}' } } },
      { secretEnv: { OIDE_MCP_DB_API_KEY: 'sk-db-123', OIDE_MCP_DB_TOKEN: 'tok-9', OIDE_MCP_OTHER_X: 'keep' } },
    );
    const file = readFileSync(reg.mcpConfigPath, 'utf8');
    expect(file).not.toContain('sk-db-123');
    expect(file).not.toContain('tok-9');
    expect(reg.env).not.toHaveProperty('OIDE_MCP_DB_API_KEY');
    expect(reg.env).not.toHaveProperty('OIDE_MCP_DB_TOKEN');
    expect(reg.env.OIDE_MCP_OTHER_X).toBe('keep'); // not used by a launched server: stays (e.g. project .mcp.json)
    const entry = JSON.parse(file).mcpServers.db as { command: string; args: string[] };
    expect(entry.command).toBe(process.execPath);
    const run = (env: Record<string, string>) =>
      new Promise<number | null>((resolve) => {
        const c = spawn(entry.command, entry.args, { env: { ...process.env, ...env }, stdio: 'ignore' });
        c.on('exit', (code) => resolve(code));
      });
    // Another agent's secret (or none) is refused.
    expect(await run({ OIDE_MCP_HANDSHAKE: 'wrong' })).not.toBe(0);
    expect(await run(reg.env)).toBe(0);
    expect(JSON.parse(readFileSync(out, 'utf8'))).toEqual({ key: 'sk-db-123', arg: '--token=tok-9', agent: null });
    // One-time: a second fetch with the same nonce is refused.
    expect(await run(reg.env)).not.toBe(0);
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

  it('tells agents a claude.ai import without content is not the artifact, and gives no placeholder content', async () => {
    const { reg } = await setup({ artifacts: true });
    const client = await connect(reg.url, reg.secret);
    const list = JSON.parse(textOf(await client.callTool({ name: 'artifacts_list', arguments: {} }))) as Array<Record<string, unknown>>;
    expect(list[1]).toMatchObject({ id: 'art-9', brokenImport: true, importedFrom: 'https://claude.ai/artifact/NFaggV4JC9X6prTgKhobKm' });
    expect(list[0]).not.toHaveProperty('brokenImport');
    const read = JSON.parse(textOf(await client.callTool({ name: 'artifacts_read', arguments: { id: 'art-9' } }))) as Record<string, unknown>;
    expect(read).toMatchObject({ content: null, status: 'import-has-no-content' });
    expect(read.message).toMatch(/do not build from it/);
    expect(read.message).toMatch(/paste the artifact's code/);
    expect(JSON.stringify(read)).not.toMatch(/cannot fetch/);
    await client.close();
  });

  it('multi-file artifacts: files list, one file by path, writes with files, version 0 without content', async () => {
    const calls: string[] = [];
    const multi: ArtifactMeta = { id: 'art-m', slug: 'site', title: 'Site', kind: 'design', location: 'app-data', version: 2, entry: 'index.html', fileCount: 2, createdAt: 1, updatedAt: 1 };
    const v0: ArtifactMeta = { ...multi, id: 'art-0', version: 0, fileCount: 0, importedFrom: 'https://claude.ai/artifact/NFaggV4JC9X6prTgKhobKm', retrieval: { status: 'retrieving', agentId: 'agent-1', trigger: 'import', startedAt: 1 } };
    const failed: ArtifactMeta = { ...v0, id: 'art-f', retrieval: { status: 'failed', trigger: 'import', startedAt: 1, error: 'Claude Code CLI has no tool that can read claude.ai Design artifacts.' } };
    const metas: Record<string, ArtifactMeta> = { 'art-m': multi, 'art-0': v0, 'art-f': failed };
    const backend: ArtifactsBackend = {
      list: async () => Object.values(metas),
      read: async (_c, id) => ({ meta: metas[id]!, content: id === 'art-m' ? '<p>x</p>' : '' }),
      write: async () => multi,
      create: async (_c, input) => {
        calls.push(`create:${input.files?.map((f) => f.path).join(',')}:${input.entry}`);
        return { ...multi, id: 'art-new', entry: input.entry ?? 'index.html' };
      },
      files: async () => [
        { path: 'index.html', size: 8, text: true },
        { path: 'shots/a.png', size: 4, text: false },
      ],
      readFile: async (_c, _id, path) => (path.endsWith('.png') ? { encoding: 'base64', data: 'iVBO' } : { encoding: 'utf8', data: '<p>x</p>' }),
      writeFiles: async (_c, id, change) => {
        calls.push(`writeFiles:${id}:${change.files?.map((f) => f.path).join(',')}:${change.deletes?.join(',')}:${change.entry}:${change.content}`);
        return { ...multi, version: 3 };
      },
    };
    const appDataDir = mkdtempSync(join(tmpdir(), 'oide-mcp-'));
    const server = new OideMcpServer({ appDataDir, artifacts: backend });
    servers.push(server);
    await server.start();
    const reg = await server.registerAgent('agent-1', recorder().handlers);
    const client = await connect(reg.url, reg.secret);
    const read = JSON.parse(textOf(await client.callTool({ name: 'artifacts_read', arguments: { id: 'art-m' } })));
    expect(read).toMatchObject({ content: '<p>x</p>', files: [{ path: 'index.html' }, { path: 'shots/a.png', text: false }] });
    expect(JSON.parse(textOf(await client.callTool({ name: 'artifacts_read', arguments: { id: 'art-m', path: 'shots/a.png' } })))).toEqual({ id: 'art-m', path: 'shots/a.png', encoding: 'base64', base64: 'iVBO' });
    expect((await client.callTool({ name: 'artifacts_read', arguments: { id: 'art-m', path: '../x' } })).isError).toBe(true);
    const pending = JSON.parse(textOf(await client.callTool({ name: 'artifacts_read', arguments: { id: 'art-0' } })));
    expect(pending).toMatchObject({ content: null, status: 'retrieving' });
    expect(pending.message).toMatch(/still retrieving/);
    const gone = JSON.parse(textOf(await client.callTool({ name: 'artifacts_read', arguments: { id: 'art-f' } })));
    expect(gone).toMatchObject({ content: null, status: 'retrieval-failed' });
    expect(gone.message).toMatch(/no tool that can read/);

    const w = JSON.parse(textOf(await client.callTool({ name: 'artifacts_write', arguments: { id: 'art-m', files: [{ path: 'a.css', content: 'x' }, { path: 'b.png', base64: 'iVBO' }], deletes: ['old.css'], entry: 'a.html' } })));
    expect(w).toMatchObject({ ok: true, version: 3 });
    expect((await client.callTool({ name: 'artifacts_write', arguments: { id: 'art-m', files: [{ path: 'a.css', content: 'x', base64: 'eA==' }] } })).isError).toBe(true);
    expect((await client.callTool({ name: 'artifacts_write', arguments: { id: 'art-m' } })).isError).toBe(true);
    await client.callTool({ name: 'artifacts_create', arguments: { title: 'T', kind: 'design', files: [{ path: 'p/Main.html', fromFile: 'out/Main.html' }], entry: 'p/Main.html' } });
    expect(calls).toEqual(['writeFiles:art-m:a.css,b.png:old.css:a.html:undefined', 'create:p/Main.html:p/Main.html']);
    // No retrieval backend: the retrieval tools are neither listed nor usable.
    expect((await client.listTools()).tools.map((t) => t.name)).not.toContain('artifact_retrieval_finish');
    expect((await client.callTool({ name: 'artifact_retrieval_finish', arguments: { id: 'art-0', ok: false } })).isError).toBe(true);
    await client.close();
  });

  it('retrieval tools: listed only for a retrieval agent, inputs validated, refusals passed through', async () => {
    const seen: Array<{ agent: string; id: string; what: string }> = [];
    const backend: ArtifactsBackend = {
      ...memoryArtifacts(),
      isRetrievalAgent: (agentId) => agentId === 'agent-r',
      retrievalAddFiles: async (ctx, id, files) => {
        if (ctx.agentId !== 'agent-r') throw new Error('Only the agent retrieving this artifact can hand over its files.');
        seen.push({ agent: ctx.agentId, id, what: files.map((f) => f.path).join(',') });
        return { files: files.length, bytes: 10 };
      },
      retrievalFinish: async (ctx, id, result) => {
        seen.push({ agent: ctx.agentId, id, what: `finish:${result.ok}:${result.entry ?? result.reason}` });
        return result.ok ? { status: 'ready', version: 1, entry: result.entry! } : { status: 'failed', version: 0, error: result.reason! };
      },
    };
    const appDataDir = mkdtempSync(join(tmpdir(), 'oide-mcp-'));
    const server = new OideMcpServer({ appDataDir, artifacts: backend });
    servers.push(server);
    await server.start();
    const regR = await server.registerAgent('agent-r', recorder().handlers);
    const retriever = await connect(regR.url, regR.secret);
    const other = await server.registerAgent('agent-o', recorder().handlers);
    const otherClient = await connect(other.url, other.secret);
    expect((await retriever.listTools()).tools.map((t) => t.name)).toEqual(expect.arrayContaining(['artifact_retrieval_add_files', 'artifact_retrieval_finish']));
    expect((await otherClient.listTools()).tools.map((t) => t.name)).not.toContain('artifact_retrieval_add_files');

    const add = JSON.parse(textOf(await retriever.callTool({ name: 'artifact_retrieval_add_files', arguments: { id: 'art-0', files: [{ path: 'index.html', content: '<p>x</p>' }, { path: 'shots/1.png', base64: 'iVBO' }] } })));
    expect(add).toMatchObject({ ok: true, staged: 2, files: 2 });
    for (const bad of [{ id: 'art-0', files: [] }, { id: 'art-0', files: [{ path: '../evil', content: 'x' }] }, { id: 'art-0', files: [{ path: 'artifact.json', content: 'x' }] }, { id: 'art-0', files: [{ path: 'a.css' }] }]) {
      expect((await retriever.callTool({ name: 'artifact_retrieval_add_files', arguments: bad })).isError, JSON.stringify(bad)).toBe(true);
    }
    const refused = await otherClient.callTool({ name: 'artifact_retrieval_add_files', arguments: { id: 'art-0', files: [{ path: 'a.css', content: 'x' }] } });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toMatch(/Only the agent retrieving/);
    const done = JSON.parse(textOf(await retriever.callTool({ name: 'artifact_retrieval_finish', arguments: { id: 'art-0', ok: true, entry: 'index.html', title: 'Site', kind: 'design' } })));
    expect(done).toMatchObject({ ok: true, status: 'ready', version: 1 });
    const no = await retriever.callTool({ name: 'artifact_retrieval_finish', arguments: { id: 'art-0', ok: false, reason: 'No tool can read it.' } });
    expect(JSON.parse(textOf(no))).toMatchObject({ status: 'failed', error: 'No tool can read it.' });
    expect(seen.map((s) => `${s.agent}:${s.what}`)).toEqual(['agent-r:index.html,shots/1.png', 'agent-r:finish:true:index.html', 'agent-r:finish:false:No tool can read it.']);
    await retriever.close();
    await otherClient.close();
  });

  it('accepts request bodies above the SDK default of 4 MB (a batch of files)', async () => {
    let got = 0;
    const backend: ArtifactsBackend = { ...memoryArtifacts(), isRetrievalAgent: () => true, retrievalAddFiles: async (_c, _id, files) => ((got = files[0]!.base64!.length), { files: 1, bytes: got }), retrievalFinish: async () => ({ status: 'failed', version: 0 }) };
    const server = new OideMcpServer({ appDataDir: mkdtempSync(join(tmpdir(), 'oide-mcp-')), artifacts: backend });
    servers.push(server);
    await server.start();
    const reg = await server.registerAgent('agent-1', recorder().handlers);
    const client = await connect(reg.url, reg.secret);
    const big = Buffer.alloc(5 * 1024 * 1024, 1).toString('base64');
    const r = await client.callTool({ name: 'artifact_retrieval_add_files', arguments: { id: 'a', files: [{ path: 'big.bin', base64: big }] } });
    expect(r.isError).toBeFalsy();
    expect(got).toBe(big.length);
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
