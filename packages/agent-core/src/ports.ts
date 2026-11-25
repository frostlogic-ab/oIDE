import type {
  AgentEvent,
  AgentSpec,
  AgentSummary,
  CheckResult,
  CliInfo,
  CustomModel,
  MessageAttachment,
  PermissionAnswer,
  PermissionRequest,
  Settings,
  Technique,
} from '@oide/protocol';
import type { ExtensionToolRef } from './args.js';
import type { ArtifactResolver } from './messages.js';

/**
 * Dependencies the Supervisor needs from the rest of main. Implemented by other packages:
 * WorktreeProvider (packages/git), EventSink + SettingsProvider + SecretProvider (packages/store,
 * apps/desktop main), PermissionBroker (packages/mcp-server's OideMcpServer satisfies it structurally).
 */

export interface WorktreeResult {
  /** Absolute path the agent runs in (its worktree, or the project folder for workIn=project-folder). */
  path: string;
  branch?: string;
  baseRef?: string;
}

export interface WorktreeProvider {
  /** Create the agent's worktree (`git worktree add -b oide/<slug> <path> <base>`), or return the project folder. */
  create(input: { agentId: string; slug: string; spec: AgentSpec }): Promise<WorktreeResult>;
  /** Run `.oide/setup` (only for trusted projects; the provider decides). Output lines go to the tile. */
  runSetup?(input: { agentId: string; path: string; spec: AgentSpec; onStart?: () => void; onOutput?: (line: string) => void }): Promise<{ ok: boolean; output?: string }>;
  /** `git worktree remove` + branch delete, used by `remove(agentId, { deleteWorktree: true })`. */
  remove?(input: { agentId: string; path: string; branch?: string; projectId: string }): Promise<void>;
}

export interface EventSink {
  /** Persist one normalized event plus the raw stdout JSON it came from (when any). */
  append(event: AgentEvent, raw?: string): void | Promise<void>;
  /** Optional: every stdout line, including lines that produce no events (hooks, message_start, …). */
  appendRaw?(agentId: string, line: string): void | Promise<void>;
  /** Persist the latest summary and spec so agents can be restored after an app restart. */
  saveSummary?(summary: AgentSummary, spec: AgentSpec): void | Promise<void>;
  removeAgent?(agentId: string): void | Promise<void>;
}

export interface ProjectInfo {
  path: string;
  trusted: boolean;
  /** `.oide/permissions.json`. */
  rules?: { allow: string[]; ask?: string[]; deny: string[] };
}

export type McpServerEntry =
  | { type: 'http' | 'sse'; url: string; headers?: Record<string, string> }
  | { type?: 'stdio'; command: string; args?: string[]; env?: Record<string, string> };

export interface SettingsProvider {
  get(): Settings | Promise<Settings>;
  cli(): CliInfo | Promise<CliInfo>;
  /** Techniques available for this project, in Settings order (global then project). */
  techniques?(projectId: string): Technique[] | Promise<Technique[]>;
  project?(projectId: string): ProjectInfo | undefined | Promise<ProjectInfo | undefined>;
  /** Extension and custom-server tools for this agent, with risk labels. */
  extensionTools?(spec: AgentSpec, agentId: string): ExtensionToolRef[] | Promise<ExtensionToolRef[]>;
  /** Extension / custom MCP servers to merge into the agent's mcp.json (never named `oide`). */
  extraMcpServers?(spec: AgentSpec, agentId: string): Record<string, McpServerEntry> | Promise<Record<string, McpServerEntry>>;
  /**
   * Extra env for this agent's process on every launch: values for the `${VAR}` placeholders of
   * custom MCP servers (from oIDE's keychain store). Never Claude credentials; never written to disk.
   */
  extraEnv?(spec: AgentSpec, agentId: string): Record<string, string> | Promise<Record<string, string>>;
  customModel?(id: string): CustomModel | undefined | Promise<CustomModel | undefined>;
  /** "Always in <project>": save an allow rule (e.g. `Bash(npm test)`) to `.oide/permissions.json`. */
  addAllowRule?(projectId: string, rule: string): void | Promise<void>;
  resolveArtifact?: ArtifactResolver;
}

/**
 * Prepares a message's attachments in the agent's folder before they reach the CLI: copies picked or
 * dropped files under `.oide/attachments/` and returns them with paths relative to `cwd`. Images pass
 * through. Implemented in main; without it, file attachments keep the paths they came with.
 */
export interface AttachmentProvider {
  materialize(input: { agentId: string; projectId: string; cwd: string; attachments: readonly MessageAttachment[] }): Promise<MessageAttachment[]>;
}

export interface SecretProvider {
  /** Key of a custom model endpoint from oIDE's keychain store. Never Claude credentials. */
  customModelKey(customModelId: string): Promise<string | undefined>;
}

/** Callbacks the MCP server calls for one agent. */
export interface AgentToolHandlers {
  onPermissionRequest(request: PermissionRequest): void;
  /** `reason: 'quit'` when oIDE denied the prompt because it was closing. */
  onPermissionResolved(requestId: string, behavior: 'allow' | 'deny', reason?: 'quit'): void;
  onReview(review: { summary: string; checks: CheckResult[] }): void;
}

export interface PermissionBroker {
  /**
   * Create the agent's endpoint and write `<app-data>/agents/<id>/mcp.json`. Called on every
   * launch. `secretEnv` holds custom-server secrets for `${VAR}` placeholders; the broker keeps what
   * it can out of the agent env (stdio launcher, SEC-11) and returns in `env` what the agent process
   * must carry (its own MCP secret for the header placeholder, SEC-16, plus leftovers).
   */
  registerAgent(
    agentId: string,
    handlers: AgentToolHandlers,
    extraServers?: Record<string, McpServerEntry>,
    options?: { projectId?: string; secretEnv?: Record<string, string> },
  ): Promise<{ mcpConfigPath: string; env?: Record<string, string> }>;
  /** Deny the agent's pending prompts and drop its endpoint. */
  unregisterAgent(agentId: string): Promise<void>;
  /** Resolve a pending prompt. Returns false unless `requestId` is exactly a pending id. */
  answer(requestId: string, answer: PermissionAnswer): boolean;
}
