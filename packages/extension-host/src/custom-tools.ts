import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport, SseError } from '@modelcontextprotocol/sdk/client/sse.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { CustomServer, type ToolRisk } from '@oide/protocol';
import { ENGINE_VERSION } from './manifest.js';
import { normalizeEntry as normalize, scanImportsFull, type ImportedConfig, type ScanOptions } from './import-scan.js';
import type { CustomServerRepository, FetchFn, MaybePromise, OpenExternal, ProjectRef, SecretStore } from './interfaces.js';
import { customEnvSecretKey } from './mcp-config.js';
import { authorize, oauthKeys, saveHeaderToken, TokenSource } from './oauth.js';

export interface ProbedTool {
  name: string;
  description?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  /** Suggested label from the annotations. */
  risk: ToolRisk;
}

export interface ProbeUrlResult {
  reached: boolean;
  transport?: 'Streamable HTTP' | 'SSE';
  /** "Metrics API v2.3" */
  serverInfo?: string;
  serverName?: string;
  serverVersion?: string;
  needsAuth: boolean;
  tools: ProbedTool[];
  error?: string;
}

export interface ProbeCommandResult {
  started: boolean;
  serverInfo?: string;
  tools: ProbedTool[];
  error?: string;
}

/** Build brief: `readOnlyHint` → read; `destructiveHint` or no hint → asks first. */
export function riskFromAnnotations(a: { readOnlyHint?: boolean | undefined; destructiveHint?: boolean | undefined } | undefined): ToolRisk {
  if (!a) return 'ask';
  if (a.destructiveHint === true) return 'ask';
  return a.readOnlyHint === true ? 'read' : 'ask';
}

const CLIENT_INFO = { name: 'oide', version: ENGINE_VERSION };

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

async function listAllTools(client: Client): Promise<ProbedTool[]> {
  const out: ProbedTool[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 50; page++) {
    const res = await client.listTools(cursor ? { cursor } : {});
    for (const t of res.tools) {
      const a = t.annotations;
      const tool: ProbedTool = { name: t.name, risk: riskFromAnnotations(a) };
      if (t.description) tool.description = t.description;
      if (a?.readOnlyHint !== undefined) tool.readOnlyHint = a.readOnlyHint;
      if (a?.destructiveHint !== undefined) tool.destructiveHint = a.destructiveHint;
      out.push(tool);
    }
    cursor = res.nextCursor;
    if (!cursor) break;
  }
  return out;
}

function is401(e: unknown): boolean {
  if (e instanceof UnauthorizedError) return true;
  if (e instanceof StreamableHTTPError || e instanceof SseError) return e.code === 401;
  return e instanceof Error && /\b401\b|unauthori[sz]ed/i.test(e.message);
}

function serverInfoOf(client: Client): { serverName?: string; serverVersion?: string; serverInfo?: string } {
  const v = client.getServerVersion();
  if (!v) return {};
  const title = (v as { title?: string }).title ?? v.name;
  return { serverName: title, serverVersion: v.version, serverInfo: `${title} v${v.version}` };
}

async function tryTransport(make: () => Transport, timeoutMs: number): Promise<{ client: Client; tools: ProbedTool[] }> {
  const client = new Client(CLIENT_INFO);
  const transport = make();
  try {
    await withTimeout(client.connect(transport), timeoutMs, 'connect');
    const tools = await withTimeout(listAllTools(client), timeoutMs, 'tools/list');
    return { client, tools };
  } catch (e) {
    await client.close().catch(() => undefined);
    throw e;
  }
}

/**
 * Add custom › From a URL: connect with Streamable HTTP, fall back to SSE, read server info and
 * `tools/list`. A 401 means the server needs OAuth sign-in (or a header token).
 */
export async function probeUrl(url: string, o: { headers?: Record<string, string>; fetch?: FetchFn; timeoutMs?: number } = {}): Promise<ProbeUrlResult> {
  let u: URL;
  try {
    u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('bad protocol');
  } catch {
    return { reached: false, needsAuth: false, tools: [], error: 'Not an http(s) URL' };
  }
  const timeoutMs = o.timeoutMs ?? 15_000;
  const requestInit: RequestInit = o.headers ? { headers: o.headers } : {};
  const fetchOpt = o.fetch ? { fetch: o.fetch } : {};
  let firstError: unknown;
  try {
    const { client, tools } = await tryTransport(() => new StreamableHTTPClientTransport(u, { requestInit, ...fetchOpt }), timeoutMs);
    const info = serverInfoOf(client);
    await client.close().catch(() => undefined);
    return { reached: true, transport: 'Streamable HTTP', needsAuth: false, tools, ...info };
  } catch (e) {
    if (is401(e)) return { reached: true, transport: 'Streamable HTTP', needsAuth: true, tools: [] };
    firstError = e;
  }
  try {
    const { client, tools } = await tryTransport(() => new SSEClientTransport(u, { requestInit, ...fetchOpt }), timeoutMs);
    const info = serverInfoOf(client);
    await client.close().catch(() => undefined);
    return { reached: true, transport: 'SSE', needsAuth: false, tools, ...info };
  } catch (e) {
    if (is401(e)) return { reached: true, transport: 'SSE', needsAuth: true, tools: [] };
    const msg = firstError instanceof Error ? firstError.message : String(firstError);
    return { reached: false, needsAuth: false, tools: [], error: msg };
  }
}

/** Add custom › Local command: start the server once over stdio, list its tools, then stop it. */
export async function probeCommand(command: string, args: string[] = [], env: Record<string, string> = {}, o: { cwd?: string; timeoutMs?: number } = {}): Promise<ProbeCommandResult> {
  const timeoutMs = o.timeoutMs ?? 20_000;
  let stderr = '';
  const transport = new StdioClientTransport({ command, args, env: { ...getDefaultEnvironment(), ...env }, stderr: 'pipe', ...(o.cwd ? { cwd: o.cwd } : {}) });
  transport.stderr?.on('data', (c: Buffer) => {
    if (stderr.length < 4000) stderr += c.toString('utf8');
  });
  const client = new Client(CLIENT_INFO);
  try {
    await withTimeout(client.connect(transport), timeoutMs, 'start');
    const tools = await withTimeout(listAllTools(client), timeoutMs, 'tools/list');
    const info = serverInfoOf(client);
    const r: ProbeCommandResult = { started: true, tools };
    if (info.serverInfo) r.serverInfo = info.serverInfo;
    return r;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { started: false, tools: [], error: stderr.trim() ? `${msg}: ${stderr.trim().split('\n').slice(-3).join(' ')}` : msg };
  } finally {
    await client.close().catch(() => undefined); // kills the process
  }
}

/** Split a command line (`npx -y "@scope/pkg" --root .`) into command and args. */
export function parseCommandLine(line: string): { command: string; args: string[] } {
  const parts: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) parts.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : (m[2] ?? m[3] ?? ''));
  const [command = '', ...args] = parts;
  return { command, args };
}

/**
 * Paste JSON: accepts `{ "mcpServers": { … } }`, a bare `{ name: { command … } }` map, or a single
 * entry with `name`. Env values come back separately so they can go straight to the keychain.
 */
export function parsePastedJson(text: string): Array<{ name: string; config: ImportedConfig }> {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new Error('Not valid JSON');
  }
  if (!doc || typeof doc !== 'object') throw new Error('Expected an object');
  const d = doc as Record<string, unknown>;
  const map = (d['mcpServers'] ?? d['servers'] ?? d) as Record<string, unknown>;
  const out: Array<{ name: string; config: ImportedConfig }> = [];
  for (const [name, raw] of Object.entries(map)) {
    const c = normalize(raw);
    if (c) out.push({ name: name.replace(/[^a-zA-Z0-9_-]/g, '-'), config: c });
  }
  if (!out.length) throw new Error('No MCP servers found in the standard mcpServers format');
  return out;
}

/** The standard Claude Code `.mcp.json` entry for a server, with `${VAR}` placeholders for secrets. */
export function mcpJsonEntry(server: CustomServer): Record<string, unknown> {
  const t = server.transport;
  if (t.kind === 'stdio') {
    const entry: Record<string, unknown> = { command: t.command, args: t.args };
    if (t.envKeys.length) entry['env'] = Object.fromEntries(t.envKeys.map((k) => [k, `\${${k}}`]));
    return entry;
  }
  const entry: Record<string, unknown> = { type: 'http', url: t.url };
  if (t.auth === 'header') entry['headers'] = { Authorization: `\${${server.name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_TOKEN}` };
  return entry;
}

/** Merge (or remove, with `entry === null`) one server in `<root>/.mcp.json`, keeping everything else. */
export async function writeProjectMcpJson(root: string, name: string, entry: Record<string, unknown> | null): Promise<void> {
  const file = path.join(root, '.mcp.json');
  let doc: Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8')) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) doc = parsed as Record<string, unknown>;
    } catch {
      throw new Error(`${file} is not valid JSON; not changing it`);
    }
  }
  const servers = { ...((doc['mcpServers'] as Record<string, unknown> | undefined) ?? {}) };
  if (entry) servers[name] = entry;
  else delete servers[name];
  doc['mcpServers'] = servers;
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  await rename(tmp, file);
}

export interface CustomToolsOptions {
  repo: CustomServerRepository;
  secrets: SecretStore;
  openExternal: OpenExternal;
  /** Resolve a project id to its folder (for `.mcp.json`). */
  project(projectId: string): MaybePromise<ProjectRef | undefined>;
  /** Open projects, for the import scan. */
  openProjects?(): MaybePromise<ProjectRef[]>;
  fetch?: FetchFn;
  /** Overrides for the import scan (tests). */
  scan?: Omit<ScanOptions, 'existing' | 'projects'>;
}

/**
 * Add custom: all four routes end in one CustomServer record. Records live in the repository
 * (My settings) and, for "Project .mcp.json", also in each chosen project's `.mcp.json`.
 * Secrets go to the SecretStore only.
 */
export class CustomTools {
  constructor(private readonly o: CustomToolsOptions) {}

  list(): MaybePromise<CustomServer[]> {
    return this.o.repo.list();
  }

  probeUrl(url: string, headers?: Record<string, string>): Promise<ProbeUrlResult> {
    return probeUrl(url, { ...(headers ? { headers } : {}), ...(this.o.fetch ? { fetch: this.o.fetch } : {}) });
  }

  probeCommand(command: string, args: string[] = [], env: Record<string, string> = {}): Promise<ProbeCommandResult> {
    return probeCommand(command, args, env);
  }

  async scanImports() {
    const existing = await this.o.repo.list();
    const projects = (await this.o.openProjects?.()) ?? [];
    const full = await scanImportsFull({ ...this.o.scan, existing, projects: projects.map((p) => ({ name: p.name, root: p.root })) });
    return full.map(({ full: _f, ...rest }) => rest);
  }

  /** Copy the chosen scanned entries. Env and header values move to the keychain. */
  async importSelected(items: Array<{ file: string; name: string }>, where: { savedTo?: CustomServer['savedTo']; projects?: string[]; allProjects?: boolean } = {}): Promise<CustomServer[]> {
    const existing = await this.o.repo.list();
    const projects = (await this.o.openProjects?.()) ?? [];
    const full = await scanImportsFull({ ...this.o.scan, existing, projects: projects.map((p) => ({ name: p.name, root: p.root })) });
    const out: CustomServer[] = [];
    for (const it of items) {
      const hit = full.find((c) => c.file === it.file && c.name === it.name);
      if (!hit) continue;
      const c = hit.full;
      const base = {
        id: randomUUID(),
        name: hit.name.replace(/[^a-zA-Z0-9_-]/g, '-'),
        route: 'import' as const,
        tools: [],
        projects: where.projects ?? [],
        allProjects: where.allProjects ?? true,
        savedTo: where.savedTo ?? 'my-settings',
        reviewed: false as const,
      };
      if (c.kind === 'stdio') {
        out.push(await this.save(CustomServer.parse({ ...base, transport: { kind: 'stdio', command: c.command, args: c.args, envKeys: Object.keys(c.env) } }), c.env));
      } else {
        const headerKeys = Object.keys(c.headers);
        const server = await this.save(CustomServer.parse({ ...base, transport: { kind: 'http', url: c.url, auth: headerKeys.length ? 'header' : 'none' } }), {});
        const auth = headerKeys.find((k) => /^authorization$/i.test(k)) ?? headerKeys[0];
        if (auth) await saveHeaderToken(this.o.secrets, server.id, auth, c.headers[auth] as string);
        out.push(server);
      }
    }
    return out;
  }

  /**
   * Save a server. `secrets` are env values (stdio) by env var name; they go to the keychain and
   * the record only keeps their names.
   */
  async save(input: CustomServer, secrets: Record<string, string> = {}): Promise<CustomServer> {
    let server = CustomServer.parse(input);
    if (server.transport.kind === 'stdio') {
      const keys = new Set([...server.transport.envKeys, ...Object.keys(secrets)]);
      for (const k of keys) if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new Error(`Invalid env variable name: ${k}`);
      server = { ...server, transport: { ...server.transport, envKeys: [...keys] } };
      for (const [k, v] of Object.entries(secrets)) await this.o.secrets.set(customEnvSecretKey(server.id, k), v);
    }
    const prev = (await this.o.repo.list()).find((s) => s.id === server.id);
    if (server.savedTo === 'project-mcp-json') {
      for (const pid of server.projects) {
        const p = await this.o.project(pid);
        if (p) await writeProjectMcpJson(p.root, server.name, mcpJsonEntry(server));
      }
    }
    // Moved out of a project file, or out of a project: take it out of those .mcp.json files.
    if (prev?.savedTo === 'project-mcp-json') {
      const keep = server.savedTo === 'project-mcp-json' ? new Set(server.projects) : new Set<string>();
      for (const pid of prev.projects) {
        if (keep.has(pid) && prev.name === server.name) continue;
        const p = await this.o.project(pid);
        if (p) await writeProjectMcpJson(p.root, prev.name, null);
      }
    }
    await this.o.repo.upsert(server);
    return server;
  }

  async remove(id: string): Promise<void> {
    const prev = (await this.o.repo.list()).find((s) => s.id === id);
    if (!prev) return;
    if (prev.savedTo === 'project-mcp-json') {
      for (const pid of prev.projects) {
        const p = await this.o.project(pid);
        if (p) await writeProjectMcpJson(p.root, prev.name, null).catch(() => undefined);
      }
    }
    if (prev.transport.kind === 'stdio') for (const k of prev.transport.envKeys) await this.o.secrets.delete(customEnvSecretKey(id, k));
    for (const key of [oauthKeys.tokens(id), oauthKeys.client(id), oauthKeys.discovery(id), oauthKeys.header(id)]) await this.o.secrets.delete(key);
    await this.o.repo.remove(id);
  }

  /** Sign in to a remote server in the system browser (MCP authorization flow). */
  async authorize(id: string, opts: { clientId?: string; clientSecret?: string; scope?: string; timeoutMs?: number } = {}): Promise<{ ok: boolean; error?: string }> {
    const server = (await this.o.repo.list()).find((s) => s.id === id);
    if (!server || server.transport.kind !== 'http') return { ok: false, error: 'Not a remote server' };
    const r = await authorize({ serverId: id, url: server.transport.url, secrets: this.o.secrets, openExternal: this.o.openExternal, ...opts, ...(this.o.fetch ? { fetch: this.o.fetch } : {}) });
    if (r.ok && server.transport.auth !== 'oauth') await this.o.repo.upsert({ ...server, transport: { ...server.transport, auth: 'oauth' } });
    return r;
  }

  async setHeaderToken(id: string, header: string, token: string): Promise<void> {
    const server = (await this.o.repo.list()).find((s) => s.id === id);
    if (!server || server.transport.kind !== 'http') throw new Error('Not a remote server');
    await saveHeaderToken(this.o.secrets, id, header, token);
    if (server.transport.auth !== 'header') await this.o.repo.upsert({ ...server, transport: { ...server.transport, auth: 'header' } });
  }

  /** Token source for the loopback proxy. */
  tokenSource(server: CustomServer): TokenSource | undefined {
    if (server.transport.kind !== 'http') return undefined;
    return new TokenSource({ serverId: server.id, url: server.transport.url, secrets: this.o.secrets, ...(this.o.fetch ? { fetch: this.o.fetch } : {}) });
  }
}
