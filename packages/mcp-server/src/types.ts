import type { AgentArtifactFileInput, ArtifactFile, ArtifactFileContent, ArtifactKind, ArtifactMeta, ArtifactUse, CheckResult, PermissionRequest } from '@oide/protocol';

/**
 * Types shared with @oide/agent-core. They are declared here structurally (no dependency on
 * agent-core) so OideMcpServer satisfies agent-core's `PermissionBroker` interface as-is.
 */

export type TitleResult = { ok: true; title: string } | { ok: false; message: string };

export interface AgentToolHandlers {
  onPermissionRequest(request: PermissionRequest): void;
  /** `reason: 'quit'` when the prompt was denied because oIDE is shutting down. */
  onPermissionResolved(requestId: string, behavior: 'allow' | 'deny', reason?: 'quit'): void;
  onReview(review: { summary: string; checks: CheckResult[] }): void;
  /**
   * `set_title`: the agent names its task. Returns the title oIDE kept, or why it was refused (the
   * user gave the title, or it was empty after cleaning). Optional: without it the tool is refused.
   */
  onTitle?(title: string): TitleResult;
}

export type McpServerEntry =
  | { type: 'http' | 'sse'; url: string; headers?: Record<string, string> }
  | { type?: 'stdio'; command: string; args?: string[]; env?: Record<string, string> };

export interface ArtifactContext {
  agentId: string;
  projectId?: string;
}

/** What an agent hands over when it finishes retrieving a linked artifact (ADR 0014). */
export interface RetrievalResult {
  ok: boolean;
  /** Why it failed, in one sentence the user can act on (`ok: false`). */
  reason?: string;
  entry?: string;
  title?: string;
  kind?: ArtifactKind;
}

/**
 * Implemented in main over packages/store's artifacts store (visibility, `fromFile` resolution against
 * the calling agent's own folder, the retrieval service). Every call is logged as an ArtifactUse.
 */
export interface ArtifactsBackend {
  list(ctx: ArtifactContext, filter: { kind?: ArtifactKind; query?: string }): Promise<ArtifactMeta[]>;
  read(ctx: ArtifactContext, id: string): Promise<{ meta: ArtifactMeta; content: string }>;
  write(ctx: ArtifactContext, id: string, content: string, note?: string): Promise<ArtifactMeta>;
  create(
    ctx: ArtifactContext,
    input: { title: string; kind: ArtifactKind; content?: string; location?: 'repo' | 'app-data'; files?: AgentArtifactFileInput[]; entry?: string },
  ): Promise<ArtifactMeta>;
  /** Files of the current version (multi-file artifacts). */
  files?(ctx: ArtifactContext, id: string): Promise<ArtifactFile[]>;
  /** One file of the current version: UTF-8 text or base64. */
  readFile?(ctx: ArtifactContext, id: string, path: string): Promise<ArtifactFileContent>;
  /** Write and delete files as one new version; `content` replaces the entry file. */
  writeFiles?(
    ctx: ArtifactContext,
    id: string,
    change: { content?: string; files?: AgentArtifactFileInput[]; deletes?: string[]; entry?: string; note?: string },
  ): Promise<ArtifactMeta>;
  /** True when this agent was started by oIDE to retrieve an artifact (it then sees the retrieval tools). */
  isRetrievalAgent?(agentId: string): boolean;
  /** Stage files of a running retrieval. Refused unless `ctx.agentId` is that retrieval's agent. */
  retrievalAddFiles?(ctx: ArtifactContext, id: string, files: AgentArtifactFileInput[]): Promise<{ files: number; bytes: number }>;
  /** Finish a running retrieval: commit the staged files as one new version, or record why it failed. */
  retrievalFinish?(ctx: ArtifactContext, id: string, result: RetrievalResult): Promise<{ status: 'ready' | 'failed'; version: number; entry?: string; error?: string }>;
}

export interface OideMcpServerOptions {
  /** `<app-data>`; mcp.json files go to `<app-data>/agents/<id>/mcp.json`. */
  appDataDir: string;
  artifacts?: ArtifactsBackend;
  onArtifactUse?: (use: ArtifactUse) => void;
  /** Optional: deny a prompt nobody answered after this long. Default: wait for the user. */
  permissionTimeoutMs?: number;
  /** Port to bind on 127.0.0.1. Default 0 (random). */
  port?: number;
  log?: (message: string, detail?: unknown) => void;
  /**
   * Absolute path of a Node binary for the stdio launcher (SEC-11). Without one, secret-bearing
   * custom stdio servers fall back to env placeholders in the agent's own env.
   */
  nodeBinary?: string;
  /** Most permission prompts one agent may have open at once; more are denied at once (SEC-16). Default 5. */
  maxPendingPerAgent?: number;
}

export interface RegisterOptions {
  projectId?: string;
  /**
   * Values for the `${VAR}` placeholders of the extra servers (custom server secrets). Servers that
   * use them are started through the launcher when a Node binary is known, so the values never
   * enter the agent's env; any value no launched server consumed is returned in `env`.
   */
  secretEnv?: Record<string, string>;
}

export interface RegisteredAgent {
  agentId: string;
  url: string;
  /**
   * Per-agent secret, sent by the CLI as the `X-Oide-Secret` header. mcp.json holds only a
   * `${OIDE_MCP_HANDSHAKE}` placeholder; the value travels in this agent's env (SEC-16). Not a Claude credential.
   */
  secret: string;
  mcpConfigPath: string;
  /**
   * Env the agent's `claude` process must carry: its own secret (expanded by the CLI into the
   * mcp.json header placeholder), header values of other http servers, leftover secret values.
   */
  env: Record<string, string>;
}
