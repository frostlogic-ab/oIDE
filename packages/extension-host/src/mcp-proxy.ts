import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import type { FetchFn, MaybePromise } from './interfaces.js';
import type { ProxyRoute } from './mcp-config.js';

/**
 * Loopback proxy for remote MCP servers (build brief, Remote servers and tokens). Agents reach
 * `http://127.0.0.1:<port>/mcp/<server>` with their own secret header; the proxy adds the
 * stored OAuth or header token, refreshes it on 401, and streams the response (JSON or SSE).
 * Tokens never leave the main process.
 */

export const AGENT_SECRET_HEADER = 'x-oide-agent-secret';

export interface ProxyUpstream {
  url: string;
  /** Auth headers to add (e.g. `{ authorization: 'Bearer …' }`). */
  headers(): MaybePromise<Record<string, string>>;
  /** Called once when upstream answers 401; true when a retry is worth it. */
  refresh?(): MaybePromise<boolean>;
}

export interface McpProxyOptions {
  resolve(server: string): MaybePromise<ProxyUpstream | undefined>;
  fetch?: FetchFn;
  /** Max request body (default 10 MB). */
  maxBodyBytes?: number;
}

const HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-authorization', 'proxy-authenticate', 'te', 'trailer', 'host', 'content-length']);
const DROP_REQ = new Set([...HOP, 'authorization', 'cookie', 'origin', 'referer', AGENT_SECRET_HEADER]);
const DROP_RES = new Set([...HOP, 'content-encoding', 'set-cookie']);

function isLoopbackAddress(a: string | undefined): boolean {
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

export function isLoopbackOrigin(origin: string): boolean {
  try {
    const u = new URL(origin);
    return (u.protocol === 'http:' || u.protocol === 'https:') && (u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]');
  } catch {
    return false;
  }
}

interface AgentGrant {
  agentId: string;
  secret: Buffer;
  servers: Set<string> | null;
}

export class McpProxy {
  private server: Server | null = null;
  private port = 0;
  private grants = new Map<string, AgentGrant>();
  private readonly fetch: FetchFn;

  constructor(private readonly o: McpProxyOptions) {
    this.fetch = o.fetch ?? globalThis.fetch.bind(globalThis);
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  urlFor(server: string): string {
    return `${this.baseUrl}/mcp/${encodeURIComponent(server)}`;
  }

  async start(port = 0): Promise<{ port: number; baseUrl: string }> {
    if (this.server) return { port: this.port, baseUrl: this.baseUrl };
    const server = createServer((req, res) => {
      this.handle(req, res).catch(() => {
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'proxy error' }));
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => resolve());
    });
    this.server = server;
    this.port = (server.address() as AddressInfo).port;
    return { port: this.port, baseUrl: this.baseUrl };
  }

  async stop(): Promise<void> {
    const s = this.server;
    this.server = null;
    if (!s) return;
    s.closeAllConnections?.();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }

  /** A fresh secret for one agent; optionally limited to some servers. Replaces any earlier one. */
  issueAgentSecret(agentId: string, servers?: string[]): string {
    this.revokeAgent(agentId);
    const secret = randomBytes(32).toString('base64url');
    this.grants.set(agentId, { agentId, secret: Buffer.from(secret), servers: servers ? new Set(servers) : null });
    return secret;
  }

  revokeAgent(agentId: string): void {
    this.grants.delete(agentId);
  }

  /** The route mcp-config needs to point an agent at this proxy. */
  routeFor(agentSecret: string): ProxyRoute {
    return { urlFor: (s) => this.urlFor(s), headerName: AGENT_SECRET_HEADER, agentSecret };
  }

  private grantFor(secret: string | undefined): AgentGrant | undefined {
    if (!secret) return undefined;
    const b = Buffer.from(secret);
    for (const g of this.grants.values()) if (g.secret.length === b.length && timingSafeEqual(g.secret, b)) return g;
    return undefined;
  }

  private deny(res: ServerResponse, status: number, message: string): void {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: message }));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!isLoopbackAddress(req.socket.remoteAddress)) return this.deny(res, 403, 'loopback only');
    const host = req.headers.host ?? '';
    if (host !== `127.0.0.1:${this.port}` && host !== `localhost:${this.port}`) return this.deny(res, 403, 'bad host');
    const origin = req.headers.origin;
    if (origin !== undefined && !isLoopbackOrigin(origin)) return this.deny(res, 403, 'origin not allowed');
    const m = /^\/mcp\/([^/?#]+)\/?(\?.*)?$/.exec(req.url ?? '');
    if (!m) return this.deny(res, 404, 'not found');
    const serverName = decodeURIComponent(m[1] as string);
    const secretHeader = req.headers[AGENT_SECRET_HEADER];
    const grant = this.grantFor(Array.isArray(secretHeader) ? secretHeader[0] : secretHeader);
    if (!grant) return this.deny(res, 401, 'missing or wrong agent secret');
    if (grant.servers && !grant.servers.has(serverName)) return this.deny(res, 403, 'server not allowed for this agent');
    const upstream = await this.o.resolve(serverName);
    if (!upstream) return this.deny(res, 404, 'unknown server');

    const body = await readBody(req, this.o.maxBodyBytes ?? 10 * 1024 * 1024);
    if (body === null) return this.deny(res, 413, 'request too large');
    const baseHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined || DROP_REQ.has(k.toLowerCase())) continue;
      baseHeaders[k] = Array.isArray(v) ? v.join(', ') : v;
    }
    const abort = new AbortController();
    res.on('close', () => abort.abort());
    const send = async () =>
      this.fetch(upstream.url, {
        method: req.method ?? 'GET',
        headers: { ...baseHeaders, ...(await upstream.headers()) },
        ...(body.length && req.method !== 'GET' && req.method !== 'HEAD' ? { body } : {}),
        signal: abort.signal,
        redirect: 'manual',
      });
    let up = await send();
    if (up.status === 401 && upstream.refresh && (await upstream.refresh())) {
      await up.body?.cancel().catch(() => undefined);
      up = await send();
    }
    const outHeaders: Record<string, string> = {};
    up.headers.forEach((v, k) => {
      if (!DROP_RES.has(k.toLowerCase())) outHeaders[k] = v;
    });
    res.writeHead(up.status, outHeaders);
    if (!up.body) {
      res.end();
      return;
    }
    const stream = Readable.fromWeb(up.body as import('node:stream/web').ReadableStream);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  }
}

function readBody(req: IncomingMessage, max: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > max) over = true;
      else chunks.push(c);
    });
    req.on('end', () => resolve(over ? null : Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Wire a CustomTools-like token source into a proxy upstream. */
export function upstreamFrom(url: string, tokens: { headers(): Promise<Record<string, string>>; refresh(): Promise<boolean> } | undefined): ProxyUpstream {
  return { url, headers: () => tokens?.headers() ?? {}, refresh: () => tokens?.refresh() ?? false };
}
