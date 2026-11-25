import { z } from 'zod';
import { AgentSpec, AgentSummary, GitRef, Id, MessageAttachments, PermissionAnswer, PermissionMode, UserMessage } from './agent.js';
import { ArtifactKind, ArtifactMeta, ArtifactUse, ArtifactVersion } from './artifacts.js';
import { AgentEvent } from './events.js';
import { CustomServer, ExtensionSettingField, ExtensionSettingValue, ExtensionUpdate, InstalledExtension, MarketplaceEntry } from './extensions.js';
import { CommitInfo, FileDiff, FileNode, OverlapWarning, Project, ReviewComment, SyncState, WorktreeInfo } from './project.js';
import { CliInfo, CustomModel, FocusPreset, Settings, Technique } from './settings.js';
import { UpdateStatus } from './updates.js';
import { FindByNameInput, FindByNameOutput, ReplaceInput, ReplaceOutput, SearchContentInput, SearchResultsEvent } from './search.js';

/**
 * The IPC contract. Every renderer → main command is a request/response pair, validated with Zod
 * in main (input) and optionally in the renderer (output). Every main → renderer event is streamed.
 *
 * Preload exposes exactly one object, `window.oide`:
 *   window.oide.invoke(command, input) → Promise<output>
 *   window.oide.on(event, listener) → unsubscribe
 * No `ipcRenderer` leaks into React code.
 */

const cmd = <I extends z.ZodType, O extends z.ZodType>(input: I, output: O) => ({ input, output });
const Void = z.void().or(z.undefined()).or(z.null());
const Ok = z.object({ ok: z.literal(true) });

/** One row of Settings › Diagnostics. Values are redacted (home folder → `~`, no tokens). */
export const DiagnosticCheck = z.object({
  id: z.string(),
  label: z.string(),
  status: z.enum(['ok', 'warn', 'error', 'info']),
  value: z.string(),
  detail: z.string().optional(),
});
export type DiagnosticCheck = z.infer<typeof DiagnosticCheck>;
export const Diagnostics = z.object({ generatedAt: z.string(), checks: z.array(DiagnosticCheck), report: z.string() });
export type Diagnostics = z.infer<typeof Diagnostics>;

/** Files picked in `dialog.pickFiles` or dropped on an input (`OideBridge.attachDropped`). */
export const PickedAttachments = z.object({
  attachments: MessageAttachments,
  rejected: z.array(z.object({ name: z.string(), reason: z.string() })).default([]),
});
export type PickedAttachments = z.infer<typeof PickedAttachments>;

export const Scope = z.union([z.literal('all'), Id]);
export type Scope = z.infer<typeof Scope>;

export const Commands = {
  // App / CLI
  'app.info': cmd(Void, z.object({ version: z.string(), platform: z.string(), userData: z.string() })),
  /** Settings › Diagnostics: CLI, git ≥ 2.38, gh, node, keychain, database, MCP port, logs; `report` is the copyable text. */
  'app.diagnostics': cmd(Void, Diagnostics),
  /** Settings › Diagnostics › Open logs folder (`<userData>/logs`). */
  'app.openLogsFolder': cmd(Void, Ok),
  /** A screen's error boundary caught an error; main writes it (redacted) to the main log. No props, state, prompts or code. */
  'app.reportError': cmd(z.object({ screen: z.string().max(60), name: z.string().max(120), message: z.string().max(2000), stack: z.string().max(8000).optional(), componentStack: z.string().max(8000).optional() }), Ok),
  'cli.detect': cmd(Void, CliInfo),
  'cli.openSignIn': cmd(Void, z.object({ terminalId: Id })),

  // Projects
  'projects.list': cmd(Void, z.array(Project)),
  'projects.open': cmd(z.object({ path: z.string().optional() }), Project.nullable()),
  'projects.remove': cmd(z.object({ projectId: Id }), Ok),
  'projects.trust': cmd(z.object({ projectId: Id, trusted: z.boolean() }), Project),
  'scope.get': cmd(Void, Scope),
  'scope.set': cmd(z.object({ scope: Scope }), Scope),

  // Agents
  'agents.list': cmd(Void, z.array(AgentSummary)),
  'agents.spawn': cmd(AgentSpec, z.array(AgentSummary)),
  'agents.send': cmd(z.object({ agentId: Id, message: UserMessage }), Ok),
  'agents.answerPermission': cmd(z.object({ agentId: Id, answer: PermissionAnswer }), Ok),
  'agents.setMode': cmd(z.object({ agentId: Id, mode: PermissionMode }), Ok),
  'agents.stop': cmd(z.object({ agentId: Id }), Ok),
  'agents.pause': cmd(z.object({ agentId: Id }), Ok),
  'agents.resume': cmd(z.object({ agentId: Id }), Ok),
  'agents.compact': cmd(z.object({ agentId: Id }), Ok),
  'agents.remove': cmd(z.object({ agentId: Id, deleteWorktree: z.boolean().default(false) }), Ok),
  'agents.events': cmd(
    z.object({ agentId: Id, beforeSeq: z.number().int().optional(), limit: z.number().int().min(1).max(5000).default(500) }),
    z.array(AgentEvent),
  ),
  'agents.stopSubagent': cmd(z.object({ agentId: Id, subagentId: Id }), Ok),
  // Archived agents: finished, merged, discarded or archived by hand. Row, summary and transcript stay.
  /** Archive a finished or stopped agent (Wall tile, Focus header). Refused while it works (`conflict`). */
  'agents.archive': cmd(z.object({ agentId: Id }), AgentSummary),
  /** Back to the Wall; resumable when its session and worktree still exist (else `resumeBlocked`). */
  'agents.unarchive': cmd(z.object({ agentId: Id }), AgentSummary),
  /** Archived agents, most recently archived first, paged with `cursor` (the last item's `archived.at` and id). */
  'agents.listArchived': cmd(
    z.object({
      projectId: Id.optional(),
      query: z.string().max(200).optional(),
      limit: z.number().int().min(1).max(200).default(50),
      cursor: z.object({ at: z.number(), id: Id }).optional(),
    }),
    z.object({ items: z.array(AgentSummary), total: z.number().int().nonnegative(), nextCursor: z.object({ at: z.number(), id: Id }).optional() }),
  ),
  /** One archived agent (Focus opens it read-only, transcript from `agents.events`). */
  'agents.getArchived': cmd(z.object({ agentId: Id }), AgentSummary),
  /** Delete the agent's row and events after a native confirmation in main; `deleted: false` when the user cancels. */
  'agents.deletePermanently': cmd(z.object({ agentId: Id }), z.object({ deleted: z.boolean() })),

  // Git / source control
  'git.sync': cmd(z.object({ projectId: Id }), SyncState),
  'git.fetch': cmd(z.object({ projectId: Id }), SyncState),
  'git.pull': cmd(z.object({ projectId: Id }), SyncState),
  'git.push': cmd(z.object({ projectId: Id }), SyncState),
  'git.commit': cmd(z.object({ projectId: Id, message: z.string().min(1), files: z.array(z.string()).optional() }), CommitInfo),
  'git.log': cmd(z.object({ projectId: Id, ref: GitRef.default('HEAD'), limit: z.number().int().default(20) }), z.array(CommitInfo)),
  'git.worktrees': cmd(z.object({ projectId: Id }), z.array(WorktreeInfo)),
  'git.overlaps': cmd(z.object({ projectId: Id }), z.array(OverlapWarning)),
  'git.diff': cmd(z.object({ agentId: Id }), z.array(FileDiff)),
  'git.mergeLocal': cmd(z.object({ agentId: Id }), z.object({ ok: z.boolean(), conflicts: z.array(z.string()).default([]) })),
  'git.openPr': cmd(z.object({ agentId: Id, title: z.string(), body: z.string().default('') }), z.object({ url: z.string() })),
  'git.reconcile': cmd(z.object({ projectId: Id, agentIds: z.tuple([Id, Id]) }), z.array(AgentSummary)),
  'git.pruneOrphans': cmd(z.object({ projectId: Id }), z.object({ removed: z.array(z.string()) })),
  /** Whether PRs can be opened for this project (gh installed and signed in). Source control hides PR state and Review disables Open pull request when false. */
  'git.prAvailable': cmd(z.object({ projectId: Id }), z.object({ available: z.boolean(), reason: z.string().optional() })),

  // Review
  'review.comments': cmd(z.object({ agentId: Id }), z.array(ReviewComment)),
  'review.addComment': cmd(z.object({ agentId: Id, path: z.string(), line: z.number().int().optional(), side: z.enum(['old', 'new']).default('new'), body: z.string().min(1) }), ReviewComment),
  'review.deleteComment': cmd(z.object({ commentId: Id }), Ok),
  'review.sendFeedback': cmd(z.object({ agentId: Id, note: z.string().optional() }), Ok),
  'review.setViewed': cmd(z.object({ agentId: Id, path: z.string(), viewed: z.boolean() }), Ok),
  'review.viewed': cmd(z.object({ agentId: Id }), z.array(z.string())),

  // Files
  'files.tree': cmd(z.object({ root: z.string(), dir: z.string().default('') }), z.array(FileNode)),
  'files.read': cmd(z.object({ root: z.string(), path: z.string() }), z.object({ content: z.string(), binary: z.boolean() })),
  'files.write': cmd(z.object({ root: z.string(), path: z.string(), content: z.string() }), Ok),
  'files.history': cmd(z.object({ root: z.string(), path: z.string() }), z.array(CommitInfo)),
  'files.editingAgents': cmd(z.object({ path: z.string() }), z.array(Id)),
  /** Artifacts that mention this file (Files › Mentioned in). Path is relative to root. */
  'files.mentionedIn': cmd(z.object({ root: z.string(), path: z.string() }), z.array(ArtifactMeta)),
  /** Quick open (Ctrl/Cmd+K): fuzzy file-name search over each root's index (git ls-files, kept fresh by the watchers). */
  'files.findByName': cmd(FindByNameInput, FindByNameOutput),
  /** Files › Search: starts a content search; results stream as `files.searchResults { searchId }`. */
  'files.searchContent': cmd(SearchContentInput, Ok),
  'files.cancelSearch': cmd(z.object({ searchId: z.string().min(1).max(64) }), Ok),
  /** Files › Search › Replace: replaces exactly the confirmed matches; files changed since the search are refused. */
  'files.replace': cmd(ReplaceInput, ReplaceOutput),

  // Terminals
  // No `command` (SEC-05): renderers get interactive shells only; the sign-in terminal runs in main.
  'terminal.create': cmd(z.strictObject({ cwd: z.string(), cols: z.number().int().default(100), rows: z.number().int().default(30) }), z.object({ terminalId: Id })),
  'terminal.write': cmd(z.object({ terminalId: Id, data: z.string() }), Ok),
  'terminal.resize': cmd(z.object({ terminalId: Id, cols: z.number().int(), rows: z.number().int() }), Ok),
  'terminal.kill': cmd(z.object({ terminalId: Id }), Ok),

  // Settings
  'settings.get': cmd(Void, Settings),
  'settings.update': cmd(z.object({ patch: z.record(z.string(), z.unknown()) }), Settings),
  'settings.techniques': cmd(z.object({ projectId: Id.optional() }), z.array(Technique)),
  /**
   * The project's effective Spawn defaults: global Settings with `.oide/config.json` applied under
   * workspace trust (default mode only when trusted, preset when it exists), and the techniques list
   * (global + the project's + extensions'), as `settings.techniques { projectId }` returns it.
   */
  'settings.forProject': cmd(z.object({ projectId: Id }), z.object({ defaultMode: PermissionMode, presetId: Id, techniques: z.array(Technique) })),
  'settings.saveTechnique': cmd(z.object({ technique: Technique, projectId: Id.optional() }), Technique),
  'settings.deleteTechnique': cmd(z.object({ id: Id, projectId: Id.optional() }), Ok),
  'settings.saveCustomModel': cmd(z.object({ model: CustomModel, apiKey: z.string().optional() }), CustomModel),
  'settings.deleteCustomModel': cmd(z.object({ id: Id }), Ok),
  'settings.testCustomModel': cmd(z.object({ id: Id }), z.object({ ok: z.boolean(), detail: z.string() })),
  'settings.projectPermissions': cmd(z.object({ projectId: Id }), z.object({ allow: z.array(z.string()), ask: z.array(z.string()), deny: z.array(z.string()) })),
  'settings.saveProjectPermissions': cmd(z.object({ projectId: Id, allow: z.array(z.string()), ask: z.array(z.string()), deny: z.array(z.string()) }), Ok),
  /** Shipped focus presets and techniques, for "edited" markers and "Reset to default" (Settings › Models, Techniques). */
  'settings.builtIns': cmd(Void, z.object({ presets: z.array(FocusPreset), techniques: z.array(Technique) })),
  /** Problems found while loading settings and `.oide/*.json` (bad JSON, schema errors); shown at the top of Settings. */
  'settings.loadErrors': cmd(z.object({ projectId: Id.optional() }), z.array(z.object({ projectId: Id.optional(), file: z.string(), message: z.string() }))),

  // Usage
  'usage.summary': cmd(Void, z.object({
    sessions: z.number().int(),
    worktrees: z.number().int(),
    subagentsActive: z.number().int(),
    projectsOpen: z.number().int(),
    tokensToday: z.number().int(),
    rateLimitResetAt: z.number().optional(),
  })),

  // Extensions & marketplace
  'extensions.installed': cmd(Void, z.array(InstalledExtension)),
  'extensions.index': cmd(z.object({ refresh: z.boolean().default(false) }), z.array(MarketplaceEntry)),
  'extensions.install': cmd(z.object({ name: z.string(), version: z.string().optional() }), InstalledExtension),
  'extensions.uninstall': cmd(z.object({ id: Id }), Ok),
  'extensions.setEnabled': cmd(z.object({ id: Id, projectId: Id.optional(), enabled: z.boolean() }), InstalledExtension),
  /** Turn one of an extension's tools on or off. `tool` is the tool name in the manifest, or the full `mcp__<server>__<tool>`. */
  'extensions.setToolEnabled': cmd(z.object({ id: Id, tool: z.string().min(1), server: z.string().optional(), enabled: z.boolean() }), InstalledExtension),
  'extensions.addFromFolder': cmd(z.object({ path: z.string().optional(), devMode: z.boolean().default(false) }), InstalledExtension.nullable()),
  'extensions.runCommand': cmd(z.object({ commandId: z.string(), args: z.array(z.unknown()).default([]) }), z.unknown()),
  /** URL of a panel or artifact viewer (`oide-ext://<origin>/<entry>`); main serves only files inside that extension's folder. */
  'extensions.uiUrl': cmd(z.object({ extension: z.string(), kind: z.enum(['panel', 'artifactType']), id: z.string() }), z.object({ url: z.string() })),
  /** Data a panel iframe posted to its host code. Main checks the extension and panel id, and the size. */
  'extensions.panelMessage': cmd(z.object({ extension: z.string(), panelId: z.string(), data: z.unknown() }), Ok),
  /** Settings › Extensions: an extension's `contributes.settings` with their values (secret ones never). */
  'extensions.settings': cmd(z.object({ id: Id }), z.array(ExtensionSettingField)),
  /** Secret values go to the keychain; `null` clears. */
  'extensions.setSetting': cmd(z.object({ id: Id, key: z.string(), value: ExtensionSettingValue }), Ok),
  /** Review: run a `contributes.deployTargets` action in the extension's host code for this agent's worktree. */
  'extensions.runDeployTarget': cmd(z.object({ extension: z.string(), targetId: z.string(), agentId: Id }), z.unknown()),
  'custom.list': cmd(Void, z.array(CustomServer)),
  'extensions.updates': cmd(Void, z.array(ExtensionUpdate)),
  'extensions.update': cmd(z.object({ id: Id, consent: z.boolean().default(false) }), InstalledExtension),
  'extensions.addFromGit': cmd(z.object({ url: z.string().url() }), InstalledExtension),
  'custom.probeUrl': cmd(z.object({ url: z.string().url() }), z.object({ reached: z.boolean(), transport: z.string().optional(), serverInfo: z.string().optional(), serverName: z.string().optional(), serverVersion: z.string().optional(), needsAuth: z.boolean().default(false), tools: z.array(z.object({ name: z.string(), description: z.string().optional(), readOnlyHint: z.boolean().optional(), destructiveHint: z.boolean().optional() })).default([]), error: z.string().optional() })),
  'custom.probeCommand': cmd(z.object({ command: z.string(), args: z.array(z.string()).default([]), env: z.record(z.string(), z.string()).default({}) }), z.object({ started: z.boolean(), tools: z.array(z.object({ name: z.string(), description: z.string().optional(), readOnlyHint: z.boolean().optional(), destructiveHint: z.boolean().optional() })).default([]), error: z.string().optional() })),
  'custom.scanImports': cmd(Void, z.array(z.object({ source: z.string(), file: z.string(), name: z.string(), alreadyAdded: z.boolean(), config: z.unknown(), display: z.string().optional(), kind: z.enum(['stdio', 'http']).optional() }))),
  /** Copies the chosen scanned entries; env values go straight to the keychain and never cross IPC. */
  'custom.importSelected': cmd(z.object({ items: z.array(z.object({ file: z.string(), name: z.string() })), savedTo: z.enum(['my-settings', 'project-mcp-json']).default('my-settings'), projects: z.array(Id).default([]), allProjects: z.boolean().default(true) }), z.array(CustomServer)),
  /** Open question 13 fallback: a token sent as a header secret for a remote server. */
  'custom.setHeaderToken': cmd(z.object({ id: Id, header: z.string().default('Authorization'), token: z.string() }), Ok),
  'custom.save': cmd(z.object({ server: CustomServer, secrets: z.record(z.string(), z.string()).default({}) }), CustomServer),
  'custom.remove': cmd(z.object({ id: Id }), Ok),
  'custom.authorize': cmd(z.object({ id: Id, clientId: z.string().optional() }), z.object({ ok: z.boolean(), error: z.string().optional() })),

  // Artifacts
  'artifacts.list': cmd(z.object({ projectId: Id.optional(), kind: ArtifactKind.optional() }), z.array(ArtifactMeta)),
  'artifacts.get': cmd(z.object({ id: Id }), z.object({ meta: ArtifactMeta, content: z.string(), uses: z.array(ArtifactUse), versions: z.array(ArtifactVersion) })),
  'artifacts.create': cmd(z.object({ title: z.string(), kind: ArtifactKind, projectId: Id.optional(), location: z.enum(['repo', 'app-data']).default('app-data'), content: z.string().optional() }), ArtifactMeta),
  /**
   * Saves a new numbered version. With `baseVersion` (the version the editor started from), main
   * refuses with code `conflict` when someone (an agent) saved a newer version in the meantime.
   */
  'artifacts.save': cmd(z.object({ id: Id, content: z.string(), note: z.string().optional(), baseVersion: z.number().int().positive().optional() }), ArtifactMeta),
  'artifacts.delete': cmd(z.object({ id: Id }), Ok),
  /** New title (the folder slug stays, so links and git history keep working). */
  'artifacts.rename': cmd(z.object({ id: Id, title: z.string().trim().min(1).max(200) }), ArtifactMeta),
  'artifacts.import': cmd(z.object({ url: z.string().url().optional(), filePath: z.string().optional(), title: z.string().optional(), kind: ArtifactKind.optional(), projectId: Id.optional(), location: z.enum(['repo', 'app-data']).optional() }), ArtifactMeta),
  /** Uses log for several artifacts at once (the grid's "Read by 2 agents" lines), keyed by artifact id. */
  'artifacts.uses': cmd(z.object({ ids: z.array(Id).max(500) }), z.record(z.string(), z.array(ArtifactUse))),
  /** Content of one numbered snapshot (History › view version). */
  'artifacts.readVersion': cmd(z.object({ id: Id, version: z.number().int().positive() }), z.object({ content: z.string() })),
  'artifacts.previewUrl': cmd(z.object({ id: Id }), z.object({ url: z.string() })),

  // Auto-update (Settings › Updates). Download and install are separate, explicit user actions.
  'updates.status': cmd(Void, UpdateStatus),
  'updates.check': cmd(Void, UpdateStatus),
  'updates.download': cmd(Void, UpdateStatus),
  /** Quit and install the downloaded update. `consent: true` is the user's click; anything else is refused. */
  'updates.install': cmd(z.object({ consent: z.literal(true) }), Ok),

  // Shell helpers
  'shell.openExternal': cmd(z.object({ url: z.string().url() }), Ok),
  'shell.revealPath': cmd(z.object({ path: z.string() }), Ok),
  'dialog.pickFolder': cmd(z.object({ title: z.string().optional() }), z.string().nullable()),
  /** Native open-file dialog (Import from claude.ai › pick a file). Main remembers the picked path for the follow-up command. */
  'dialog.pickFile': cmd(z.object({ title: z.string().optional(), filters: z.array(z.object({ name: z.string(), extensions: z.array(z.string()) })).default([]) }), z.string().nullable()),
  /**
   * Native multi-file picker for "Attach file" (Focus composer, Wall reply, Spawn goal). Main registers the
   * picked paths for this session and returns them as attachments: images (≤ 5 MB) inline as base64, other
   * files (≤ 25 MB) by path. Files over the limits come back in `rejected` with the reason.
   */
  'dialog.pickFiles': cmd(z.object({ title: z.string().optional() }), PickedAttachments),
  /** Native open-file dialog for Settings › Claude Code › CLI path. Only a path picked here skips the CLI path confirmation (SEC-29). */
  'dialog.pickCli': cmd(Void, z.string().nullable()),
} as const;

export type CommandName = keyof typeof Commands;
export type CommandInput<K extends CommandName> = z.input<(typeof Commands)[K]['input']>;
export type CommandOutput<K extends CommandName> = z.output<(typeof Commands)[K]['output']>;

/** Main → renderer streamed events. Agent events are batched per animation frame. */
export const Events = {
  'agents.batch': z.object({ events: z.array(AgentEvent) }),
  'agents.summary': AgentSummary,
  'agents.removed': z.object({ agentId: Id }),
  /** An agent moved to (or changed in) the Archived view. It is no longer on the Wall. */
  'agents.archived': AgentSummary,
  'projects.changed': z.array(Project),
  'scope.changed': Scope,
  'git.changed': z.object({ projectId: Id }),
  'settings.changed': Settings,
  'cli.changed': CliInfo,
  'terminal.data': z.object({ terminalId: Id, data: z.string() }),
  'terminal.exit': z.object({ terminalId: Id, code: z.number().nullable() }),
  'extensions.changed': z.array(InstalledExtension),
  /** The extension host crashed (panels show "reloading") or came back. */
  'extensions.hostState': z.object({ name: z.string(), state: z.enum(['starting', 'running', 'reloading', 'failed', 'stopped']), panelIds: z.array(z.string()).default([]), error: z.string().optional() }),
  /** Host code asked to open one of its panels (`ctx.panels.open`). */
  'extensions.panelOpen': z.object({ extension: z.string(), panelId: z.string(), agentId: Id.optional(), projectId: Id.optional() }),
  /** Host code sent data to a panel (`ctx.panels.postMessage`); the renderer posts it into that panel's iframes. */
  'extensions.panelMessage': z.object({ extension: z.string(), panelId: z.string(), data: z.unknown() }),
  /** An extension setting changed (Settings › Extensions or host code). Secret values are never sent. */
  'extensions.settingChanged': z.object({ id: Id, key: z.string() }),
  /**
   * An artifact (or the list) changed. `change` says what happened; for `saved`, `version` and
   * `author` (`user` or `agent:<id>`) let an open editor say "updated by <agent>" without a refetch.
   */
  'artifacts.changed': z.object({ id: Id.optional(), change: z.enum(['created', 'saved', 'renamed', 'deleted', 'used']).optional(), version: z.number().int().positive().optional(), author: z.string().optional() }),
  'notify': z.object({
    level: z.enum(['info', 'warning', 'error']),
    message: z.string(),
    agentId: Id.optional(),
    /** What the notice is about, so the renderer can retire it (a needs-permission toast goes when its prompt resolves). */
    kind: z.enum(['needs-permission', 'ready-for-review', 'agent-error']).optional(),
    /** The permission request a `needs-permission` notice is for. */
    requestId: z.string().optional(),
  }),
  'command.invoke': z.object({ commandId: z.string() }),
  /** A batch of `files.searchContent` results (the last one has `done: true`). */
  'files.searchResults': SearchResultsEvent,
  'updates.changed': UpdateStatus,
} as const;

export type EventName = keyof typeof Events;
export type EventPayload<K extends EventName> = z.output<(typeof Events)[K]>;

export const IPC_INVOKE_CHANNEL = 'oide:invoke';
export const IPC_EVENT_CHANNEL = 'oide:event';
/**
 * Preload-only channel: the paths of files the user dropped (or pasted) on an input, read in preload with
 * `webUtils.getPathForFile` from real `File` objects. Not a contract command, so page code cannot send
 * arbitrary paths; main registers them like native picks and answers with `PickedAttachments`.
 */
export const IPC_DROP_CHANNEL = 'oide:dropped-files';

export type IpcResult<T> = { ok: true; value: T } | { ok: false; error: { message: string; code?: string } };

/** Shape of `window.oide`, implemented by preload. */
export interface OideBridge {
  invoke<K extends CommandName>(command: K, input: CommandInput<K>): Promise<CommandOutput<K>>;
  on<K extends EventName>(event: K, listener: (payload: EventPayload<K>) => void): () => void;
  platform: string;
  /**
   * Attach files the user dropped or pasted (real DOM `File` objects only; anything else is skipped).
   * Absent in the browser mock, which has no file paths.
   */
  attachDropped?(files: readonly object[]): Promise<PickedAttachments>;
}
