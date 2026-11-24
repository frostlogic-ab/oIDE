import type { ArtifactKind, ArtifactMeta, ArtifactUse, CheckResult, PermissionRequest } from '@oide/protocol';

/**
 * Types shared with @oide/agent-core. They are declared here structurally (no dependency on
 * agent-core) so OideMcpServer satisfies agent-core's `PermissionBroker` interface as-is.
 */

export interface AgentToolHandlers {
  onPermissionRequest(request: PermissionRequest): void;
  onPermissionResolved(requestId: string, behavior: 'allow' | 'deny'): void;
  onReview(review: { summary: string; checks: CheckResult[] }): void;
}

export type McpServerEntry =
  | { type: 'http' | 'sse'; url: string; headers?: Record<string, string> }
  | { type?: 'stdio'; command: string; args?: string[]; env?: Record<string, string> };

export interface ArtifactContext {
  agentId: string;
  projectId?: string;
}

/** Implemented by packages/store's artifacts store. Every call is logged as an ArtifactUse. */
export interface ArtifactsBackend {
  list(ctx: ArtifactContext, filter: { kind?: ArtifactKind; query?: string }): Promise<ArtifactMeta[]>;
  read(ctx: ArtifactContext, id: string): Promise<{ meta: ArtifactMeta; content: string }>;
  write(ctx: ArtifactContext, id: string, content: string, note?: string): Promise<ArtifactMeta>;
  create(ctx: ArtifactContext, input: { title: string; kind: ArtifactKind; content: string; location?: 'repo' | 'app-data' }): Promise<ArtifactMeta>;
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
