import { existsSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { LaunchError, Supervisor, WORKTREE_GONE, type AgentDriver, type EventSink, type PermissionBroker, type SecretProvider, type SettingsProvider, type WorktreeProvider } from '@oide/agent-core';
import { Git, isInside, pathKey, samePath, type WorktreeManager } from '@oide/git';
import type { OideMcpServer } from '@oide/mcp-server';
import { ENTRY_FILES, readOideFile, type SecretStore, type SettingsService, type Store } from '@oide/store';
import { repairAgentSummary, type AgentEvent, type AgentSpecInput, type AgentStatus, type AgentSummary, type ArchiveReason, type ArtifactKind, type PermissionAnswer, type PermissionMode, type UserMessage } from '@oide/protocol';
import type { MainContext } from '../context.js';
import { IpcError } from '../ipc/router.js';
import { boundModelKey } from '../security/model-keys.js';
import { isLockedFileError, lockedFolderMessage, type CleanupQueue } from '../reliability/cleanup-queue.js';
import type { Redactor } from '../reliability/redact.js';
import { BufferedWriter, StorageErrorReporter } from '../reliability/storage-errors.js';
import { copyAttachments, validateAttachments } from './attachments.js';
import type { CliService } from './cli.js';
import type { ExtensionsService } from './extensions.js';
import type { GitService } from './git.js';
import type { Platform } from './platform.js';
import type { ProjectsService } from './projects.js';

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const ACTIVE: ReadonlySet<AgentStatus> = new Set(['starting', 'running', 'needs-permission']);
const RESUME_KEY = 'agents:resume-on-start';
const MCP_DOWN = "oIDE's MCP server is not running, so agents cannot ask for permission. Restart oIDE.";
/** Statuses an agent can be archived from by hand: its process is not working on a turn. */
const ARCHIVABLE: ReadonlySet<AgentStatus> = new Set(['has-question', 'ready-for-review', 'paused', 'stopped', 'rate-limited', 'error', 'done']);

export interface ArchivedPage {
  items: AgentSummary[];
  total: number;
  nextCursor?: { at: number; id: string };
}

/**
 * The broker every launch goes through (spawn, resume after restart, relaunch on a mode change):
 * it refuses to launch while oIDE's MCP server is down (no permission-prompt server), and
 * registers each agent's MCP secret and secret env with the log redactor.
 */
export function guardedBroker(mcp: PermissionBroker, opts: { mcpReady?: () => boolean; redactor?: Redactor }): PermissionBroker {
  return {
    async registerAgent(agentId, handlers, extraServers, options) {
      if (opts.mcpReady && !opts.mcpReady()) throw new LaunchError(MCP_DOWN);
      for (const v of Object.values(options?.secretEnv ?? {})) opts.redactor?.addSecret(v);
      const reg = await mcp.registerAgent(agentId, handlers, extraServers, options);
      for (const v of Object.values(reg.env ?? {})) opts.redactor?.addSecret(v);
      return reg;
    },
    unregisterAgent: (agentId) => mcp.unregisterAgent(agentId),
    answer: (requestId, answer) => mcp.answer(requestId, answer),
  };
}

function safeJson(raw: string | undefined): unknown {
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** Which files each agent is changing right now (from its Edit/Write tool calls), relative to its checkout. */
export class EditTracker {
  private readonly byAgent = new Map<string, { root: string; projectId: string; files: Set<string> }>();

  note(agent: AgentSummary, filePath: string): void {
    if (!agent.worktreePath) return;
    const abs = isAbsolute(filePath) ? filePath : resolve(agent.worktreePath, filePath);
    if (!isInside(agent.worktreePath, abs)) return;
    const rel = relative(agent.worktreePath, abs).split('\\').join('/');
    let e = this.byAgent.get(agent.id);
    if (!e) this.byAgent.set(agent.id, (e = { root: agent.worktreePath, projectId: agent.projectId, files: new Set() }));
    e.files.add(pathKey(rel));
  }

  clear(agentId: string): void {
    this.byAgent.delete(agentId);
  }

  /** Agents editing the same project-relative file as `abs` (in any checkout of the project). */
  agentsFor(abs: string, checkout: { root: string; projectId: string }): string[] {
    const rel = pathKey(relative(checkout.root, abs).split('\\').join('/'));
    const out: string[] = [];
    for (const [id, e] of this.byAgent) if (e.projectId === checkout.projectId && e.files.has(rel)) out.push(id);
    return out;
  }
}

export interface AgentsServiceOptions {
  ctx: MainContext;
  store: Store;
  settings: SettingsService;
  secrets: SecretStore;
  worktrees: WorktreeManager;
  mcp: OideMcpServer;
  projects: ProjectsService;
  cli: CliService;
  platform: Platform;
  /** Worktree folders to delete on next start when a locked file blocks removal (Windows). */
  cleanup?: CleanupQueue;
  /** False when oIDE's MCP server could not start (agents need it for permission prompts). */
  mcpReady?: () => boolean;
  /** Set after construction (cycle). */
  extensions?: ExtensionsService;
  git?: GitService;
  driver?: AgentDriver;
  /** `Services.picked`: paths picked in a native dialog or dropped this session (attachments may use only these). */
  picked?: Set<string>;
}

/**
 * The supervisor plus every port it needs: worktrees per `WorkIn` (setup only for trusted
 * projects), an event sink over the store that also fans out to the renderer, settings merged with
 * `.oide/` under workspace trust, extension tools, the keychain for custom model keys. Also raises
 * desktop notifications and tracks which files agents are editing.
 */
export class AgentsService {
  readonly supervisor: Supervisor;
  readonly editing = new EditTracker();
  private readonly rows = new Set<string>();
  private readonly lastStatus = new Map<string, AgentStatus>();
  /** Agents whose summary failed the contract (logged once each; repaired or left out of `agents.list`). */
  private readonly contractWarned = new Set<string>();
  /** Agents restore() did not resume because the MCP server was down: still resumed on the next start. */
  private deferredResume: string[] = [];
  extensions: ExtensionsService | undefined;
  git: GitService | undefined;
  /** Event appends: a full disk or a locked database queues events (bounded) and tells the user once. */
  private readonly eventWriter: BufferedWriter<{ e: AgentEvent; raw: string | undefined }>;

  constructor(private readonly o: AgentsServiceOptions) {
    this.extensions = o.extensions;
    this.git = o.git;
    const storeErrors = new StorageErrorReporter({ notify: (level, message) => o.ctx.emit('notify', { level, message }), log: o.ctx.log });
    this.eventWriter = new BufferedWriter(({ e, raw }) => void o.store.events.append(e, safeJson(raw)), storeErrors);
    this.supervisor = new Supervisor({
      worktrees: this.worktreeProvider(),
      sink: this.eventSink(),
      settings: this.settingsProvider(),
      secrets: this.secretProvider(),
      // Files attached to a message are copied into the agent's folder (`.oide/attachments/`) before they reach the CLI.
      attachments: { materialize: ({ cwd, attachments }) => copyAttachments(cwd, attachments, this.o.picked ?? new Set()) },
      broker: guardedBroker(o.mcp, { ...(o.mcpReady ? { mcpReady: o.mcpReady } : {}), ...(o.ctx.reliability ? { redactor: o.ctx.reliability.logs.redactor } : {}) }),
      ...(o.driver ? { driver: o.driver } : {}),
      log: (m, d) => o.ctx.log.debug('[supervisor]', m, d ?? ''),
    });
    this.supervisor.on('summary', (s) => this.onSummary(s));
    this.supervisor.on('removed', (id) => {
      this.lastStatus.delete(id);
      this.editing.clear(id);
      this.extensions?.revokeAgent(id);
      o.ctx.emit('agents.removed', { agentId: id });
    });
    this.supervisor.on('archived', (s) => {
      this.lastStatus.delete(s.id);
      this.editing.clear(s.id);
      this.extensions?.revokeAgent(s.id);
      const safe = this.contractSafe(s);
      if (safe) o.ctx.emit('agents.archived', safe);
    });
  }

  // ---------------------------------------------------------------- ports

  private worktreeProvider(): WorktreeProvider {
    const { o } = this;
    return {
      create: async ({ slug, spec }) => {
        const p = o.projects.require(spec.projectId);
        if (spec.workIn === 'project-folder') {
          if (spec.mode === 'bypassPermissions') throw new LaunchError('Bypass agents must run in a worktree, never in the project folder');
          const sha = await new Git({ cwd: p.path }).revParse('HEAD');
          return { path: p.path, ...(sha ? { baseRef: sha } : {}) };
        }
        const wt = await o.worktrees.create({
          projectPath: p.path,
          projectId: p.id,
          agentSlug: slug,
          base: spec.baseRef ?? (spec.workIn === 'worktree-from-current' ? 'current' : 'main'),
          location: o.settings.get().agents.worktreeLocation,
        });
        o.ctx.roots.add(wt.path, 'worktree');
        return { path: wt.path, branch: wt.branch, baseRef: wt.baseRef };
      },
      runSetup: async ({ path, spec, onStart, onOutput }) => {
        const p = o.projects.get(spec.projectId);
        // Workspace trust: an untrusted repo's .oide/setup never runs. Nor in the user's own checkout.
        if (!p?.trusted || spec.workIn === 'project-folder' || samePath(path, p.path)) return { ok: true };
        const eff = await o.settings.forProject(p.path, { trusted: true });
        if (!eff.setup) return { ok: true };
        onStart?.();
        let buf = '';
        let tail = '';
        const r = await o.worktrees.runSetup(path, eff.setup, {
          timeoutMs: 30 * 60_000,
          onOutput: (chunk) => {
            tail = (tail + chunk).slice(-4000);
            buf += chunk;
            const lines = buf.split(/\r?\n/);
            buf = lines.pop() ?? '';
            for (const l of lines) if (l.trim()) onOutput?.(l);
          },
        });
        if (buf.trim()) onOutput?.(buf);
        return { ok: r.exitCode === 0, output: tail };
      },
      remove: async ({ path, projectId }) => {
        const p = o.projects.get(projectId);
        if (!p || samePath(path, p.path)) return false;
        await this.git?.unwatch(path);
        try {
          await o.worktrees.remove(p.path, path, { force: true, deleteBranch: true });
        } catch (err) {
          // Windows: a program still has a file open in the folder after the retries. Remove the
          // agent anyway, tell the user which folder, and finish the delete on the next start.
          if (!isLockedFileError(err) || !o.cleanup) throw err;
          o.cleanup.schedule(path, p.path);
          o.ctx.log.warn('worktree folder locked; scheduled for the next start', { path, error: err });
          o.ctx.emit('notify', { level: 'warning', message: lockedFolderMessage(path, true) });
        }
        o.ctx.roots.remove(path);
        this.git?.changed(projectId);
        return true;
      },
    };
  }

  /** Ensure the agents row exists before events reference it (foreign key). */
  private ensureRow(agentId: string): boolean {
    if (this.rows.has(agentId)) return true;
    if (this.o.store.agents.get(agentId)) {
      this.rows.add(agentId);
      return true;
    }
    const spec = this.supervisor.spec(agentId);
    const summary = this.supervisor.get(agentId);
    if (!spec || !summary) return false;
    this.o.store.agents.insert({ id: agentId, projectId: spec.projectId, spec, status: summary.status, summary, ...(summary.sessionId ? { sessionId: summary.sessionId } : {}) });
    this.rows.add(agentId);
    return true;
  }

  private eventSink(): EventSink {
    const { o } = this;
    return {
      append: (e, raw) => {
        o.ctx.agentEvents.push(e);
        if (e.type === 'partial') return;
        if (!this.ensureRow(e.agentId)) return;
        this.eventWriter.push({ e, raw });
        if (e.type === 'error') o.ctx.reliability?.logs.agent(e.agentId).warn('agent error event', { code: e.code });
        try {
          this.onEvent(e);
        } catch (err) {
          o.ctx.log.warn('event bookkeeping failed', e.type, err);
        }
      },
      saveSummary: (summary) => {
        if (!this.ensureRow(summary.id)) return;
        o.store.agents.saveSummary(summary);
      },
      removeAgent: (agentId) => {
        this.rows.delete(agentId);
        o.store.agents.remove(agentId);
      },
    };
  }

  private onEvent(e: AgentEvent): void {
    const { o } = this;
    switch (e.type) {
      case 'usage':
        o.store.usage.add({ agentId: e.agentId, ...(e.parentToolUseId ? { subagentId: e.parentToolUseId } : {}), ts: e.ts, ...(e.model ? { model: e.model } : {}), usage: e.usage });
        break;
      case 'subagent':
        o.store.subagents.upsert(e.subagent);
        break;
      case 'init':
        o.cli.noteSignedIn('yes');
        break;
      case 'error':
        if (e.code === 'auth') o.cli.noteSignedIn('no');
        break;
      case 'tool-use': {
        if (!EDIT_TOOLS.has(e.name)) break;
        const input = e.input as { file_path?: unknown; notebook_path?: unknown } | null;
        const fp = typeof input?.file_path === 'string' ? input.file_path : typeof input?.notebook_path === 'string' ? input.notebook_path : undefined;
        const a = this.supervisor.get(e.agentId);
        if (fp && a) this.editing.note(a, fp);
        break;
      }
      case 'tool-result':
      case 'review-submitted':
      case 'result':
        this.git?.scheduleDiff(e.agentId);
        break;
      default:
        break;
    }
  }

  private settingsProvider(): SettingsProvider {
    const { o } = this;
    return {
      get: () => o.settings.get(),
      cli: () => o.cli.ensure(),
      techniques: async (projectId) => {
        const p = o.projects.get(projectId);
        const ext = (await this.extensions?.techniques(projectId)) ?? [];
        if (!p) return [...o.settings.get().techniques, ...ext];
        return [...(await o.settings.forProject(p.path, { trusted: p.trusted })).techniques, ...ext];
      },
      project: async (projectId) => {
        const p = o.projects.get(projectId);
        if (!p) return undefined;
        const eff = await o.settings.forProject(p.path, { trusted: p.trusted });
        return { path: p.path, trusted: p.trusted, rules: { allow: eff.permissions.allow, ask: eff.permissions.ask, deny: eff.permissions.deny } };
      },
      extensionTools: async (spec, agentId) => (this.extensions ? (await this.extensions.agentConfig(spec, agentId)).tools : []),
      extraMcpServers: async (spec, agentId) => (this.extensions ? (await this.extensions.agentConfig(spec, agentId)).servers : {}),
      extraEnv: async (spec, agentId) => (this.extensions ? (await this.extensions.agentConfig(spec, agentId)).env : {}),
      customModel: (id) => o.settings.get().models.custom.find((m) => m.id === id),
      addAllowRule: async (projectId, rule) => {
        const p = o.projects.get(projectId);
        if (!p) return;
        const cur = await readOideFile(p.path, 'permissions');
        if (cur.value.allow.includes(rule)) return;
        await o.settings.saveProjectPermissions(p.path, { allow: [...cur.value.allow, rule], ask: cur.value.ask, deny: cur.value.deny });
      },
      resolveArtifact: (id) => {
        const r = o.store.database.db.prepare('SELECT title, kind, dir FROM artifacts WHERE id = ?').get(id) as { title: string; kind: string; dir: string } | undefined;
        if (!r) return undefined;
        const entry = ENTRY_FILES[r.kind as ArtifactKind];
        return { id, title: r.title, ...(entry ? { path: resolve(r.dir, entry) } : {}) };
      },
    };
  }

  private secretProvider(): SecretProvider {
    // SEC-09: only while the model still points at the origin the key was entered for.
    return {
      customModelKey: async (id) => {
        const m = this.o.settings.get().models.custom.find((x) => x.id === id);
        return m ? boundModelKey(this.o.secrets, m) : undefined;
      },
    };
  }

  // ---------------------------------------------------------------- summaries, notifications

  /**
   * The summary as the IPC contract accepts it. A summary that fails the contract (a reducer bug, or
   * one restored from an older build) is repaired by dropping the invalid fields, or left out, and
   * logged once per agent, so one bad agent never empties the Wall (`agents.list` is all-or-nothing).
   */
  private contractSafe(s: AgentSummary): AgentSummary | undefined {
    const r = repairAgentSummary(s);
    if (!r.issues.length) return s;
    if (!this.contractWarned.has(s.id)) {
      this.contractWarned.add(s.id);
      this.o.ctx.log.error('agent summary does not match the IPC contract', { agent: s.id, repaired: Boolean(r.summary), dropped: r.dropped, issues: r.issues });
    }
    return r.summary;
  }

  private onSummary(s: AgentSummary): void {
    const { o } = this;
    const safe = this.contractSafe(s);
    if (safe) o.ctx.emit('agents.summary', safe);
    if (s.worktreePath && !o.ctx.roots.list('worktree').some((r) => samePath(r, s.worktreePath!))) {
      const p = o.projects.get(s.projectId);
      if (p && !samePath(p.path, s.worktreePath)) o.ctx.roots.add(s.worktreePath, 'worktree');
      if (p?.trusted) this.git?.watch(s.worktreePath, s.projectId);
    }
    const prev = this.lastStatus.get(s.id);
    if (prev === s.status) return;
    this.lastStatus.set(s.id, s.status);
    // Per-agent supervisor log: status changes, exit codes and errors (never prompts or output).
    const agentLog = o.ctx.reliability?.logs.agent(s.id);
    if (agentLog) {
      const detail = { ...(s.exitCode != null ? { exitCode: s.exitCode } : {}), ...(s.error ? { error: s.error } : {}), ...(s.sessionId ? { session: s.sessionId } : {}) };
      (s.status === 'error' ? agentLog.warn : agentLog.info)(`status ${prev ?? '(new)'} → ${s.status}`, detail);
    }
    if (!ACTIVE.has(s.status)) this.editing.clear(s.id);
    // Finished agents go to the Archived view (after this publish completes).
    if (s.status === 'done' && prev !== undefined) setTimeout(() => void this.archiveAgent(s.id, { reason: 'completed' }).catch((err) => o.ctx.log.warn('auto-archive failed', s.id, err)), 0);
    if (prev === undefined && s.status !== 'needs-permission' && s.status !== 'error') return;
    this.notifyFor(s);
  }

  private notifyFor(s: AgentSummary): void {
    const n = this.o.settings.get().agents.notifications;
    const focus = () => {
      const w = this.o.ctx.getWindow();
      if (w && !w.isDestroyed()) {
        if (w.isMinimized()) w.restore();
        w.focus();
      }
    };
    if (s.status === 'needs-permission' && n.needsPermission) {
      const what = s.pendingPermission?.summary ?? 'a tool call';
      this.o.ctx.emit('notify', {
        level: 'warning',
        message: `${s.title} needs permission: ${what}`,
        agentId: s.id,
        kind: 'needs-permission',
        ...(s.pendingPermission ? { requestId: s.pendingPermission.requestId } : {}),
      });
      this.o.platform.notify(`${s.title} needs permission`, what, focus);
    } else if (s.status === 'ready-for-review' && n.readyForReview) {
      this.o.ctx.emit('notify', { level: 'info', message: `${s.title} is ready for review`, agentId: s.id, kind: 'ready-for-review' });
      this.o.platform.notify(`${s.title} is ready for review`, s.review?.summary.slice(0, 200) ?? '', focus);
    } else if (s.status === 'error' && n.error) {
      this.o.ctx.emit('notify', { level: 'error', message: `${s.title} stopped with an error${s.error ? `: ${s.error}` : ''}`, agentId: s.id, kind: 'agent-error' });
      this.o.platform.notify(`${s.title} stopped with an error`, s.error ?? '', focus);
    }
  }

  // ---------------------------------------------------------------- commands

  require(agentId: string): AgentSummary {
    const a = this.supervisor.get(agentId);
    if (!a) throw new IpcError(`Unknown agent ${agentId}`, 'not_found');
    return a;
  }

  /** Agents on the Wall (archived ones are not in the supervisor). Each one passes the IPC contract. */
  list(): AgentSummary[] {
    return this.supervisor.list().flatMap((s) => this.contractSafe(s) ?? []);
  }

  async spawn(input: AgentSpecInput): Promise<AgentSummary[]> {
    const p = this.o.projects.require(input.projectId);
    if (this.o.mcpReady && !this.o.mcpReady()) throw new IpcError(MCP_DOWN, 'unavailable');
    let spec = input;
    // Presets store a "Your models" slot as `custom:<id>`: that is AgentSpec.customModel.
    const lead = spec.strategy.lead.model;
    if (lead.startsWith('custom:') && !spec.customModel) {
      const id = lead.slice('custom:'.length);
      const m = this.o.settings.get().models.custom.find((x) => x.id === id);
      if (!m) throw new IpcError(`Unknown custom model ${id}`, 'not_found');
      spec = { ...spec, customModel: { id }, strategy: { ...spec.strategy, lead: { ...spec.strategy.lead, model: m.model } } };
    }
    if (spec.workIn === 'project-folder') {
      if (spec.mode === 'bypassPermissions') throw new IpcError('Bypass agents must run in a worktree, never in the project folder.', 'forbidden');
      if ((spec.attempts ?? 1) > 1) throw new IpcError('Parallel attempts need worktrees; only one agent may hold the project folder.', 'conflict');
      const holder = this.list().find((a) => a.projectId === p.id && a.worktreePath && samePath(a.worktreePath, p.path) && !['stopped', 'error', 'done'].includes(a.status));
      if (holder) throw new IpcError(`"${holder.title}" already works in the project folder. Use a worktree, or stop it first.`, 'conflict');
    }
    if (spec.attachments?.length) {
      // Validated now so Spawn shows the problem; copied into the worktree once it exists (supervisor port).
      spec = { ...spec, attachments: await validateAttachments(spec.attachments, { picked: this.o.picked ?? new Set(), roots: [p.path] }) };
    }
    try {
      const out = await this.supervisor.spawn(spec);
      void this.extensions?.host?.activate('onAgentSpawn');
      return out;
    } catch (err) {
      if (err instanceof LaunchError) throw new IpcError(err.message, 'forbidden');
      throw err;
    }
  }

  /** Synchronous unless the message has attachments (then they are checked and copied first). */
  send(agentId: string, msg: UserMessage): void | Promise<void> {
    const a = this.require(agentId);
    if ((msg.kind === 'text' || msg.kind === 'artifact') && msg.attachments?.length) return this.sendWithAttachments(a, msg);
    try {
      this.supervisor.send(agentId, msg);
    } catch (err) {
      if (err instanceof LaunchError) throw new IpcError(err.message, 'conflict');
      throw err;
    }
  }

  /** Resume a stopped, paused, crashed or interrupted agent (`--resume`). */
  async resume(agentId: string): Promise<void> {
    this.require(agentId);
    try {
      await this.supervisor.resume(agentId);
    } catch (err) {
      if (err instanceof LaunchError) throw new IpcError(err.message, 'conflict');
      throw err;
    }
  }

  private async sendWithAttachments(a: AgentSummary, msg: Extract<UserMessage, { kind: 'text' | 'artifact' }>): Promise<void> {
    const roots = a.worktreePath ? [a.worktreePath] : [];
    const checked = await validateAttachments(msg.attachments, { picked: this.o.picked ?? new Set(), roots });
    const hasFiles = checked.some((x) => x.kind === 'file');
    if (hasFiles && !a.worktreePath) throw new IpcError('This agent has no folder yet. Attach files once it has started.', 'conflict');
    const attachments = hasFiles && a.worktreePath ? await copyAttachments(a.worktreePath, checked, this.o.picked ?? new Set()) : checked;
    this.supervisor.send(a.id, { ...msg, attachments });
  }

  async answerPermission(agentId: string, answer: PermissionAnswer): Promise<void> {
    this.require(agentId);
    const ok = await this.supervisor.answerPermission(agentId, answer);
    if (!ok) throw new IpcError('No pending permission request with that id for this agent.', 'not_found');
  }

  async setMode(agentId: string, mode: PermissionMode): Promise<void> {
    this.require(agentId);
    try {
      await this.supervisor.setMode(agentId, mode);
    } catch (err) {
      if (err instanceof LaunchError) throw new IpcError(err.message, 'forbidden');
      throw err;
    }
  }

  /**
   * Discard (Source control › Remove worktree, `agents.remove`): the agent is archived with reason
   * `discarded`, not deleted; its transcript stays readable in the Archived view.
   */
  async remove(agentId: string, deleteWorktree: boolean): Promise<void> {
    this.require(agentId);
    await this.archiveAgent(agentId, { reason: 'discarded', deleteWorktree });
  }

  /** Hard delete, no archive: the agent's project is being removed (its rows go with it). */
  async purge(agentId: string, deleteWorktree: boolean): Promise<void> {
    const a = this.require(agentId);
    await this.supervisor.remove(agentId, { deleteWorktree });
    if (a.worktreePath && deleteWorktree) this.o.ctx.roots.remove(a.worktreePath);
  }

  // ---------------------------------------------------------------- archived agents

  /** "Archive" on a tile or in Focus: only when the agent is not working on a turn. */
  async archive(agentId: string): Promise<AgentSummary> {
    const a = this.require(agentId);
    if (!ARCHIVABLE.has(a.status)) throw new IpcError(`"${a.title}" is still working. Stop it first, then archive it.`, 'conflict');
    return this.archiveAgent(agentId, { reason: a.status === 'done' ? 'completed' : 'archived-by-user' });
  }

  /** Archive for any reason (merge, discard, done, by hand). Worktree removal follows `deleteWorktree`. */
  async archiveAgent(agentId: string, opts: { reason: ArchiveReason; mergeCommit?: string; deleteWorktree?: boolean }): Promise<AgentSummary> {
    const a = this.require(agentId);
    const out = await this.supervisor.archive(agentId, opts);
    if (a.worktreePath && out.archived?.worktreeRemoved) this.o.ctx.roots.remove(a.worktreePath);
    this.o.ctx.reliability?.logs.agent(agentId).info(`archived (${opts.reason})`, { worktreeRemoved: out.archived?.worktreeRemoved ?? false });
    return this.contractSafe(out) ?? out;
  }

  /** The archived agent's record, or not_found. */
  private archivedRecord(agentId: string) {
    const r = this.o.store.agents.get(agentId);
    if (!r || r.archivedAt === undefined || !r.summary) throw new IpcError(`No archived agent ${agentId}`, 'not_found');
    return r;
  }

  /** Summary of a row in the Archived view; `archived` comes from the columns when the stored summary lost it. */
  private archivedSummary(r: { summary?: AgentSummary; archivedAt?: number; archiveReason?: ArchiveReason; mergeCommit?: string }): AgentSummary | undefined {
    if (!r.summary) return undefined;
    const s = r.summary.archived ? r.summary : { ...r.summary, archived: { at: r.archivedAt ?? r.summary.updatedAt, reason: r.archiveReason ?? 'archived-by-user', ...(r.mergeCommit ? { mergeCommit: r.mergeCommit } : {}), worktreeRemoved: false } };
    return this.contractSafe(s);
  }

  listArchived(input: { projectId?: string; query?: string; limit: number; cursor?: { at: number; id: string } }): ArchivedPage {
    const page = this.o.store.agents.listArchived(input);
    for (const sk of this.o.store.agents.skipped) this.o.ctx.log.warn('archived agent row unreadable; left out', sk);
    const items = page.records.flatMap((r) => (this.o.projects.get(r.projectId) ? (this.archivedSummary(r) ?? []) : []));
    return { items, total: page.total, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
  }

  getArchived(agentId: string): AgentSummary {
    const s = this.archivedSummary(this.archivedRecord(agentId));
    if (!s) throw new IpcError(`No archived agent ${agentId}`, 'not_found');
    return s;
  }

  /** Back to the Wall. Resumable when its session and worktree still exist; otherwise Resume is blocked. */
  async unarchive(agentId: string): Promise<AgentSummary> {
    if (this.supervisor.get(agentId)) return this.require(agentId);
    const r = this.archivedRecord(agentId);
    const p = this.o.projects.get(r.projectId);
    if (!p) throw new IpcError('Its project is not open in oIDE. Open the project first.', 'conflict');
    const summary = r.summary!;
    const wt = summary.worktreePath;
    const gone = Boolean(summary.archived?.worktreeRemoved) || (wt !== undefined && !existsSync(wt));
    const noSession = !summary.sessionId;
    if (wt && !gone && !samePath(p.path, wt)) this.o.ctx.roots.add(wt, 'worktree');
    this.rows.add(agentId);
    const back = this.supervisor.unarchive({
      spec: r.spec,
      summary,
      lastSeq: this.o.store.events.lastSeq(agentId),
      ...(gone ? { resumeBlocked: WORKTREE_GONE } : noSession ? { resumeBlocked: 'This agent never started a session, so there is nothing to resume.' } : {}),
    });
    this.lastStatus.set(agentId, back.status);
    this.o.ctx.reliability?.logs.agent(agentId).info('unarchived', { resumable: !back.resumeBlocked });
    return this.contractSafe(back) ?? back;
  }

  /**
   * Settings › Agents › Clean up "After 7 days": delete the worktree of a merged agent (archived by
   * now, or still on the Wall). Returns true when a folder was removed.
   */
  async removeWorktreeOf(agentId: string): Promise<boolean> {
    const live = this.supervisor.get(agentId);
    if (live) {
      if (!live.worktreePath) return false;
      await this.supervisor.remove(agentId, { deleteWorktree: true });
      this.o.ctx.roots.remove(live.worktreePath);
      return true;
    }
    const r = this.o.store.agents.get(agentId);
    const s = r?.summary;
    if (!r || !s?.archived || s.archived.worktreeRemoved || !s.worktreePath) return false;
    const removed = (await this.worktreeProvider().remove!({ agentId, path: s.worktreePath, projectId: r.projectId, ...(s.branch ? { branch: s.branch } : {}) })) !== false;
    if (!removed) return false;
    const next: AgentSummary = { ...s, archived: { ...s.archived, worktreeRemoved: true }, resumeBlocked: WORKTREE_GONE, updatedAt: Date.now() };
    this.o.store.agents.saveSummary(next);
    this.o.ctx.roots.remove(s.worktreePath);
    const safe = this.contractSafe(next);
    if (safe) this.o.ctx.emit('agents.archived', safe);
    return true;
  }

  /**
   * "Delete permanently" (after the native confirmation in the handler): the row and its events
   * go, as `agents.remove` did before archiving existed. A worktree still on disk goes with it.
   */
  async deletePermanently(agentId: string): Promise<void> {
    if (this.supervisor.get(agentId)) {
      await this.purge(agentId, true);
      return;
    }
    const r = this.o.store.agents.get(agentId);
    if (!r) throw new IpcError(`Unknown agent ${agentId}`, 'not_found');
    const s = r.summary;
    const wt = s?.worktreePath ?? r.worktreePath;
    if (wt && !s?.archived?.worktreeRemoved && existsSync(wt)) {
      await this.worktreeProvider().remove!({ agentId, path: wt, projectId: r.projectId, ...((s?.branch ?? r.branch) ? { branch: (s?.branch ?? r.branch)! } : {}) }).catch((err) => this.o.ctx.log.warn('worktree removal failed on delete', agentId, err));
      this.o.ctx.roots.remove(wt);
    }
    this.rows.delete(agentId);
    this.o.store.agents.remove(agentId);
    this.lastStatus.delete(agentId);
    this.o.ctx.emit('agents.removed', { agentId });
  }

  events(agentId: string, beforeSeq: number | undefined, limit: number): AgentEvent[] {
    return this.o.store.events.list(agentId, { ...(beforeSeq !== undefined ? { beforeSeq } : {}), limit });
  }

  /** Restore agents from the last run. Those that were working are resumed with `--resume`. */
  async restore(): Promise<AgentSummary[]> {
    // Archived agents stay in the database (Archived view); only the Wall's come back to the supervisor.
    const records = this.o.store.agents.list({ archived: false });
    // One unreadable row never hides the others (store.agents.list reads rows one by one).
    for (const sk of this.o.store.agents.skipped) this.o.ctx.log.error('agent row unreadable at restore; left out', sk);
    for (const rp of this.o.store.agents.repaired) this.o.ctx.log.warn('agent summary repaired at restore', rp);
    for (const r of records) if (!r.summary) this.o.ctx.log.warn('agent row has no usable summary; left out', { agent: r.id });
    // Working at quit (recorded by shutdown) or at a crash (status still live in the database).
    const marked = new Set(this.o.store.ui.kv.get<string[]>(RESUME_KEY) ?? []);
    this.o.store.ui.kv.delete(RESUME_KEY);
    const mcpDown = Boolean(this.o.mcpReady && !this.o.mcpReady());
    const entries = records
      .filter((r) => r.summary && this.o.projects.get(r.projectId))
      .map((r) => {
        const s = r.summary!;
        const working = ACTIVE.has(s.status) || marked.has(s.id);
        const interruption = !working ? undefined : mcpDown ? ('mcp-down' as const) : marked.has(s.id) ? ('restart' as const) : ('crash' as const);
        return { spec: r.spec, summary: s, lastSeq: this.o.store.events.lastSeq(r.id), ...(interruption ? { interruption } : {}) };
      });
    const wasActive = entries.filter((e) => e.interruption).map((e) => e.summary.id);
    for (const e of entries) {
      this.rows.add(e.summary.id);
      if (e.summary.worktreePath) {
        const p = this.o.projects.get(e.spec.projectId);
        if (p && !samePath(p.path, e.summary.worktreePath)) this.o.ctx.roots.add(e.summary.worktreePath, 'worktree');
      }
    }
    const restored = this.supervisor.restore(entries);
    for (const s of restored) this.lastStatus.set(s.id, s.status);
    if (wasActive.length && mcpDown) {
      // No permission-prompt server: leave them stopped and resumable, and resume on the next start.
      this.o.store.ui.kv.set(RESUME_KEY, wasActive);
      this.deferredResume = wasActive;
      this.o.ctx.log.warn('MCP server down: not resuming agents', { count: wasActive.length });
      return this.list();
    }
    for (const id of wasActive) await this.supervisor.resume(id).catch((err) => this.o.ctx.log.warn('resume after restart failed', id, err));
    return this.list();
  }

  /** Quit: deny pending prompts (broker), stop processes; sessions stay resumable and resume on next start. */
  async shutdown(): Promise<void> {
    const live = this.list().filter((a) => ACTIVE.has(a.status) || this.deferredResume.includes(a.id)).map((a) => a.id);
    this.o.store.ui.kv.set(RESUME_KEY, live);
    await this.o.mcp.close().catch(() => undefined);
    await this.supervisor.shutdown();
    this.eventWriter.flush();
    if (this.eventWriter.queued || this.eventWriter.dropped) this.o.ctx.log.warn('agent events not saved at quit', { queued: this.eventWriter.queued, dropped: this.eventWriter.dropped });
  }
}
