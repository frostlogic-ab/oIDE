import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { isAbsolute, join } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListResourcesRequestSchema, ListToolsRequestSchema, ReadResourceRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { ArtifactKind, PermissionAnswer, type ArtifactUse, type CheckResult, type PermissionRequest } from '@oide/protocol';
import { z } from 'zod';
import { AGENT_SECRET_ENV, LAUNCHER_FILE, LAUNCHER_SOURCE, expandPlaceholders, placeholders } from './launcher.js';
import { suggestRule, summarizeTool } from './rules.js';
import type { AgentToolHandlers, McpServerEntry, OideMcpServerOptions, RegisteredAgent, RegisterOptions } from './types.js';

/**
 * oIDE's own MCP server (Streamable HTTP on 127.0.0.1, random port). Each agent gets its own endpoint
 * `/mcp/<agentId>` and a per-agent secret header written into its mcp.json. Contract verified on CLI 2.1.325:
 * - `--permission-prompt-tool mcp__oide__permission_prompt` calls the tool with {tool_name, input, tool_use_id}
 *   and `_meta["claudecode/toolUseId"]`; it expects a text content holding
 *   `{"behavior":"allow","updatedInput":{…}}` or `{"behavior":"deny","message":"…"}`.
 * - The CLI hides the prompt tool from the model's tool list; MCP tools themselves also go through it.
 */

export const SECRET_HEADER = 'x-oide-secret';
const AGENT_ID = /^[A-Za-z0-9._-]{1,128}$/;
const MAX_BODY = 8 * 1024 * 1024;

const PermissionPromptInput = z.looseObject({
  tool_name: z.string().min(1),
  input: z.unknown().optional(),
  tool_use_id: z.string().optional(),
});

const CHECK_STATUS: Record<string, CheckResult['status']> = {
  passed: 'passed',
  pass: 'passed',
  ok: 'passed',
  success: 'passed',
  succeeded: 'passed',
  failed: 'failed',
  fail: 'failed',
  error: 'failed',
  failure: 'failed',
  warning: 'warning',
  warn: 'warning',
  skipped: 'skipped',
  skip: 'skipped',
};
const SubmitInput = z.object({
  summary: z.string().min(1).max(50_000),
  checks: z
    .array(
      z.object({
        name: z.string().min(1),
        status: z.string().transform((s) => CHECK_STATUS[s.toLowerCase()] ?? 'warning'),
        detail: z.string().optional(),
      }),
    )
    .default([]),
});
const TitleInput = z.object({ title: z.string().min(1).max(1000) });
const ListInput = z.object({ kind: ArtifactKind.optional(), query: z.string().optional() });
const ReadInput = z.object({ id: z.string().min(1) });
const WriteInput = z.object({ id: z.string().min(1), content: z.string(), note: z.string().optional() });
const CreateInput = z.object({ title: z.string().min(1), kind: ArtifactKind, content: z.string(), shared: z.boolean().optional() });

const TOOLS = {
  permission_prompt: {
    name: 'permission_prompt',
    description: 'oIDE permission prompt (used by the CLI via --permission-prompt-tool; not for direct use).',
    inputSchema: {
      type: 'object',
      properties: { tool_name: { type: 'string' }, input: { type: 'object' }, tool_use_id: { type: 'string' } },
      required: ['tool_name'],
      additionalProperties: true,
    },
  },
  submit_for_review: {
    name: 'submit_for_review',
    description:
      'Submit your finished work to the user for review in oIDE. Call this when the task is done: give a short summary of what you changed and why, and every check you ran (tests, lint, build) with its status.',
    inputSchema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'What you changed and why, a few sentences.' },
        checks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'e.g. "npm test"' },
              status: { type: 'string', enum: ['passed', 'failed', 'warning', 'skipped'] },
              detail: { type: 'string' },
            },
            required: ['name', 'status'],
          },
        },
      },
      required: ['summary'],
    },
  },
  set_title: {
    name: 'set_title',
    description:
      'Name your task in oIDE. The title shows on the agent tile and in its header. Give a short title (3 to 8 words, under 60 characters) that says what the task is, like "Fix flaky invoice test" or "Add dark mode to settings". Call it once, at the start, only when the oIDE contract asks you to.',
    inputSchema: {
      type: 'object',
      properties: { title: { type: 'string', description: 'A short title for the task, in the language the user wrote in. No quotes, no trailing full stop.' } },
      required: ['title'],
    },
  },
  artifacts_list: {
    name: 'artifacts_list',
    description: 'List oIDE artifacts (designs, docs, whiteboards) available to this project.',
    inputSchema: { type: 'object', properties: { kind: { type: 'string', enum: ['design', 'doc', 'whiteboard'] }, query: { type: 'string' } } },
    annotations: { readOnlyHint: true },
  },
  artifacts_read: {
    name: 'artifacts_read',
    description:
      "Read an oIDE artifact by id. Returns its metadata and content. status 'import-has-no-content' means a claude.ai import whose content never arrived: content is null, do not build from it.",
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    annotations: { readOnlyHint: true },
  },
  artifacts_write: {
    name: 'artifacts_write',
    description: 'Write a new version of an oIDE artifact (full content). A design is HTML or React component source (JSX, export default).',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, content: { type: 'string' }, note: { type: 'string' } }, required: ['id', 'content'] },
  },
  artifacts_create: {
    name: 'artifacts_create',
    description:
      'Create a new oIDE artifact. kind: design (HTML, or React component source with export default), doc (Markdown) or whiteboard (Excalidraw JSON). shared=true stores it in the repo.',
    inputSchema: {
      type: 'object',
      properties: { title: { type: 'string' }, kind: { type: 'string', enum: ['design', 'doc', 'whiteboard'] }, content: { type: 'string' }, shared: { type: 'boolean' } },
      required: ['title', 'kind', 'content'],
    },
  },
} as const;

/** What an agent is told when it reads a claude.ai import that never got its content. */
export function brokenImportMessage(link: string | undefined): string {
  return (
    `This artifact was imported from ${link ?? 'claude.ai'} without its content: it holds only a placeholder notice, so do not build from it. ` +
    "Ask the user to open it in oIDE (Artifacts) and paste the artifact's code or drop the file they downloaded from claude.ai. " +
    'If the link is a Claude Doc or a Claude Design project, you may instead read it with your claude.ai connectors and save it with artifacts_write. ' +
    'Chat artifacts cannot be fetched, even public ones.'
  );
}

interface AgentEntry extends RegisteredAgent {
  handlers: AgentToolHandlers;
  projectId?: string;
}

/** A stdio server the launcher may fetch once (SEC-11). */
interface LaunchSpec {
  agentId: string;
  server: string;
  spec: { command: string; args: string[]; env: Record<string, string> };
  expiresAt: number;
}
const LAUNCH_TTL_MS = 10 * 60_000;

/**
 * Tools whose input the user may edit in the prompt, and which edits are accepted (SEC-22). For
 * every other tool an `updatedInput` from the renderer is ignored and the original input is used.
 */
const EDITABLE_INPUT: Record<string, (original: unknown, updated: unknown) => unknown> = {
  // Only the command line itself; every other field stays as the agent sent it.
  Bash: (o, u) => {
    const cmd = (u as { command?: unknown } | null)?.command;
    return typeof cmd === 'string' && o && typeof o === 'object' ? { ...(o as object), command: cmd } : o;
  },
};

export function acceptedInput(toolName: string, original: unknown, updated: unknown): unknown {
  if (updated === undefined) return original;
  const edit = EDITABLE_INPUT[toolName];
  return edit ? edit(original, updated) : original;
}

interface Pending {
  request: PermissionRequest;
  input: unknown;
  resolve: (result: { behavior: 'allow'; updatedInput: unknown } | { behavior: 'deny'; message: string }) => void;
  timer?: NodeJS.Timeout;
}

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };
const text = (t: string, isError = false): ToolResult => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });

export class OideMcpServer {
  private http?: HttpServer;
  private port = 0;
  private readonly agents = new Map<string, AgentEntry>();
  private readonly pending = new Map<string, Pending>();
  private readonly launches = new Map<string, LaunchSpec>();
  private launcherPath: string | undefined;
  private closing = false;

  constructor(private readonly opts: OideMcpServerOptions) {}

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async start(): Promise<{ port: number }> {
    if (this.http) return { port: this.port };
    const http = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve, reject) => {
      http.once('error', reject);
      http.listen(this.opts.port ?? 0, '127.0.0.1', () => resolve());
    });
    this.http = http;
    this.port = (http.address() as AddressInfo).port;
    if (this.opts.nodeBinary && isAbsolute(this.opts.nodeBinary)) {
      try {
        const bin = join(this.opts.appDataDir, 'bin');
        await mkdir(bin, { recursive: true });
        const file = join(bin, LAUNCHER_FILE);
        await writeFile(file, LAUNCHER_SOURCE, { encoding: 'utf8', mode: 0o700 });
        this.launcherPath = file;
      } catch (err) {
        this.opts.log?.('could not write the MCP launcher; secret-bearing stdio servers get env placeholders', err);
      }
    }
    return { port: this.port };
  }

  /**
   * Create the agent's endpoint and write `<app-data>/agents/<id>/mcp.json` (merging extra servers).
   * Call it on every launch: stdio launch nonces are one-time, so each launch writes fresh ones.
   *
   * No secret value is written to the file (SEC-16, SEC-11): every http header value becomes a
   * `${VAR}` placeholder the CLI expands from this agent's env (verified: CLI 2.1.325 parses
   * `--mcp-config` files with env expansion of url and headers), and stdio servers that use secret
   * placeholders are started through the launcher.
   */
  async registerAgent(agentId: string, handlers: AgentToolHandlers, extraServers: Record<string, McpServerEntry> = {}, options: RegisterOptions = {}): Promise<RegisteredAgent> {
    if (!AGENT_ID.test(agentId)) throw new Error(`Invalid agent id for MCP endpoint: ${agentId}`);
    if (!this.http) await this.start();
    const existing = this.agents.get(agentId);
    const secret = existing?.secret ?? randomBytes(32).toString('hex');
    const url = `${this.url}/mcp/${agentId}`;
    const dir = join(this.opts.appDataDir, 'agents', agentId);
    const mcpConfigPath = join(dir, 'mcp.json');
    for (const [nonce, l] of this.launches) if (l.agentId === agentId || l.expiresAt < Date.now()) this.launches.delete(nonce);
    const secretEnv = options.secretEnv ?? {};
    const consumed = new Set<string>();
    const env: Record<string, string> = { [AGENT_SECRET_ENV]: secret };
    let header = 0;
    const servers: Record<string, McpServerEntry> = {};
    for (const [name, entry] of Object.entries(extraServers)) {
      if (name === 'oide' || !/^[A-Za-z0-9_-]+$/.test(name)) {
        this.opts.log?.(`skipping MCP server entry with reserved or invalid name: ${name}`);
        continue;
      }
      if (!('command' in entry)) {
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(entry.headers ?? {})) {
          if (v.includes('${')) headers[k] = v;
          else {
            const varName = `OIDE_MCP_HEADER_${header++}`;
            env[varName] = v;
            headers[k] = `\${${varName}}`;
          }
        }
        servers[name] = { ...entry, ...(entry.headers ? { headers } : {}) };
        continue;
      }
      const used = [...(entry.args ?? []), ...Object.values(entry.env ?? {})].flatMap(placeholders).filter((v) => v in secretEnv);
      if (used.length && this.launcherPath && this.opts.nodeBinary) {
        const nonce = randomBytes(24).toString('hex');
        const expand = (s: string) => expandPlaceholders(s, secretEnv);
        const realEnv: Record<string, string> = {};
        for (const [k, v] of Object.entries(entry.env ?? {})) realEnv[k] = expand(v);
        this.launches.set(nonce, { agentId, server: name, spec: { command: entry.command, args: (entry.args ?? []).map(expand), env: realEnv }, expiresAt: Date.now() + LAUNCH_TTL_MS });
        servers[name] = { type: 'stdio', command: this.opts.nodeBinary, args: [this.launcherPath, `${this.url}/launch/${agentId}`, nonce] };
        for (const v of used) consumed.add(v);
      } else servers[name] = entry;
    }
    // Values no launched server consumed stay in the agent env (e.g. a project .mcp.json read by the CLI itself).
    for (const [k, v] of Object.entries(secretEnv)) if (!consumed.has(k)) env[k] = v;
    servers.oide = { type: 'http', url, headers: { 'X-Oide-Secret': `\${${AGENT_SECRET_ENV}}` } };
    await mkdir(dir, { recursive: true });
    await writeFile(mcpConfigPath, `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    const entry: AgentEntry = { agentId, url, secret, mcpConfigPath, env, handlers, ...(options.projectId ? { projectId: options.projectId } : {}) };
    this.agents.set(agentId, entry);
    return { agentId, url, secret, mcpConfigPath, env };
  }

  async unregisterAgent(agentId: string): Promise<void> {
    const entry = this.agents.get(agentId);
    for (const [id, p] of this.pending) if (p.request.agentId === agentId) this.settle(id, { behavior: 'deny', message: 'The agent was removed' });
    for (const [nonce, l] of this.launches) if (l.agentId === agentId) this.launches.delete(nonce);
    this.agents.delete(agentId);
    if (entry) await rm(entry.mcpConfigPath, { force: true }).catch(() => undefined);
    // The whole per-agent folder (<app-data>/agents/<id>/) goes with the agent. The id is ours, but
    // never let one that looks like a path reach rm.
    if (/^[A-Za-z0-9._-]+$/.test(agentId) && agentId !== '.' && agentId !== '..') {
      await rm(join(this.opts.appDataDir, 'agents', agentId), { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** Pending prompts, optionally for one agent. */
  pendingRequests(agentId?: string): PermissionRequest[] {
    return [...this.pending.values()].map((p) => p.request).filter((r) => !agentId || r.agentId === agentId);
  }

  /** Answer a pending prompt. Only an exact pending request id is accepted. */
  answer(requestId: string, answer: PermissionAnswer): boolean {
    const parsed = PermissionAnswer.safeParse(answer);
    if (!parsed.success || parsed.data.requestId !== requestId) return false;
    const p = this.pending.get(requestId);
    if (!p) return false;
    const a = parsed.data;
    if (a.behavior === 'allow') this.settle(requestId, { behavior: 'allow', updatedInput: acceptedInput(p.request.toolName, p.input, a.updatedInput) });
    else this.settle(requestId, { behavior: 'deny', message: a.message || 'Denied by user' });
    return true;
  }

  private settle(requestId: string, result: { behavior: 'allow'; updatedInput: unknown } | { behavior: 'deny'; message: string }, reason?: 'quit'): void {
    const p = this.pending.get(requestId);
    if (!p) return;
    this.pending.delete(requestId);
    if (p.timer) clearTimeout(p.timer);
    p.resolve(result);
    try {
      const h = this.agents.get(p.request.agentId)?.handlers;
      if (reason) h?.onPermissionResolved(requestId, result.behavior, reason);
      else h?.onPermissionResolved(requestId, result.behavior);
    } catch (err) {
      this.opts.log?.('onPermissionResolved threw', err);
    }
  }

  /** Deny every pending prompt (app quit) and stop listening. */
  async close(): Promise<void> {
    this.closing = true;
    for (const id of [...this.pending.keys()]) this.settle(id, { behavior: 'deny', message: 'oIDE is shutting down' }, 'quit');
    const http = this.http;
    delete this.http;
    if (http) {
      http.closeAllConnections?.();
      await new Promise<void>((r) => http.close(() => r()));
    }
  }

  // ---------------------------------------------------------------- HTTP

  private reject(res: ServerResponse, status: number, message: string): void {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }));
  }

  /** Host must be our loopback address; an Origin header (browsers) must be exactly our own origin. */
  checkOrigin(req: IncomingMessage): string | undefined {
    const host = req.headers.host;
    const allowedHosts = [`127.0.0.1:${this.port}`, `localhost:${this.port}`];
    if (!host || !allowedHosts.includes(host.toLowerCase())) return 'Host not allowed';
    const origin = req.headers.origin;
    if (origin !== undefined && !allowedHosts.map((h) => `http://${h}`).includes(origin.toLowerCase())) return 'Origin not allowed';
    return undefined;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (this.closing) return this.reject(res, 503, 'Shutting down');
      const originProblem = this.checkOrigin(req);
      if (originProblem) return this.reject(res, 403, originProblem);
      const launch = /^\/launch\/([^/?#]+)$/.exec(req.url ?? '');
      if (launch) return this.serveLaunch(req, res, decodeURIComponent(launch[1]!));
      const m = /^\/mcp\/([^/?#]+)\/?(?:\?.*)?$/.exec(req.url ?? '');
      const agent = m ? this.agents.get(decodeURIComponent(m[1]!)) : undefined;
      if (!agent) return this.reject(res, 404, 'Unknown endpoint');
      if (!OideMcpServer.sameSecret(req.headers[SECRET_HEADER], agent.secret)) return this.reject(res, 401, 'Missing or wrong secret');
      const len = Number(req.headers['content-length'] ?? 0);
      if (len > MAX_BODY) return this.reject(res, 413, 'Request too large');

      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      const server = this.mcpFor(agent);
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (err) {
      this.opts.log?.('MCP request failed', err);
      if (!res.headersSent) this.reject(res, 500, 'Internal error');
    }
  }

  private static sameSecret(given: string | string[] | undefined, expected: string): boolean {
    const a = Buffer.from(typeof given === 'string' ? given : '');
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /**
   * `POST /launch/<agentId>` from the stdio launcher: the agent's own secret (inherited from the
   * `claude` process env) plus a one-time nonce from its mcp.json. Returns the real command, args
   * and env of that one server, then forgets the nonce.
   */
  private serveLaunch(req: IncomingMessage, res: ServerResponse, agentId: string): void {
    const agent = this.agents.get(agentId);
    if (req.method !== 'POST' || !agent) return this.reject(res, 404, 'Unknown endpoint');
    if (!OideMcpServer.sameSecret(req.headers[SECRET_HEADER], agent.secret)) return this.reject(res, 401, 'Missing or wrong secret');
    const nonce = req.headers['x-oide-launch'];
    const l = typeof nonce === 'string' ? this.launches.get(nonce) : undefined;
    if (!l || l.agentId !== agentId || l.expiresAt < Date.now()) return this.reject(res, 403, 'Unknown or used launch nonce');
    this.launches.delete(nonce as string);
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(l.spec));
  }

  // ---------------------------------------------------------------- MCP tools

  private mcpFor(agent: AgentEntry): Server {
    const backend = this.opts.artifacts;
    const server = new Server({ name: 'oide', version: '0.1.0' }, { capabilities: { tools: {}, ...(backend ? { resources: {} } : {}) } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [TOOLS.permission_prompt, TOOLS.submit_for_review, TOOLS.set_title, ...(backend ? [TOOLS.artifacts_list, TOOLS.artifacts_read, TOOLS.artifacts_write, TOOLS.artifacts_create] : [])],
    }));
    server.setRequestHandler(CallToolRequestSchema, async (req) => {
      const args = req.params.arguments ?? {};
      const meta = (req.params._meta ?? {}) as Record<string, unknown>;
      try {
        switch (req.params.name) {
          case 'permission_prompt':
            return await this.permissionPrompt(agent, args, typeof meta['claudecode/toolUseId'] === 'string' ? (meta['claudecode/toolUseId'] as string) : undefined);
          case 'submit_for_review': {
            const r = SubmitInput.safeParse(args);
            if (!r.success) return text(`Invalid input: ${r.error.message}`, true);
            agent.handlers.onReview({ summary: r.data.summary, checks: r.data.checks });
            return text('Submitted for review. The user will review your changes in oIDE. End your turn now unless they reply.');
          }
          case 'set_title': {
            const r = TitleInput.safeParse(args);
            if (!r.success) return text(`Invalid input: ${r.error.message}`, true);
            const res = agent.handlers.onTitle?.(r.data.title) ?? { ok: false as const, message: 'oIDE cannot change the title of this agent.' };
            return res.ok ? text(`Title set to "${res.title}". From now on end every commit message with the trailer line: Oide-Agent: ${res.title}. Carry on with the task.`) : text(`${res.message} Carry on with the task.`, true);
          }
          case 'artifacts_list':
          case 'artifacts_read':
          case 'artifacts_write':
          case 'artifacts_create':
            if (!backend) return text('Artifacts are not available', true);
            return await this.artifactTool(agent, req.params.name, args);
          default:
            return text(`Unknown tool ${req.params.name}`, true);
        }
      } catch (err) {
        return text(`Error: ${(err as Error).message}`, true);
      }
    });
    if (backend) {
      server.setRequestHandler(ListResourcesRequestSchema, async () => {
        const list = await backend.list(this.ctx(agent), {});
        this.logUse(agent, '*', 'list');
        return { resources: list.map((a) => ({ uri: `oide://artifacts/${a.id}`, name: a.title, mimeType: mimeFor(a.kind), description: `${a.kind} artifact` })) };
      });
      server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
        const id = /^oide:\/\/artifacts\/(.+)$/.exec(req.params.uri)?.[1];
        if (!id) throw new Error('Unknown resource');
        const r = await backend.read(this.ctx(agent), id);
        this.logUse(agent, id, 'read');
        return { contents: [{ uri: req.params.uri, mimeType: mimeFor(r.meta.kind), text: r.content }] };
      });
    }
    return server;
  }

  private ctx(agent: AgentEntry) {
    return { agentId: agent.agentId, ...(agent.projectId ? { projectId: agent.projectId } : {}) };
  }

  private logUse(agent: AgentEntry, artifactId: string, op: ArtifactUse['op']): void {
    try {
      this.opts.onArtifactUse?.({ artifactId, agentId: agent.agentId, op, ts: Date.now() });
    } catch (err) {
      this.opts.log?.('onArtifactUse threw', err);
    }
  }

  private async artifactTool(agent: AgentEntry, name: string, args: unknown): Promise<ToolResult> {
    const backend = this.opts.artifacts!;
    const ctx = this.ctx(agent);
    switch (name) {
      case 'artifacts_list': {
        const r = ListInput.safeParse(args);
        if (!r.success) return text(`Invalid input: ${r.error.message}`, true);
        const list = await backend.list(ctx, { ...(r.data.kind ? { kind: r.data.kind } : {}), ...(r.data.query ? { query: r.data.query } : {}) });
        this.logUse(agent, '*', 'list');
        return text(
          JSON.stringify(
            list.map((a) => ({
              id: a.id,
              title: a.title,
              kind: a.kind,
              version: a.version,
              location: a.location,
              ...(a.importedFrom ? { importedFrom: a.importedFrom } : {}),
              ...(a.brokenImport ? { brokenImport: true } : {}),
            })),
          ),
        );
      }
      case 'artifacts_read': {
        const r = ReadInput.safeParse(args);
        if (!r.success) return text(`Invalid input: ${r.error.message}`, true);
        const out = await backend.read(ctx, r.data.id);
        this.logUse(agent, r.data.id, 'read');
        if (out.meta.brokenImport) {
          // A link-only import from an older oIDE: its only version is a placeholder notice, not the artifact.
          return text(
            JSON.stringify({
              meta: out.meta,
              content: null,
              status: 'import-has-no-content',
              message: brokenImportMessage(out.meta.importedFrom),
            }),
          );
        }
        return text(JSON.stringify({ meta: out.meta, content: out.content }));
      }
      case 'artifacts_write': {
        const r = WriteInput.safeParse(args);
        if (!r.success) return text(`Invalid input: ${r.error.message}`, true);
        const meta = await backend.write(ctx, r.data.id, r.data.content, r.data.note);
        this.logUse(agent, r.data.id, 'write');
        return text(JSON.stringify({ ok: true, id: meta.id, version: meta.version }));
      }
      default: {
        const r = CreateInput.safeParse(args);
        if (!r.success) return text(`Invalid input: ${r.error.message}`, true);
        const meta = await backend.create(ctx, { title: r.data.title, kind: r.data.kind, content: r.data.content, location: r.data.shared ? 'repo' : 'app-data' });
        this.logUse(agent, meta.id, 'create');
        return text(JSON.stringify({ ok: true, id: meta.id, version: meta.version }));
      }
    }
  }

  private permissionPrompt(agent: AgentEntry, args: unknown, metaToolUseId: string | undefined): Promise<ToolResult> {
    const r = PermissionPromptInput.safeParse(args);
    if (!r.success) return Promise.resolve(text(JSON.stringify({ behavior: 'deny', message: 'Malformed permission request' })));
    const { tool_name: toolName, input = {}, tool_use_id } = r.data;
    const toolUseId = tool_use_id ?? metaToolUseId;
    // SEC-16: one agent cannot flood the user with prompts.
    const open = [...this.pending.values()].filter((p) => p.request.agentId === agent.agentId).length;
    if (open >= (this.opts.maxPendingPerAgent ?? 5)) {
      return Promise.resolve(text(JSON.stringify({ behavior: 'deny', message: 'Too many permission requests are waiting for the user. Wait for an answer before asking again.' })));
    }
    const requestId = `perm-${randomUUID()}`;
    const suggestedRule = suggestRule(toolName, input);
    const request: PermissionRequest = {
      requestId,
      agentId: agent.agentId,
      ...(toolUseId ? { toolUseId } : {}),
      toolName,
      input,
      summary: summarizeTool(toolName, input),
      ...(suggestedRule ? { suggestedRule } : {}),
      createdAt: Date.now(),
    };
    return new Promise<ToolResult>((resolve) => {
      const pending: Pending = {
        request,
        input,
        resolve: (result) => resolve(text(JSON.stringify(result))),
      };
      if (this.opts.permissionTimeoutMs) {
        pending.timer = setTimeout(() => this.settle(requestId, { behavior: 'deny', message: 'No answer from the user in time' }), this.opts.permissionTimeoutMs);
      }
      this.pending.set(requestId, pending);
      try {
        agent.handlers.onPermissionRequest(request);
      } catch (err) {
        this.opts.log?.('onPermissionRequest threw', err);
        this.settle(requestId, { behavior: 'deny', message: 'oIDE could not show the prompt' });
      }
    });
  }
}

function mimeFor(kind: string): string {
  return kind === 'design' ? 'text/html' : kind === 'doc' ? 'text/markdown' : 'application/json';
}
