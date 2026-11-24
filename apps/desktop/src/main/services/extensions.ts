import { join, relative } from 'node:path';
import type { ExtensionToolRef, McpServerEntry } from '@oide/agent-core';
import {
  CustomTools,
  DevModeWatcher,
  ExtensionHostClient,
  ExtensionRegistry,
  MarketplaceInstaller,
  McpProxy,
  capabilityList,
  createHostServices,
  effectiveToolRisk,
  ExtensionConflictError,
  loadFromFolder,
  mcpToolName,
  resolveAgentMcpConfig,
  upstreamFrom,
  type ConfirmRequest,
  type HostExtension,
  type LoadedExtension,
  type ProjectRef,
  type SecretStore as HostSecretStore,
} from '@oide/extension-host';
import type { AgentSpec, AgentSummary, ExtensionUpdate, InstalledExtension, MarketplaceEntry } from '@oide/protocol';
import { readOideFile, type SecretStore, type Store } from '@oide/store';
import type { MainContext } from '../context.js';
import { IpcError } from '../ipc/router.js';
import { confirmNative, safeDialogText as q } from '../security/confirm.js';
import type { Platform } from './platform.js';
import type { ProjectsService } from './projects.js';

/**
 * The extension host package writes keys like `extension/<name>/<key>` and `custom/<id>/…`; the
 * store's SecretStore only accepts its own namespaces (`ext:`, `mcp:`). This maps one onto the other.
 */
export function hostSecretAdapter(s: SecretStore): HostSecretStore {
  const key = (k: string) => k.replace(/^extension\//, 'ext:').replace(/^custom\//, 'mcp:');
  return {
    get: (k) => s.get(key(k)),
    set: (k, v) => s.set(key(k), v),
    delete: (k) => {
      s.delete(key(k));
    },
  };
}

export interface AgentExtensionConfig {
  servers: Record<string, McpServerEntry>;
  tools: ExtensionToolRef[];
  env: Record<string, string>;
  warnings: string[];
}

/**
 * Extension registry + marketplace installer + Add custom + loopback MCP proxy + host processes,
 * and the per-agent MCP configuration (`agentConfig`) the supervisor's SettingsProvider uses.
 */
export class ExtensionsService {
  readonly registry: ExtensionRegistry;
  readonly installer: MarketplaceInstaller;
  readonly custom: CustomTools;
  readonly proxy: McpProxy;
  readonly host: ExtensionHostClient | undefined;
  readonly hostSecrets: HostSecretStore;
  private readonly dev: DevModeWatcher;
  private readonly agentSecrets = new Map<string, string>();
  private readonly memo = new Map<string, { at: number; p: Promise<AgentExtensionConfig> }>();

  constructor(
    private readonly o: {
      ctx: MainContext;
      store: Store;
      secrets: SecretStore;
      platform: Platform;
      projects: ProjectsService;
      agents: { list(): AgentSummary[]; send(agentId: string, text: string): void };
      /** `projectId` lets the host check the extension is on for the artifact's project (SEC-23). */
      readArtifact(id: string): Promise<{ id: string; title: string; kind: string; content: string; version?: number; projectId?: string | undefined }>;
    },
  ) {
    const { ctx, store, platform } = o;
    this.hostSecrets = hostSecretAdapter(o.secrets);
    const projectRef = (id: string): ProjectRef | undefined => {
      const p = o.projects.get(id);
      return p ? { id: p.id, name: p.name, root: p.path, trusted: p.trusted } : undefined;
    };
    this.registry = new ExtensionRegistry({
      repo: { list: () => store.extensions.list(), upsert: (e) => void store.extensions.upsert(e), remove: (id) => void store.extensions.remove(id) },
      projects: {
        project: projectRef,
        read: async (id) => {
          const p = o.projects.get(id);
          if (!p) return null;
          const f = await readOideFile(p.path, 'extensions');
          return f.exists && !f.errors.length ? f.value : null;
        },
      },
      builtinDirs: platform.builtinExtensionDirs,
      onLoadError: (dir, err) => ctx.log.warn('extension failed to load', dir, err.message),
    });
    this.installer = new MarketplaceInstaller({
      extensionsDir: join(ctx.userDataDir, 'extensions'),
      cacheDir: join(ctx.userDataDir, 'marketplace'),
      ...(platform.bundledIndexPath ? { bundledIndexPath: platform.bundledIndexPath } : {}),
      ...(platform.fetch ? { fetch: platform.fetch } : {}),
    });
    this.custom = new CustomTools({
      repo: { list: () => store.customServers.list(), upsert: (c) => void store.customServers.upsert(c), remove: (id) => void store.customServers.remove(id) },
      secrets: this.hostSecrets,
      openExternal: (url) => platform.openExternal(url),
      project: projectRef,
      openProjects: () => o.projects.list().map((p) => ({ id: p.id, name: p.name, root: p.path, trusted: p.trusted })),
      confirm: (req) => this.confirmCustom(req),
      ...(platform.fetch ? { fetch: platform.fetch } : {}),
    });
    this.proxy = new McpProxy({
      resolve: async (server) => {
        const s = store.customServers.list().find((x) => x.name === server);
        if (!s || s.transport.kind !== 'http') return undefined;
        return upstreamFrom(s.transport.url, this.custom.tokenSource(s));
      },
      ...(platform.fetch ? { fetch: platform.fetch } : {}),
    });
    const settingsKv = store.ui.kv;
    this.host = platform.forkHost
      ? new ExtensionHostClient({
          fork: platform.forkHost,
          ...(platform.hostEntry ? { entry: platform.hostEntry } : {}),
          services: createHostServices({
            extension: (name) => this.registry.getByName(name),
            isEnabledFor: (ext, projectId) => this.registry.isEnabledFor(ext, projectId),
            settings: { get: (k) => settingsKv.get(`ext-setting:${k}`), set: (k, v) => settingsKv.set(`ext-setting:${k}`, v) },
            secrets: this.hostSecrets,
            listAgents: () =>
              o.agents.list().map((a) => ({
                id: a.id,
                projectId: a.projectId,
                title: a.title,
                status: a.status,
                model: a.model,
                ...(a.branch ? { branch: a.branch } : {}),
                ...(a.worktreePath ? { worktreePath: a.worktreePath } : {}),
              })),
            postMessage: (agentId, text) => o.agents.send(agentId, text),
            openPanel: () => undefined,
            postPanelMessage: () => undefined,
            readArtifact: (id) => o.readArtifact(id),
            log: (ext, level, message) => (level === 'error' ? ctx.log.error : level === 'warn' ? ctx.log.warn : ctx.log.debug)(`[ext ${ext}]`, message),
          }),
        })
      : undefined;
    this.dev = new DevModeWatcher({
      onReload: async ({ extension }) => {
        await this.host?.restart(extension.name, this.hostExtension(extension));
        ctx.emit('notify', { level: 'info', message: `Reloaded ${extension.displayName}. New agents get its changed tools.` });
      },
    });
  }

  async start(): Promise<void> {
    await this.registry.load();
    await this.proxy.start();
    this.registry.onChange((list) => {
      this.memo.clear();
      this.o.ctx.emit('extensions.changed', list);
      this.syncHost();
    });
    this.host?.onState((s) => this.o.ctx.emit('extensions.hostState', { name: s.name, state: s.state, panelIds: s.panelIds, ...(s.error ? { error: s.error } : {}) }));
    this.syncHost();
    for (const e of this.registry.list()) if (e.source === 'folder' && e.devMode) this.tryWatch(e);
    void this.host?.activate('onStartup');
  }

  private tryWatch(e: InstalledExtension): void {
    try {
      this.dev.watch(e);
    } catch (err) {
      this.o.ctx.log.warn('developer mode watch failed', e.name, err);
    }
  }

  private hostExtension(e: InstalledExtension): HostExtension | undefined {
    const l = this.registry.resolved(e.id);
    if (!l?.main) return undefined;
    return {
      name: e.name,
      version: e.version,
      dir: l.dir,
      main: l.main,
      activation: l.activation,
      panelIds: l.panels.map((p) => p.id),
      commandIds: l.manifest.oide.contributes.commands.map((c) => c.id),
    };
  }

  /** Host code runs only for extensions that are on somewhere (globally or in a project). */
  private syncHost(): void {
    if (!this.host) return;
    const list = this.registry
      .list()
      .filter((e) => e.enabledGlobally || e.enabledProjects.length > 0)
      .map((e) => this.hostExtension(e))
      .filter((x): x is HostExtension => !!x);
    this.host.setExtensions(list);
  }

  installed(): InstalledExtension[] {
    return this.registry.list();
  }

  async index(refresh: boolean): Promise<MarketplaceEntry[]> {
    return (await this.installer.getIndex({ refresh })).index.extensions;
  }

  async install(name: string, version?: string): Promise<InstalledExtension> {
    const r = await this.installer.install(name, version).catch((err: Error) => {
      throw new IpcError(err.message, 'install_failed');
    });
    for (const w of r.warnings) this.o.ctx.emit('notify', { level: 'warning', message: `${r.record.displayName}: ${w}` });
    return this.addRecord(r.record, r.loaded);
  }

  /** registry.add, with a name taken by another source refused as a conflict (SEC-13). */
  private async addRecord(record: InstalledExtension, loaded: LoadedExtension): Promise<InstalledExtension> {
    try {
      return await this.registry.add(record, loaded);
    } catch (err) {
      if (err instanceof ExtensionConflictError) throw new IpcError(err.message, 'conflict');
      throw err;
    }
  }

  async uninstall(id: string): Promise<void> {
    const prev = this.registry.get(id);
    if (!prev) throw new IpcError(`Unknown extension ${id}`, 'not_found');
    if (prev.source === 'builtin') throw new IpcError(`${prev.displayName} is built in; turn it off instead.`, 'forbidden');
    this.dev.unwatch(id);
    await this.host?.stop(prev.name);
    await this.registry.remove(id);
    await this.installer.removeFiles(prev);
    // `ext:<name>/` with the slash: removing `foo` must not delete `foo-bar`'s secrets.
    for (const k of this.o.secrets.keys(`ext:${prev.name}/`)) this.o.secrets.delete(k);
    this.o.store.ui.kv.delete(runConfirmedKey(id));
  }

  async setEnabled(id: string, enabled: boolean, projectId?: string): Promise<InstalledExtension> {
    const ext = this.registry.get(id);
    if (!ext) throw new IpcError(`Unknown extension ${id}`, 'not_found');
    if (enabled) await this.confirmFirstRun(ext);
    return this.registry.setEnabled(id, enabled, projectId);
  }

  /**
   * SEC-06 / SEC-07: the first time an unreviewed (folder or git) extension is turned on, main asks
   * natively and shows what will run. The answer is remembered for that extension and folder.
   */
  private async confirmFirstRun(ext: InstalledExtension): Promise<void> {
    if (ext.source !== 'folder' && ext.source !== 'git') return;
    const kv = this.o.store.ui.kv;
    if (kv.get<string>(runConfirmedKey(ext.id)) === ext.path) return;
    const l = this.registry.resolved(ext.id);
    const runs: string[] = [];
    // SEC-31: every value from the extension is escaped, so it cannot add or hide lines in the dialog.
    if (l?.main) runs.push(`Host code: ${q(relative(l.dir, l.main))} (runs in oIDE as soon as it is on)`);
    for (const [name, s] of Object.entries(l?.mcpServers ?? {})) runs.push(`MCP server "${q(name, { max: 80 })}": ${q(commandLine(s.command, s.args))} (agents start it)`);
    for (const lang of l?.languages ?? []) runs.push(`Language server for ${q(lang.id, { max: 80 })}: ${q(commandLine(lang.command, lang.args))}`);
    const caps = l ? capabilityList(l.manifest).map((c) => q(c)) : [];
    const ok = await confirmNative(this.o.ctx, {
      title: 'Turn on unreviewed extension?',
      message: `Turn on ${q(ext.displayName, { max: 80 })}? Its code has not been reviewed.`,
      detail: [
        `${q(ext.name)} ${q(ext.version)}, from ${ext.source === 'git' ? 'a git repository' : 'a folder'}: ${q(ext.path)}`,
        '',
        runs.length ? 'It will run as you, with full access to your files, network and programs:' : 'It has no host code or servers; only its panels load.',
        ...runs.map((r) => `- ${r}`),
        '',
        caps.length ? `Declared capabilities (not enforced): ${caps.join(', ')}` : 'Declared capabilities: none (not enforced either way).',
        'Its tools always ask before they run.',
      ].join('\n'),
      confirmLabel: 'Turn on',
      danger: true,
    });
    if (!ok) throw new IpcError(`${ext.displayName} was not turned on.`, 'forbidden');
    kv.set(runConfirmedKey(ext.id), ext.path);
  }

  /** The native confirmation behind CustomTools (probe, stdio save, import, pre-allowed tools). */
  private async confirmCustom(req: ConfirmRequest): Promise<boolean> {
    const stdio = req.servers.filter((s) => s.command !== undefined);
    const lines: string[] = [];
    for (const s of req.servers) {
      if (s.command !== undefined) {
        lines.push(`${q(s.name, { max: 80 })}: ${q(commandLine(s.command, s.args ?? []))}`);
        if (s.envKeys?.length) lines.push(`  Environment variables: ${s.envKeys.map((k) => q(k)).join(', ')}`);
      } else if (s.url) lines.push(`${q(s.name, { max: 80 })}: ${q(s.url)}`);
      if (s.preAllowed.length) lines.push(`  Runs without asking: ${s.preAllowed.map((t) => q(t)).join(', ')}`);
    }
    const what =
      req.kind === 'probe'
        ? 'oIDE starts it once now, as you, to list its tools.'
        : stdio.length
          ? 'Every new agent in the chosen projects starts it, as you, with full access to your files and network.'
          : 'Agents will call these tools without a permission prompt.';
    const message =
      req.kind === 'probe'
        ? 'Run this command to list its tools?'
        : stdio.length
          ? `Let agents run ${stdio.length === 1 ? 'this command' : `these ${stdio.length} commands`}?`
          : 'Let agents call these tools without asking?';
    return confirmNative(this.o.ctx, {
      title: req.kind === 'probe' ? 'Run a local command?' : 'Add custom tools?',
      message,
      detail: [...lines, '', what, 'Only continue if you entered or chose this yourself.'].join('\n'),
      confirmLabel: req.kind === 'probe' ? 'Run' : 'Add',
      danger: stdio.length > 0,
    });
  }

  /** Per-tool on/off. Off tools go to `--disallowedTools` for new agents. */
  async setToolEnabled(id: string, tool: string, enabled: boolean, server?: string): Promise<InstalledExtension> {
    if (!this.registry.get(id)) throw new IpcError(`Unknown extension ${id}`, 'not_found');
    let full = tool.startsWith('mcp__') ? tool : undefined;
    if (!full) {
      const hit = this.registry.resolved(id)?.tools.find((t) => t.tool === tool && (!server || t.server === server));
      if (!hit) throw new IpcError(`${id} has no tool ${tool}`, 'not_found');
      full = mcpToolName(hit.server, hit.tool);
    }
    return this.registry.setToolEnabled(id, full, enabled);
  }

  async addFromFolder(dir: string, devMode: boolean): Promise<InstalledExtension> {
    let r;
    try {
      r = loadFromFolder(dir, { devMode });
    } catch (err) {
      throw new IpcError((err as Error).message, 'invalid_extension');
    }
    const rec = await this.addRecord(r.record, r.loaded);
    if (rec.devMode) this.tryWatch(rec);
    return rec;
  }

  /** SEC-06: nothing is cloned until the user confirms this URL natively. */
  async addFromGit(url: string): Promise<InstalledExtension> {
    const ok = await confirmNative(this.o.ctx, {
      title: 'Add an extension from git?',
      message: 'Download this unreviewed extension?',
      detail: `${q(url)}\n\noIDE clones the repository without running anything. Its code has not been reviewed; oIDE asks again before any of it runs, when you turn it on.`,
      confirmLabel: 'Download',
    });
    if (!ok) throw new IpcError('Cancelled: nothing was downloaded.', 'forbidden');
    const r = await this.installer.installFromGit(url).catch((err: Error) => {
      throw new IpcError(err.message, 'install_failed');
    });
    return this.addRecord(r.record, r.loaded);
  }

  updates(): Promise<ExtensionUpdate[]> {
    return this.installer.checkUpdates(this.registry.list());
  }

  /** Update one marketplace extension; refused without consent when it adds tools or capabilities. */
  async update(id: string, consent: boolean): Promise<InstalledExtension> {
    const cur = this.registry.get(id);
    if (!cur) throw new IpcError(`Unknown extension ${id}`, 'not_found');
    const [u] = await this.installer.checkUpdates([cur]);
    if (!u) throw new IpcError(`${cur.displayName} is up to date`, 'not_found');
    if (u.needsConsent && !consent) throw new IpcError(`Updating ${cur.displayName} adds tools or capabilities; confirm to continue.`, 'consent_required');
    const r = await this.installer.install(cur.name, u.to).catch((err: Error) => {
      throw new IpcError(err.message, 'install_failed');
    });
    const next: InstalledExtension = {
      ...r.record,
      enabledGlobally: cur.enabledGlobally,
      enabledProjects: cur.enabledProjects,
      disabledProjects: cur.disabledProjects,
      disabledTools: cur.disabledTools,
    };
    await this.host?.stop(cur.name);
    const saved = await this.registry.add(next, r.loaded);
    if (cur.path !== next.path) await this.installer.removeFiles(cur);
    return saved;
  }

  async runCommand(commandId: string, args: unknown[]): Promise<unknown> {
    if (!this.host) throw new IpcError('Extension host code is not available in this build', 'unavailable');
    try {
      return await this.host.runCommand(commandId, args);
    } catch (err) {
      throw new IpcError((err as Error).message, 'command_failed');
    }
  }

  // ---------------------------------------------------------------- per-agent MCP config

  /**
   * Extension and custom MCP servers for one agent: the servers for its mcp.json, the tool refs
   * (risk labels → --allowedTools / --disallowedTools) and the env secrets for `${VAR}` placeholders.
   * `spec.extensions` narrows to those ids; empty means every extension on for the project.
   */
  agentConfig(spec: AgentSpec, agentId: string): Promise<AgentExtensionConfig> {
    const hit = this.memo.get(agentId);
    if (hit && Date.now() - hit.at < 5_000) return hit.p;
    const p = this.computeConfig(spec, agentId);
    this.memo.set(agentId, { at: Date.now(), p });
    return p;
  }

  private async computeConfig(spec: AgentSpec, agentId: string): Promise<AgentExtensionConfig> {
    const project = this.o.projects.get(spec.projectId);
    let enabled = await this.registry.enabledFor(spec.projectId);
    if (spec.extensions.length) enabled = enabled.filter((e) => spec.extensions.includes(e.id));
    const extensions = enabled.flatMap((record) => {
      const loaded = this.registry.resolved(record.id);
      return loaded ? [{ record, loaded }] : [];
    });
    const customServers = this.o.store.customServers.list();
    let secret = this.agentSecrets.get(agentId);
    if (!secret) {
      secret = this.proxy.issueAgentSecret(agentId, []);
      this.agentSecrets.set(agentId, secret);
    }
    const cfg = await resolveAgentMcpConfig({
      projectId: spec.projectId,
      extensions,
      customServers,
      projectTrusted: project?.trusted ?? false,
      proxy: this.proxy.routeFor(secret),
      secretStore: this.hostSecrets,
    });
    // SEC-10: this agent's proxy secret opens only the remote servers in its own config.
    const proxied = Object.entries(cfg.mcpServers)
      .filter(([name, s]) => s.type === 'http' && s.url === this.proxy.urlFor(name))
      .map(([name]) => name);
    this.proxy.setAgentServers(agentId, proxied);
    const servers: Record<string, McpServerEntry> = {};
    for (const [name, s] of Object.entries(cfg.mcpServers)) {
      servers[name] = s.type === 'stdio' ? { type: 'stdio', command: s.command, args: s.args, ...(s.env ? { env: s.env } : {}) } : { type: 'http', url: s.url, ...(s.headers ? { headers: s.headers } : {}) };
    }
    const tools: ExtensionToolRef[] = [];
    for (const { record, loaded } of extensions) {
      const off = new Set(record.disabledTools);
      // SEC-15: folder and git extensions cannot pre-allow their own tools by labelling them `read`.
      for (const t of loaded.tools) tools.push({ server: t.server, tool: t.tool, risk: effectiveToolRisk(record, t.risk), enabled: !off.has(mcpToolName(t.server, t.tool)) });
    }
    for (const s of customServers) {
      if (!(s.name in servers) && !(s.savedTo === 'project-mcp-json' && project?.trusted)) continue;
      for (const t of s.tools) tools.push({ server: s.name, tool: t.name, risk: t.risk, enabled: t.enabled });
    }
    for (const w of cfg.warnings) this.o.ctx.log.warn('[mcp config]', w);
    return { servers, tools, env: cfg.env, warnings: cfg.warnings };
  }

  revokeAgent(agentId: string): void {
    this.agentSecrets.delete(agentId);
    this.memo.delete(agentId);
    this.proxy.revokeAgent(agentId);
  }

  async dispose(): Promise<void> {
    this.dev.dispose();
    await this.host?.dispose().catch(() => undefined);
    await this.proxy.stop().catch(() => undefined);
  }
}

/** ui kv key: the folder the user confirmed running this unreviewed extension from. */
function runConfirmedKey(id: string): string {
  return `ext-run-confirmed:${id}`;
}

/** A command line as it will be spawned, quoting arguments with spaces. */
function commandLine(command: string, args: string[]): string {
  return [command, ...args].map((a) => (/[\s"]/.test(a) || a === '' ? JSON.stringify(a) : a)).join(' ');
}
