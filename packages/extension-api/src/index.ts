/**
 * @oide/extension-api: the typed surface oIDE extensions are written against.
 *
 * An extension's host entry (`oide.main` in package.json) is an ES module that exports
 * `activate(ctx)` and, optionally, `deactivate()`. oIDE runs it in a separate extension host
 * process and builds `ctx` there; every call below crosses a message channel to oIDE's main
 * process, which checks it against the extension's manifest and the projects it is enabled for.
 *
 * This package has no runtime dependencies. It is mostly types plus a few helpers.
 */

/** Version of this API. Manifests declare a range for it in `oide.engine` (for example `^1.0.0`). */
export const API_VERSION = '1.0.0';

/** Something that can be cleaned up. Push these onto `ctx.subscriptions` to have oIDE dispose them on deactivate. */
export interface Disposable {
  dispose(): void;
}

export type CommandHandler = (...args: unknown[]) => unknown | Promise<unknown>;

export interface CommandsApi {
  /**
   * Register the handler for a command. Commands shown in Ctrl K must also be listed in
   * `oide.contributes.commands`; registering an id the manifest does not declare still works for
   * calls from your own panels.
   */
  register(id: string, handler: CommandHandler): Disposable;
}

export type SettingValue = string | number | boolean | null;

export interface SettingsApi {
  /**
   * Read one of this extension's settings. Settings declared with `secret: true` are read from the
   * OS keychain; you only ever see your own extension's secrets.
   */
  get<T extends SettingValue = SettingValue>(key: string): Promise<T | undefined>;
  /** Write one of this extension's settings (secret ones go to the OS keychain). */
  set(key: string, value: SettingValue): Promise<void>;
}

export type AgentStatus =
  | 'queued'
  | 'starting'
  | 'running'
  | 'needs-permission'
  | 'has-question'
  | 'ready-for-review'
  | 'paused'
  | 'stopped'
  | 'rate-limited'
  | 'error'
  | 'done'
  | (string & {});

/** What an extension may know about an agent. Only agents in projects where the extension is enabled are listed. */
export interface AgentInfo {
  id: string;
  projectId: string;
  title: string;
  status: AgentStatus;
  model: string;
  branch?: string;
  worktreePath?: string;
}

/** A normalized agent event (`init`, `assistant-text`, `tool-use`, `tool-result`, `status`, …). */
export interface AgentEventInfo {
  agentId: string;
  type: string;
  seq: number;
  ts: number;
  [field: string]: unknown;
}

export interface AgentsApi {
  /** Agents in projects where this extension is enabled. */
  list(filter?: { projectId?: string }): Promise<AgentInfo[]>;
  /** Subscribe to agent events from projects where this extension is enabled. */
  onEvent(listener: (event: AgentEventInfo) => void): Disposable;
  /** Send a user message to an agent, as if typed in its tile. */
  postMessage(agentId: string, text: string): Promise<void>;
}

export interface PanelsApi {
  /** Open one of this extension's panels (`oide.contributes.panels[].id`). */
  open(panelId: string, options?: { agentId?: string; projectId?: string }): Promise<void>;
  /** Send data to an open panel; it arrives in the iframe as a `message` event. */
  postMessage(panelId: string, data: unknown): Promise<void>;
  /** Receive data a panel sent with `parent.postMessage`. */
  onMessage(panelId: string, listener: (data: unknown) => void): Disposable;
}

export interface ArtifactContent {
  id: string;
  title: string;
  kind: string;
  content: string;
  version?: string | number;
}

export interface ArtifactsApi {
  read(id: string): Promise<ArtifactContent>;
}

export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export interface ExtensionInfo {
  name: string;
  version: string;
  /** Absolute path of the extension's package folder. */
  path: string;
}

export interface ExtensionContext {
  readonly extension: ExtensionInfo;
  /** The activation event that started this extension (`onStartup`, `onAgentSpawn`, `onCommand:<id>`). */
  readonly activationEvent: string;
  readonly commands: CommandsApi;
  readonly settings: SettingsApi;
  readonly agents: AgentsApi;
  readonly panels: PanelsApi;
  readonly artifacts: ArtifactsApi;
  readonly log: Logger;
  /** Disposed by oIDE when the extension deactivates. */
  readonly subscriptions: Disposable[];
}

/** The shape of an extension's host module. */
export interface ExtensionModule {
  activate?(ctx: ExtensionContext): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}

/** Identity helper that gives plain-JS and TS extensions full typing: `export default defineExtension({ activate(ctx) {…} })`. */
export function defineExtension(module: ExtensionModule): ExtensionModule {
  return module;
}

/** Activation events understood by oIDE. */
export type ActivationEvent = 'onStartup' | 'onAgentSpawn' | `onCommand:${string}` | '*';
