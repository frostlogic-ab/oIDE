import { z } from 'zod';
import { AgentSpec, AgentStatus, AgentSummary, Effort, GitRef, Id, MessageAttachments, ModelSlot, PermissionAnswer, PermissionMode, UserMessage } from './agent.js';
import { ArtifactFile, ArtifactFileContent, ArtifactKind, ArtifactMeta, ArtifactPath, ArtifactUse, ArtifactVersion, ARTIFACT_LIMITS, IMPORT_NEEDS_CONTENT } from './artifacts.js';
import { AgentEvent } from './events.js';
import { CustomServer, ExtensionSettingField, ExtensionSettingValue, ExtensionUpdate, InstalledExtension, MarketplaceEntry } from './extensions.js';
import { CloneProgress, CloneUrl, FolderName, GithubRepo } from './newProject.js';
import { CommitInfo, FileChanges, FileDiff, FileNode, MergePrediction, OverlapWarning, Project, ReviewComment, SyncState, WorktreeInfo } from './project.js';
import { CliInfo, CustomModel, FocusPreset, Settings, Technique } from './settings.js';
import { UpdateInstallTrigger, UpdateStatus } from './updates.js';
import { FindByNameInput, FindByNameOutput, ReplaceInput, ReplaceOutput, SearchContentInput, SearchResultsEvent } from './search.js';
import { ProjectScript } from './scripts.js';
import {
  LspAt,
  LspCompletionItem,
  LspCompletionList,
  LspDiagnosticsEvent,
  LspDocument,
  LspFormatInput,
  LspHighlight,
  LspHover,
  LspLocation,
  LspSignatureHelp,
  LspStateEvent,
  LspStatus,
  LspSymbol,
  LspSync,
  LspTextEdit,
} from './lsp.js';
import { TelemetryConsentInput, TelemetryStatus, TelemetryTrackInput } from './telemetry.js';

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

/** A worktree folder oIDE could not delete yet and keeps retrying (Settings › Diagnostics). */
export const PendingCleanupInfo = z.object({
  path: z.string(),
  /** The folder's own name. */
  name: z.string(),
  addedAt: z.number(),
  attempts: z.number().int(),
  nextAttemptAt: z.number().optional(),
  lastError: z.enum(['locked', 'denied']).optional(),
  /** Friendly names of the programs last seen holding it. */
  holders: z.array(z.string()).default([]),
});
export type PendingCleanupInfo = z.infer<typeof PendingCleanupInfo>;

/** A program that holds a folder open (executable names only, never paths). */
export const FolderHolderInfo = z.object({
  label: z.string(),
  category: z.enum(['docker', 'editor', 'terminal', 'node', 'unknown']),
  exes: z.array(z.string()),
  pids: z.array(z.number().int()),
});
export type FolderHolderInfo = z.infer<typeof FolderHolderInfo>;

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
  /** Settings › Diagnostics › Folders waiting to be removed (worktrees a program held open). */
  'app.pendingCleanups': cmd(Void, z.array(PendingCleanupInfo)),
  /** "Retry now": one queued folder (`path` must be in the queue), or all of them. */
  'app.retryCleanup': cmd(z.object({ path: z.string().max(4096).optional() }), z.object({ removed: z.array(z.string()), stillPending: z.array(z.string()), gaveUp: z.array(z.string()) })),
  /** "Show holders": which programs hold a queued folder open (`path` must be in the queue). */
  'app.cleanupHolders': cmd(z.object({ path: z.string().max(4096) }), z.object({ supported: z.boolean(), holders: z.array(FolderHolderInfo), error: z.string().optional() })),
  /** A screen's error boundary caught an error; main writes it (redacted) to the main log. No props, state, prompts or code. */
  'app.reportError': cmd(z.object({ screen: z.string().max(60), name: z.string().max(120), message: z.string().max(2000), stack: z.string().max(8000).optional(), componentStack: z.string().max(8000).optional() }), Ok),
  /**
   * Opt-in telemetry (ADR 0011). `track`: the renderer reports a screen view, a renderer catalogue event,
   * an error or web vitals; main validates it against the catalogue (packages/protocol/src/telemetry.ts),
   * applies consent and may drop it. Always answers ok, sent or not.
   */
  'telemetry.track': cmd(TelemetryTrackInput, Ok),
  'telemetry.status': cmd(Void, TelemetryStatus),
  /** The first-run question: `shown` when it appears, then `accept` / `decline` / `later` (closed without a choice). */
  'telemetry.consent': cmd(TelemetryConsentInput, TelemetryStatus),
  'cli.detect': cmd(Void, CliInfo),
  'cli.openSignIn': cmd(Void, z.object({ terminalId: Id })),

  // Projects
  'projects.list': cmd(Void, z.array(Project)),
  'projects.open': cmd(z.object({ path: z.string().optional() }), Project.nullable()),
  'projects.remove': cmd(z.object({ projectId: Id }), Ok),
  'projects.trust': cmd(z.object({ projectId: Id, trusted: z.boolean() }), Project),
  /**
   * Initialise git in a folder that is not a repository yet (Open folder › "Initialize git"), with
   * a first commit so agents have a base: the folder's files (`commitFiles`) or an empty commit.
   * `path` must be a folder the user picked this session (SEC-08). Asks for trust like an open.
   */
  'projects.initFolder': cmd(z.object({ path: z.string().min(1).max(4096), commitFiles: z.boolean().default(true) }), Project),
  /**
   * New repository: `<parent>/<name>` (must not exist, or be empty), `git init` on `main`, a README
   * (or an empty first commit), then opened and trusted (the user made it). `parent` must be picked
   * this session or hold an open project.
   */
  'projects.create': cmd(z.object({ parent: z.string().min(1).max(4096), name: FolderName, readme: z.boolean().default(true) }), Project),
  /**
   * Clone `url` into `<parent>/<name>` and open it (asks for trust: it is someone else's code).
   * Streams `projects.cloneProgress`; one clone at a time (`conflict` while one runs). Resolves null
   * when cancelled (`projects.cancelClone`); a failed or cancelled clone leaves no folder behind.
   */
  'projects.clone': cmd(z.object({ url: CloneUrl, parent: z.string().min(1).max(4096), name: FolderName, source: z.enum(['url', 'github']).default('url') }), Project.nullable()),
  'projects.cancelClone': cmd(Void, Ok),
  /** The user's GitHub repositories through their own `gh` login (never its token). `available: false` when gh is missing or signed out. */
  'projects.githubRepos': cmd(Void, z.object({ available: z.boolean(), reason: z.string().optional(), repos: z.array(GithubRepo) })),
  'scope.get': cmd(Void, Scope),
  'scope.set': cmd(z.object({ scope: Scope }), Scope),

  // Agents
  'agents.list': cmd(Void, z.array(AgentSummary)),
  /** Spawn: `artifactId` and `workIn: 'artifact-folder'` are refused here (artifact agents start with `artifacts.startAgent`). */
  'agents.spawn': cmd(AgentSpec, z.array(AgentSummary)),
  /** `merge-conflicts` messages come from main only (`git.askToResolve`): the renderer cannot send one. */
  'agents.send': cmd(z.object({ agentId: Id, message: UserMessage.refine((m) => m.kind !== 'merge-conflicts', { message: 'merge-conflicts messages are sent by oIDE only' }) }), Ok),
  'agents.answerPermission': cmd(z.object({ agentId: Id, answer: PermissionAnswer }), Ok),
  'agents.setMode': cmd(z.object({ agentId: Id, mode: PermissionMode }), Ok),
  /**
   * Another model or effort for the lead. Applied from the next turn: an idle process restarts with
   * `--resume` and the new flags when the next message is sent; a working turn is left to finish.
   * Refused (`conflict`) for an agent on a custom model.
   */
  'agents.setModel': cmd(z.object({ agentId: Id, model: z.string().trim().min(1).max(200), effort: Effort.optional() }), Ok),
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
  /** `git pull --ff-only` in the main checkout. `from` says where it was clicked (telemetry only). */
  'git.pull': cmd(z.object({ projectId: Id, from: z.enum(['sidebar', 'source-control']).optional() }), SyncState),
  'git.push': cmd(z.object({ projectId: Id }), SyncState),
  'git.commit': cmd(z.object({ projectId: Id, message: z.string().min(1), files: z.array(z.string()).optional() }), CommitInfo),
  /**
   * Revert uncommitted changes in the main checkout: tracked files go back to HEAD, untracked files are
   * deleted. `files` limits it to those paths (only paths git reports as changed are touched).
   */
  'git.discard': cmd(z.object({ projectId: Id, files: z.array(z.string().min(1).max(4096)).min(1).optional() }), z.object({ reverted: z.number().int() })),
  'git.log': cmd(z.object({ projectId: Id, ref: GitRef.default('HEAD'), limit: z.number().int().default(20) }), z.array(CommitInfo)),
  'git.worktrees': cmd(z.object({ projectId: Id }), z.array(WorktreeInfo)),
  'git.overlaps': cmd(z.object({ projectId: Id }), z.array(OverlapWarning)),
  'git.diff': cmd(z.object({ agentId: Id }), z.array(FileDiff)),
  /**
   * Merge the agent branch into the main checkout. Uncommitted main-checkout files in the way are
   * stashed and put back (`autoStash`); `restored: false` means they clashed and stay in the stash (`note` says how to get them).
   */
  'git.mergeLocal': cmd(
    z.object({ agentId: Id }),
    z.object({
      ok: z.boolean(),
      conflicts: z.array(z.string()).default([]),
      autoStash: z.object({ files: z.array(z.string()), restored: z.boolean(), note: z.string() }).optional(),
    }),
  ),
  /**
   * Would merging the agent branch into the main checkout conflict? `git merge-tree`, no checkout touched;
   * cached per (HEAD, branch) commits unless `refresh`. `withMainStatus` adds the main checkout's uncommitted files.
   */
  'git.predictMerge': cmd(z.object({ agentId: Id, refresh: z.boolean().default(false), withMainStatus: z.boolean().default(false) }), MergePrediction),
  /**
   * "Ask <agent> to resolve": sends the agent its merge conflicts (target branch and commit, files, what
   * to do) as a message from oIDE, unarchiving or resuming it first (queued under Max running). Never merges.
   */
  'git.askToResolve': cmd(
    z.object({ agentId: Id, source: z.enum(['prediction', 'merge']).default('prediction') }),
    z.object({ status: AgentStatus, files: z.number().int().nonnegative(), unarchived: z.boolean(), resumed: z.boolean() }),
  ),
  /** Idempotent: when the branch already has a pull request, it is returned instead of opening another one (`existing: true`). */
  'git.openPr': cmd(
    /** Without `title`/`body`, main writes them: the agent's own draft, else the project's PR template and title rules. */
    z.object({ agentId: Id, title: z.string().max(300).optional(), body: z.string().max(60_000).optional() }),
    z.object({
      url: z.string(),
      number: z.number().int().optional(),
      state: z.enum(['open', 'draft', 'merged', 'closed']).optional(),
      existing: z.boolean().optional(),
      /** Where the new PR's title and body came from: the agent's draft, the project's template, or the plain summary. */
      draft: z.enum(['agent', 'template', 'plain', 'given']).optional(),
    }),
  ),
  /**
   * Push follow-up work to the branch's open pull request: uncommitted worktree files are committed
   * first, on the agent's behalf (Oide-Agent trailer), then the branch is pushed. Fails with `conflict`
   * when the branch has no open or draft PR (use `git.openPr`). `pushed: 0` and `committed: false` = it was already up to date.
   */
  'git.pushToPr': cmd(
    z.object({ agentId: Id }),
    z.object({
      url: z.string(),
      number: z.number().int(),
      state: z.enum(['open', 'draft']),
      /** Uncommitted files were committed before the push. */
      committed: z.boolean(),
      /** Commits the push sent to the PR (including the one made for uncommitted files). */
      pushed: z.number().int().nonnegative(),
    }),
  ),
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
  /** Files tree › New file / New folder: `path` may hold `/` (missing folders are created); refuses an existing path. */
  'files.create': cmd(z.object({ root: z.string(), path: z.string().min(1).max(1024), kind: z.enum(['file', 'dir']) }), Ok),
  /** Files tree › Rename: `to` is the new relative path in the same checkout; refuses an existing target. */
  'files.rename': cmd(z.object({ root: z.string(), from: z.string().min(1), to: z.string().min(1).max(1024) }), Ok),
  /**
   * Files tree › Paste: copies (or with `move`, moves) a file or folder into `toDir` of `toRoot`
   * (any project or worktree). A name already taken gets " copy", " copy 2"... Returns the new path.
   */
  'files.copy': cmd(
    z.object({ fromRoot: z.string(), from: z.string().min(1), toRoot: z.string(), toDir: z.string().default(''), move: z.boolean().default(false) }),
    z.object({ path: z.string() }),
  ),
  /** Files tree › Delete: moves the file or folder to the system trash (Recycle Bin). */
  'files.delete': cmd(z.object({ root: z.string(), path: z.string().min(1) }), Ok),
  /**
   * Files tree git colours: what the checkout changed (main checkout: uncommitted, against HEAD; agent
   * worktree: against the merge-base with its base branch, committed or not), untracked files included.
   */
  'files.changes': cmd(z.object({ root: z.string() }), FileChanges),
  /**
   * Files tree › Discard changes: each path goes back to the version `files.changes` compares against
   * (a new file is deleted, a deleted one comes back). Only paths reported as changed are touched.
   */
  'files.discardChanges': cmd(
    z.object({ root: z.string(), paths: z.array(z.string().min(1).max(4096)).min(1).max(5000) }),
    z.object({ reverted: z.number().int(), against: z.enum(['head', 'branch']) }),
  ),
  /**
   * Files editor diff: the version of a changed file that `files.changes` compares against (pass the
   * rename source as `oldPath`). `missing` for a new file; `binary` for binary or very large files.
   */
  'files.original': cmd(
    z.object({ root: z.string(), path: z.string().min(1).max(4096), oldPath: z.string().min(1).max(4096).optional() }),
    z.object({ kind: z.enum(['text', 'binary', 'missing']), content: z.string().default(''), against: z.enum(['head', 'branch']) }),
  ),
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

  // Language servers (ADR 0019): the Files editor's open documents and the features it asks for.
  // Only for project / worktree checkouts of trusted projects; every path goes through the guard.
  /** A tab opened (or its model was created): starts the matching server on first use. */
  'lsp.open': cmd(LspSync, LspStatus),
  /** The document changed (full text, the editor's version id). */
  'lsp.change': cmd(LspSync, Ok),
  'lsp.close': cmd(LspDocument, Ok),
  /** The server state for a document, without opening it. */
  'lsp.status': cmd(LspDocument, LspStatus),
  /** Stop and start the document's server again (the status menu's Restart). */
  'lsp.restart': cmd(LspDocument, LspStatus),
  'lsp.hover': cmd(LspAt, LspHover.nullable()),
  'lsp.completion': cmd(LspAt.extend({ triggerCharacter: z.string().max(4).optional() }), LspCompletionList.nullable()),
  /** Documentation and detail of one item of the last `lsp.completion` result. */
  'lsp.resolveCompletion': cmd(LspDocument.extend({ resultId: z.number().int(), index: z.number().int().min(0) }), LspCompletionItem.nullable()),
  'lsp.signatureHelp': cmd(LspAt.extend({ triggerCharacter: z.string().max(4).optional() }), LspSignatureHelp.nullable()),
  'lsp.definition': cmd(LspAt, z.array(LspLocation)),
  'lsp.typeDefinition': cmd(LspAt, z.array(LspLocation)),
  'lsp.implementation': cmd(LspAt, z.array(LspLocation)),
  'lsp.references': cmd(LspAt.extend({ includeDeclaration: z.boolean().default(true) }), z.array(LspLocation)),
  'lsp.highlights': cmd(LspAt, z.array(LspHighlight)),
  'lsp.symbols': cmd(LspDocument, z.array(LspSymbol)),
  'lsp.format': cmd(LspFormatInput, z.array(LspTextEdit)),

  // Terminals
  // No `command` (SEC-05): renderers get interactive shells only; the sign-in terminal runs in main.
  'terminal.create': cmd(z.strictObject({ cwd: z.string(), cols: z.number().int().default(100), rows: z.number().int().default(30) }), z.object({ terminalId: Id })),
  'terminal.write': cmd(z.object({ terminalId: Id, data: z.string() }), Ok),
  'terminal.resize': cmd(z.object({ terminalId: Id, cols: z.number().int(), rows: z.number().int() }), Ok),
  'terminal.kill': cmd(z.object({ terminalId: Id }), Ok),
  /** Files › Run: the run scripts main finds in a project or worktree checkout (package.json, Makefile, Cargo…). */
  'scripts.list': cmd(z.object({ root: z.string() }), z.array(ProjectScript)),
  /**
   * Files › Run › a script: a new interactive shell in `cwd` that runs the script's command, like
   * VS Code's "Run Script". Only a script id goes in; main finds the script in `cwd` again and builds
   * the command line itself, so this is no way to run an arbitrary command (SEC-05).
   */
  'terminal.runScript': cmd(
    z.strictObject({ cwd: z.string(), scriptId: z.string().min(1).max(300), cols: z.number().int().default(100), rows: z.number().int().default(30) }),
    z.object({ terminalId: Id, script: ProjectScript }),
  ),

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
  /**
   * Import from claude.ai. `url` + `content` stores the content the user copied on claude.ai (main
   * cannot fetch it: no public content API, and oIDE never uses the claude.ai sign-in); `filePath`
   * (picked with dialog.pickFile or dropped) imports a downloaded file, with `url` kept as its origin.
   * A link alone is refused: nothing is created without the artifact's real content. `content`
   * without `url` imports the pasted code with no origin (replacing an old import whose link is no
   * longer accepted).
   */
  'artifacts.import': cmd(
    z
      .object({
        url: z.string().url().max(2048).optional(),
        content: z.string().max(10 * 1024 * 1024).optional(),
        filePath: z.string().optional(),
        title: z.string().max(200).optional(),
        kind: ArtifactKind.optional(),
        projectId: Id.optional(),
        location: z.enum(['repo', 'app-data']).optional(),
      })
      .refine((i) => !!i.filePath || !!i.content?.trim(), { message: IMPORT_NEEDS_CONTENT }),
    ArtifactMeta,
  ),
  /** Uses log for several artifacts at once (the grid's "Read by 2 agents" lines), keyed by artifact id. */
  'artifacts.uses': cmd(z.object({ ids: z.array(Id).max(500) }), z.record(z.string(), z.array(ArtifactUse))),
  /** Content of one numbered snapshot (History › view version). */
  'artifacts.readVersion': cmd(z.object({ id: Id, version: z.number().int().positive() }), z.object({ content: z.string() })),
  /**
   * History > Restore: commits the full snapshot of `version` (every file, and the entry it had) as a
   * new version with the note `Restored v<n>`. `baseVersion` (the version the user was looking at)
   * refuses with code `conflict` when the artifact has moved on, like `artifacts.save`.
   */
  'artifacts.restore': cmd(z.object({ id: Id, version: z.number().int().positive(), baseVersion: z.number().int().nonnegative().optional() }), ArtifactMeta),
  'artifacts.previewUrl': cmd(z.object({ id: Id }), z.object({ url: z.string() })),
  /**
   * New artifact from a link (ADR 0014). Main never downloads it: it creates the artifact at version 0
   * with `retrieval.status: 'retrieving'` and starts an agent in `projectId` (queued behind Max running)
   * that reads the link with the user's `claude` CLI and hands the files back over MCP. The link is
   * checked with `classifyClaudeLink` first (`invalid_input`, reason `bad_link`).
   */
  'artifacts.importLink': cmd(
    z.object({
      url: z.string().url().max(2048),
      title: z.string().max(200).optional(),
      kind: ArtifactKind.optional(),
      projectId: Id,
      location: z.enum(['repo', 'app-data']).default('app-data'),
    }),
    ArtifactMeta,
  ),
  /**
   * Update (or retry) a linked artifact: starts a new retrieval agent for `importedFrom`. The current
   * version stays until the agent finishes; the result is the next version. `projectId` is where the
   * agent runs when the artifact has no project. Refused with `busy` while a retrieval is running.
   */
  'artifacts.refresh': cmd(z.object({ id: Id, projectId: Id.optional() }), ArtifactMeta),
  /** Stops a running retrieval: the agent is stopped, nothing is written, the status becomes `failed`. */
  'artifacts.cancelRetrieval': cmd(z.object({ id: Id }), ArtifactMeta),
  /**
   * The artifact agent (Artifacts › open view): starts an agent that edits this artifact's files (and
   * only this artifact's) through oIDE's MCP artifact tools, with the user's first direction. It works
   * in an empty scratch folder of its own, never in a repo, and is queued behind Max running like any
   * agent. `projectId` is the project whose settings it runs under when the artifact has none
   * (`needs_project` otherwise). Refused with `busy` while the artifact already has a live agent:
   * send that one a message instead.
   */
  'artifacts.startAgent': cmd(
    z.object({
      id: Id,
      projectId: Id.optional(),
      text: z.string().trim().min(1).max(100_000),
      attachments: MessageAttachments.optional(),
      mode: PermissionMode.optional(),
      model: ModelSlot.optional(),
    }),
    AgentSummary,
  ),
  /** Files of the current version, or of `version`. */
  'artifacts.files': cmd(z.object({ id: Id, version: z.number().int().positive().optional() }), z.array(ArtifactFile)),
  /** One file of the current version, or of `version`. */
  'artifacts.readFile': cmd(z.object({ id: Id, path: ArtifactPath, version: z.number().int().positive().optional() }), ArtifactFileContent),
  /**
   * Writes and deletes files as one new version (the viewer's Files panel). `entry` moves the entry
   * to another file of the new version. `baseVersion` refuses with `conflict` like `artifacts.save`.
   */
  'artifacts.writeFiles': cmd(
    z.object({
      id: Id,
      files: z.array(z.object({ path: ArtifactPath }).merge(ArtifactFileContent)).max(ARTIFACT_LIMITS.files).default([]),
      deletes: z.array(ArtifactPath).max(ARTIFACT_LIMITS.files).default([]),
      entry: ArtifactPath.optional(),
      note: z.string().max(500).optional(),
      baseVersion: z.number().int().nonnegative().optional(),
    }),
    ArtifactMeta,
  ),
  /**
   * New artifact from files the user picked (`dialog.pickArtifactFiles`), dropped, or a folder picked
   * there with `folder: true` (its files, recursively, keeping relative paths). Main accepts only paths
   * picked or dropped in this session. The kind and entry follow the files unless given.
   */
  'artifacts.importFiles': cmd(
    z
      .object({
        filePaths: z.array(z.string().min(1).max(4096)).max(ARTIFACT_LIMITS.files).default([]),
        folderPath: z.string().min(1).max(4096).optional(),
        entry: ArtifactPath.optional(),
        url: z.string().url().max(2048).optional(),
        title: z.string().max(200).optional(),
        kind: ArtifactKind.optional(),
        projectId: Id.optional(),
        location: z.enum(['repo', 'app-data']).default('app-data'),
      })
      .refine((i) => i.filePaths.length > 0 || !!i.folderPath, { message: 'Pick files or a folder.' }),
    ArtifactMeta,
  ),

  // Auto-update (Settings › Updates, header Update button). Downloads in the background when
  // Settings › Updates › Download automatically is on; restarting to install is always a click.
  'updates.status': cmd(Void, UpdateStatus),
  'updates.check': cmd(Void, UpdateStatus),
  'updates.download': cmd(Void, UpdateStatus),
  /**
   * Quit and install the downloaded update. `consent: true` is the user's click; anything else is
   * refused. `from` names the button (telemetry `update_install_started`).
   */
  'updates.install': cmd(z.object({ consent: z.literal(true), from: UpdateInstallTrigger.exclude(['quit']).optional() }), Ok),

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
  /**
   * Native multi-select open dialog for artifact files (New artifact › From files). Returns the picked
   * paths, any type (images too), and registers each as picked so `artifacts.importFiles` accepts it.
   * `folder: true` picks one folder instead (registered the same way).
   */
  'dialog.pickArtifactFiles': cmd(z.object({ folder: z.boolean().default(false) }), z.array(z.string())),
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
  /** Progress of the running `projects.clone`. */
  'projects.cloneProgress': CloneProgress,
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
  'artifacts.changed': z.object({ id: Id.optional(), change: z.enum(['created', 'saved', 'renamed', 'deleted', 'used', 'retrieval']).optional(), version: z.number().int().nonnegative().optional(), author: z.string().optional() }),
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
  /** A language server published diagnostics for a file of a checkout (an empty list clears them). */
  'lsp.diagnostics': LspDiagnosticsEvent,
  /** A language server started, stopped, failed or is not installed. */
  'lsp.state': LspStateEvent,
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
