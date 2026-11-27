import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { isAbsolute, join } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListResourcesRequestSchema, ListToolsRequestSchema, ReadResourceRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { AgentArtifactFileInput, ARTIFACT_LIMITS, ArtifactKind, ArtifactPath, PermissionAnswer, type ArtifactMeta, type ArtifactUse, type CheckResult, type PermissionRequest } from '@oide/protocol';
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
/** Largest MCP request body: a batch of files is base64 in JSON (the SDK's own default is 4 MB). */
const MAX_BODY = 16 * 1024 * 1024;
/** Largest file `artifacts_read` returns (bigger ones would only flood the agent's context). */
const MAX_READ_FILE = 4 * 1024 * 1024;

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
  /** A malformed draft is dropped, not a reason to refuse the review. */
  pr: z
    .object({ title: z.string().trim().min(1).max(300), body: z.string().max(60_000).default('') })
    .optional()
    .catch(undefined),
});
const TitleInput = z.object({ title: z.string().min(1).max(1000) });
const ListInput = z.object({ kind: ArtifactKind.optional(), query: z.string().optional() });
const ReadInput = z.object({ id: z.string().min(1), path: ArtifactPath.optional() });
const FileInputs = z.array(AgentArtifactFileInput).max(ARTIFACT_LIMITS.files);
/** One exact search-and-replace inside a text file of the artifact (the entry file when `path` is left out). */
const TextEdit = z.object({
  path: ArtifactPath.optional(),
  oldString: z.string().min(1).max(ARTIFACT_LIMITS.fileBytes),
  newString: z.string().max(ARTIFACT_LIMITS.fileBytes),
  replaceAll: z.boolean().optional(),
});
export type TextEdit = z.infer<typeof TextEdit>;
const WriteInput = z
  .object({
    id: z.string().min(1),
    content: z.string().optional(),
    files: FileInputs.optional(),
    edits: z.array(TextEdit).max(200).optional(),
    deletes: z.array(ArtifactPath).max(ARTIFACT_LIMITS.files).optional(),
    entry: ArtifactPath.optional(),
    note: z.string().max(500).optional(),
  })
  .refine((w) => w.content !== undefined || !!w.files?.length || !!w.edits?.length || !!w.deletes?.length || w.entry !== undefined, 'Give content, files, edits, deletes or entry');

/**
 * Apply exact search-and-replace edits to a file's text, in order. Each `oldString` must occur
 * exactly once (or `replaceAll`); otherwise the whole write is refused with a reason the agent can act on.
 */
export function applyTextEdits(path: string, text: string, edits: ReadonlyArray<Pick<TextEdit, 'oldString' | 'newString' | 'replaceAll'>>): string {
  let out = text;
  for (const e of edits) {
    let count = 0;
    for (let i = out.indexOf(e.oldString); i !== -1; i = out.indexOf(e.oldString, i + e.oldString.length)) count++;
    if (count === 0) throw new Error(`oldString was not found in ${path}. Read the file again (the user may have changed it) and retry with its exact text.`);
    if (count > 1 && !e.replaceAll) throw new Error(`oldString occurs ${count} times in ${path}. Give more surrounding text so it is unique, or set replaceAll.`);
    out = e.replaceAll ? out.split(e.oldString).join(e.newString) : out.replace(e.oldString, () => e.newString);
  }
  return out;
}
const CreateInput = z
  .object({ title: z.string().min(1), kind: ArtifactKind, content: z.string().optional(), files: FileInputs.optional(), entry: ArtifactPath.optional(), shared: z.boolean().optional() })
  .refine((c) => c.content !== undefined || !!c.files?.length, 'Give content or files');
const AddFilesInput = z.object({ id: z.string().min(1), files: FileInputs.min(1) });
const FinishInput = z.object({
  id: z.string().min(1),
  ok: z.boolean(),
  reason: z.string().max(2000).optional(),
  entry: ArtifactPath.optional(),
  title: z.string().max(200).optional(),
  kind: ArtifactKind.optional(),
});

/** JSON schema of one file handed to oIDE (AgentArtifactFileInput). */
const FILE_SCHEMA = {
  type: 'object',
  properties: {
    path: { type: 'string', description: 'Relative path inside the artifact, forward slashes (e.g. "shots/home.png").' },
    content: { type: 'string', description: 'UTF-8 text content.' },
    base64: { type: 'string', description: 'Binary content, base64.' },
    fromFile: { type: 'string', description: 'A file you saved inside your working folder (relative to it, or absolute inside it).' },
  },
  required: ['path'],
} as const;

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
        pr: {
          type: 'object',
          description:
            "The pull request this branch would be opened with, written to the project's own conventions (its PR template, title rules such as Conventional Commits, CONTRIBUTING.md, CLAUDE.md or AGENTS.md). oIDE uses it when the user opens a pull request.",
          properties: {
            title: { type: 'string', description: "PR title in the project's title convention." },
            body: { type: 'string', description: "PR description (markdown) following the project's PR template, every section filled in." },
          },
          required: ['title', 'body'],
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
      "Read an oIDE artifact by id. Returns its metadata and the entry file's content; an artifact with several files also lists them in `files` (read one with `path`; binary files come back as base64). " +
      "content is null when status is 'retrieving' (an oIDE agent is still retrieving it from claude.ai), 'retrieval-failed', or 'import-has-no-content' (an old claude.ai import whose content never arrived): do not build from it.",
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, path: { type: 'string', description: 'Read this file of the artifact instead of the entry.' } }, required: ['id'] },
    annotations: { readOnlyHint: true },
  },
  artifacts_write: {
    name: 'artifacts_write',
    description:
      'Write a new version of an oIDE artifact. `content` replaces the entry file; `files` add or replace files (text as content, binary as base64, or fromFile for a file in your working folder); `edits` changes text files in place with exact search and replace ({ path (default: the entry file), oldString, newString, replaceAll }; each oldString must be unique in the file unless replaceAll); `deletes` removes files; `entry` moves the entry. Everything in one call becomes one version. A design opens on HTML or React component source (JSX, export default).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        content: { type: 'string' },
        files: { type: 'array', items: FILE_SCHEMA },
        edits: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'The text file to change (relative path); the entry file when left out.' },
              oldString: { type: 'string', description: 'Exact text to find; must occur once unless replaceAll.' },
              newString: { type: 'string' },
              replaceAll: { type: 'boolean' },
            },
            required: ['oldString', 'newString'],
          },
        },
        deletes: { type: 'array', items: { type: 'string' } },
        entry: { type: 'string' },
        note: { type: 'string' },
      },
      required: ['id'],
    },
  },
  artifacts_create: {
    name: 'artifacts_create',
    description:
      'Create a new oIDE artifact. kind: design (HTML, or React component source with export default), doc (Markdown) or whiteboard (Excalidraw JSON). Give `content` for one file, or `files` (and `entry`, the file it opens on) for several. shared=true stores it in the repo.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        kind: { type: 'string', enum: ['design', 'doc', 'whiteboard'] },
        content: { type: 'string' },
        files: { type: 'array', items: FILE_SCHEMA },
        entry: { type: 'string' },
        shared: { type: 'boolean' },
      },
      required: ['title', 'kind'],
    },
  },
  artifact_retrieval_add_files: {
    name: 'artifact_retrieval_add_files',
    description:
      'Only for the agent oIDE started to retrieve a claude.ai artifact: hand oIDE a batch of its files (keep each call under about 8 MB; use fromFile for big files). Text as content, binary as base64, or fromFile for a file you saved in your working folder. A path given again replaces that file. Nothing reaches the user until artifact_retrieval_finish.',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'The oIDE artifact id from your task.' }, files: { type: 'array', items: FILE_SCHEMA } }, required: ['id', 'files'] },
  },
  artifact_retrieval_finish: {
    name: 'artifact_retrieval_finish',
    description:
      'Only for the agent oIDE started to retrieve a claude.ai artifact: finish it. ok=true with entry (the file to open first, e.g. index.html), title and kind (design, doc or whiteboard) makes the files handed over the next version. ok=false with reason (one sentence the user can act on) records why it could not be retrieved.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        ok: { type: 'boolean' },
        reason: { type: 'string' },
        entry: { type: 'string' },
        title: { type: 'string' },
        kind: { type: 'string', enum: ['design', 'doc', 'whiteboard'] },
      },
      required: ['id', 'ok'],
    },
  },
} as const;

/** What an agent is told when it reads a claude.ai import that never got its content. */
export function brokenImportMessage(link: string | undefined): string {
  return (
    `This artifact was imported from ${link ?? 'claude.ai'} without its content: it holds only a placeholder notice, so do not build from it. ` +
    "Tell the user to open it in oIDE (Artifacts) and press Update: oIDE then starts an agent that retrieves the files with the Claude Code CLI's claude.ai tools. " +
    "They can also drop the files they downloaded from claude.ai, or paste the artifact's code."
  );
}

/** What an agent is told when it reads a linked artifact that has no files yet (version 0). */
export function noFilesYetMessage(meta: ArtifactMeta): string {
  const link = meta.importedFrom ?? 'claude.ai';
  if (meta.retrieval?.status === 'failed') {
    return (
      `This artifact has no files: retrieving it from ${link} failed${meta.retrieval.error ? ` (${meta.retrieval.error})` : ''}. ` +
      'Do not build from it. Tell the user; they can retry the retrieval in oIDE (Artifacts), or drop the files they downloaded.'
    );
  }
  return `An oIDE agent is still retrieving this artifact from ${link}; it has no files yet. Do not build from it: wait, or tell the user it is still being retrieved.`;
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

      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true, maxRequestBodySize: MAX_BODY });
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
      tools: [
        TOOLS.permission_prompt,
        TOOLS.submit_for_review,
        TOOLS.set_title,
        ...(backend ? [TOOLS.artifacts_list, TOOLS.artifacts_read, TOOLS.artifacts_write, TOOLS.artifacts_create] : []),
        ...(backend?.retrievalAddFiles && backend.isRetrievalAgent?.(agent.agentId) ? [TOOLS.artifact_retrieval_add_files, TOOLS.artifact_retrieval_finish] : []),
      ],
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
            agent.handlers.onReview({ summary: r.data.summary, checks: r.data.checks, ...(r.data.pr ? { pr: r.data.pr } : {}) });
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
          case 'artifact_retrieval_add_files':
          case 'artifact_retrieval_finish':
            if (!backend?.retrievalAddFiles || !backend.retrievalFinish) return text('Artifact retrieval is not available', true);
            return await this.retrievalTool(agent, req.params.name, args);
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
        if (r.data.path !== undefined) {
          if (!backend.readFile) return text('Reading one file is not available', true);
          const f = await backend.readFile(ctx, r.data.id, r.data.path);
          this.logUse(agent, r.data.id, 'read');
          if (f.data.length > MAX_READ_FILE) return text(`${r.data.path} is too large to read here (${Math.round(f.data.length / 1024)} KB).`, true);
          return text(JSON.stringify({ id: r.data.id, path: r.data.path, encoding: f.encoding, [f.encoding === 'utf8' ? 'content' : 'base64']: f.data }));
        }
        const out = await backend.read(ctx, r.data.id);
        this.logUse(agent, r.data.id, 'read');
        if (out.meta.version === 0) {
          const status = out.meta.retrieval?.status === 'failed' ? 'retrieval-failed' : 'retrieving';
          return text(JSON.stringify({ meta: out.meta, content: null, status, message: noFilesYetMessage(out.meta) }));
        }
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
        const files = (out.meta.fileCount ?? 1) > 1 && backend.files ? await backend.files(ctx, r.data.id) : undefined;
        return text(JSON.stringify({ meta: out.meta, content: out.content, ...(files ? { files } : {}) }));
      }
      case 'artifacts_write': {
        const r = WriteInput.safeParse(args);
        if (!r.success) return text(`Invalid input: ${r.error.message}`, true);
        const { id, content, deletes, entry, note, edits } = r.data;
        let files = r.data.files;
        if (edits?.length) {
          if (!backend.readFile || !backend.writeFiles) return text('Editing files is not available', true);
          const current = await backend.read(ctx, id);
          const byPath = new Map<string, TextEdit[]>();
          for (const e of edits) {
            const p = e.path ?? current.meta.entry;
            byPath.set(p, [...(byPath.get(p) ?? []), e]);
          }
          const changed: AgentArtifactFileInput[] = [];
          for (const [p, list] of byPath) {
            if (files?.some((f) => f.path === p)) return text(`${p} is both in files and in edits. Use one of them for a file.`, true);
            if (content !== undefined && p === current.meta.entry) return text('content and edits both change the entry file. Use one of them.', true);
            if (deletes?.includes(p)) return text(`${p} is both edited and deleted.`, true);
            const f = await backend.readFile(ctx, id, p);
            if (f.encoding !== 'utf8') return text(`${p} is a binary file; replace it with files instead.`, true);
            changed.push({ path: p, content: applyTextEdits(p, f.data, list) });
          }
          files = [...(files ?? []), ...changed];
        }
        let meta: ArtifactMeta;
        if (files?.length || deletes?.length || entry !== undefined) {
          if (!backend.writeFiles) return text('Writing files is not available', true);
          meta = await backend.writeFiles(ctx, id, { ...(content !== undefined ? { content } : {}), ...(files ? { files } : {}), ...(deletes ? { deletes } : {}), ...(entry ? { entry } : {}), ...(note ? { note } : {}) });
        } else meta = await backend.write(ctx, id, content!, note);
        this.logUse(agent, id, 'write');
        return text(JSON.stringify({ ok: true, id: meta.id, version: meta.version, entry: meta.entry, ...(meta.fileCount !== undefined ? { files: meta.fileCount } : {}) }));
      }
      default: {
        const r = CreateInput.safeParse(args);
        if (!r.success) return text(`Invalid input: ${r.error.message}`, true);
        const { title, kind, content, files, entry, shared } = r.data;
        const meta = await backend.create(ctx, { title, kind, ...(content !== undefined ? { content } : {}), ...(files?.length ? { files } : {}), ...(entry ? { entry } : {}), location: shared ? 'repo' : 'app-data' });
        this.logUse(agent, meta.id, 'create');
        return text(JSON.stringify({ ok: true, id: meta.id, version: meta.version, entry: meta.entry }));
      }
    }
  }

  /** The two tools of an artifact retrieval (ADR 0014); main refuses any agent but the retrieval's own. */
  private async retrievalTool(agent: AgentEntry, name: string, args: unknown): Promise<ToolResult> {
    const backend = this.opts.artifacts!;
    const ctx = this.ctx(agent);
    if (name === 'artifact_retrieval_add_files') {
      const r = AddFilesInput.safeParse(args);
      if (!r.success) return text(`Invalid input: ${r.error.message}`, true);
      const out = await backend.retrievalAddFiles!(ctx, r.data.id, r.data.files);
      this.logUse(agent, r.data.id, 'write');
      return text(JSON.stringify({ ok: true, staged: r.data.files.length, files: out.files, bytes: out.bytes }));
    }
    const r = FinishInput.safeParse(args);
    if (!r.success) return text(`Invalid input: ${r.error.message}`, true);
    const { id, ...result } = r.data;
    const out = await backend.retrievalFinish!(ctx, id, result);
    this.logUse(agent, id, 'write');
    if (out.status === 'failed' && result.ok) return text(`oIDE could not use the files: ${out.error ?? 'unknown error'}. The retrieval is marked as failed. End your turn.`, true);
    return text(JSON.stringify({ ok: true, ...out, next: 'The retrieval is finished. End your turn now; do not change the repository.' }));
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
