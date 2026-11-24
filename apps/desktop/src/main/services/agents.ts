import { isAbsolute, relative, resolve } from 'node:path';
import { LaunchError, Supervisor, type AgentDriver, type EventSink, type SecretProvider, type SettingsProvider, type WorktreeProvider } from '@oide/agent-core';
import { Git, isInside, pathKey, samePath, type WorktreeManager } from '@oide/git';
import type { OideMcpServer } from '@oide/mcp-server';
import { ENTRY_FILES, readOideFile, type SecretStore, type SettingsService, type Store } from '@oide/store';
import type { AgentEvent, AgentSpecInput, AgentStatus, AgentSummary, ArtifactKind, PermissionAnswer, PermissionMode, UserMessage } from '@oide/protocol';
import type { MainContext } from '../context.js';
import { IpcError } from '../ipc/router.js';
import { boundModelKey } from '../security/model-keys.js';
import type { CliService } from './cli.js';
import type { ExtensionsService } from './extensions.js';
import type { GitService } from './git.js';
import type { Platform } from './platform.js';
import type { ProjectsService } from './projects.js';

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const ACTIVE: ReadonlySet<AgentStatus> = new Set(['starting', 'running', 'needs-permission']);
const RESUME_KEY = 'agents:resume-on-start';

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
  /** Set after construction (cycle). */
  extensions?: ExtensionsService;
  git?: GitService;
  driver?: AgentDriver;
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
  extensions: ExtensionsService | undefined;
  git: GitService | undefined;

  constructor(private readonly o: AgentsServiceOptions) {
    this.extensions = o.extensions;
    this.git = o.git;
    this.supervisor = new Supervisor({
      worktrees: this.worktreeProvider(),
      sink: this.eventSink(),
      settings: this.settingsProvider(),
      secrets: this.secretProvider(),
      broker: o.mcp,
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
      runSetup: async ({ path, spec, onOutput }) => {
        const p = o.projects.get(spec.projectId);
        // Workspace trust: an untrusted repo's .oide/setup never runs. Nor in the user's own checkout.
        if (!p?.trusted || spec.workIn === 'project-folder' || samePath(path, p.path)) return { ok: true };
        const eff = await o.settings.forProject(p.path, { trusted: true });
        if (!eff.setup) return { ok: true };
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
        if (!p || samePath(path, p.path)) return;
        await this.git?.unwatch(path);
        await o.worktrees.remove(p.path, path, { force: true, deleteBranch: true });
        o.ctx.roots.remove(path);
        this.git?.changed(projectId);
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
        try {
          o.store.events.append(e, safeJson(raw));
        } catch (err) {
          o.ctx.log.warn('could not store event', e.type, (err as Error).message);
        }
        this.onEvent(e);
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
        if (!p) return o.settings.get().techniques;
        return (await o.settings.forProject(p.path, { trusted: p.trusted })).techniques;
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

  private onSummary(s: AgentSummary): void {
    const { o } = this;
    o.ctx.emit('agents.summary', s);
    if (s.worktreePath && !o.ctx.roots.list('worktree').some((r) => samePath(r, s.worktreePath!))) {
      const p = o.projects.get(s.projectId);
      if (p && !samePath(p.path, s.worktreePath)) o.ctx.roots.add(s.worktreePath, 'worktree');
      if (p?.trusted) this.git?.watch(s.worktreePath, s.projectId);
    }
    const prev = this.lastStatus.get(s.id);
    if (prev === s.status) return;
    this.lastStatus.set(s.id, s.status);
    if (!ACTIVE.has(s.status)) this.editing.clear(s.id);
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
      this.o.ctx.emit('notify', { level: 'warning', message: `${s.title} needs permission: ${what}`, agentId: s.id });
      this.o.platform.notify(`${s.title} needs permission`, what, focus);
    } else if (s.status === 'ready-for-review' && n.readyForReview) {
      this.o.ctx.emit('notify', { level: 'info', message: `${s.title} is ready for review`, agentId: s.id });
      this.o.platform.notify(`${s.title} is ready for review`, s.review?.summary.slice(0, 200) ?? '', focus);
    } else if (s.status === 'error' && n.error) {
      this.o.ctx.emit('notify', { level: 'error', message: `${s.title} stopped with an error${s.error ? `: ${s.error}` : ''}`, agentId: s.id });
      this.o.platform.notify(`${s.title} stopped with an error`, s.error ?? '', focus);
    }
  }

  // ---------------------------------------------------------------- commands

  require(agentId: string): AgentSummary {
    const a = this.supervisor.get(agentId);
    if (!a) throw new IpcError(`Unknown agent ${agentId}`, 'not_found');
    return a;
  }

  list(): AgentSummary[] {
    return this.supervisor.list();
  }

  async spawn(input: AgentSpecInput): Promise<AgentSummary[]> {
    const p = this.o.projects.require(input.projectId);
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
    try {
      const out = await this.supervisor.spawn(spec);
      void this.extensions?.host?.activate('onAgentSpawn');
      return out;
    } catch (err) {
      if (err instanceof LaunchError) throw new IpcError(err.message, 'forbidden');
      throw err;
    }
  }

  send(agentId: string, msg: UserMessage): void {
    this.require(agentId);
    this.supervisor.send(agentId, msg);
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

  async remove(agentId: string, deleteWorktree: boolean): Promise<void> {
    const a = this.require(agentId);
    await this.supervisor.remove(agentId, { deleteWorktree });
    if (a.worktreePath && deleteWorktree) this.o.ctx.roots.remove(a.worktreePath);
  }

  events(agentId: string, beforeSeq: number | undefined, limit: number): AgentEvent[] {
    return this.o.store.events.list(agentId, { ...(beforeSeq !== undefined ? { beforeSeq } : {}), limit });
  }

  /** Restore agents from the last run. Those that were working are resumed with `--resume`. */
  async restore(): Promise<AgentSummary[]> {
    const records = this.o.store.agents.list();
    const entries = records.filter((r) => r.summary && this.o.projects.get(r.projectId)).map((r) => ({ spec: r.spec, summary: r.summary!, lastSeq: this.o.store.events.lastSeq(r.id) }));
    // Working at quit (recorded by shutdown) or at a crash (status still live in the database).
    const marked = new Set(this.o.store.ui.kv.get<string[]>(RESUME_KEY) ?? []);
    this.o.store.ui.kv.delete(RESUME_KEY);
    const wasActive = entries.filter((e) => ACTIVE.has(e.summary.status) || marked.has(e.summary.id)).map((e) => e.summary.id);
    for (const e of entries) {
      this.rows.add(e.summary.id);
      if (e.summary.worktreePath) {
        const p = this.o.projects.get(e.spec.projectId);
        if (p && !samePath(p.path, e.summary.worktreePath)) this.o.ctx.roots.add(e.summary.worktreePath, 'worktree');
      }
    }
    const restored = this.supervisor.restore(entries);
    for (const s of restored) this.lastStatus.set(s.id, s.status);
    for (const id of wasActive) await this.supervisor.resume(id).catch((err) => this.o.ctx.log.warn('resume after restart failed', id, err));
    return this.list();
  }

  /** Quit: deny pending prompts (broker), stop processes; sessions stay resumable and resume on next start. */
  async shutdown(): Promise<void> {
    const live = this.list().filter((a) => ACTIVE.has(a.status)).map((a) => a.id);
    this.o.store.ui.kv.set(RESUME_KEY, live);
    await this.o.mcp.close().catch(() => undefined);
    await this.supervisor.shutdown();
  }
}
