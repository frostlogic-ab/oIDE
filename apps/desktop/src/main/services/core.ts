import { existsSync, realpathSync, statSync } from 'node:fs';
import { extname, join, relative, resolve, sep } from 'node:path';
import type { AgentDriver } from '@oide/agent-core';
import { WorktreeManager, type GhCli } from '@oide/git';
import { OideMcpServer, type ArtifactsBackend as McpArtifactsBackend } from '@oide/mcp-server';
import { ArtifactStore, SqliteSecretStore, openStore, type Store } from '@oide/store';
import type { MainContext } from '../context.js';
import { AgentsService } from './agents.js';
import { CliService } from './cli.js';
import { ExtensionsService } from './extensions.js';
import { GitService, parcelWatch, type WatchFn } from './git.js';
import type { Platform } from './platform.js';
import { ProjectsService } from './projects.js';
import type { TerminalService } from './terminals.js';

export interface Services {
  platform: Platform;
  terminals: TerminalService;
  store: Store;
  secrets: SqliteSecretStore;
  worktrees: WorktreeManager;
  artifacts: ArtifactStore;
  mcp: OideMcpServer;
  cli: CliService;
  projects: ProjectsService;
  agents: AgentsService;
  git: GitService;
  extensions: ExtensionsService;
  /** Paths the user picked in a native dialog (only these may be imported / loaded as extensions). */
  picked: Set<string>;
  /** Notices raised before the window could show them (sent after load). */
  notices: Array<{ level: 'info' | 'warning' | 'error'; message: string }>;
  flushNotices(): void;
  dispose(): Promise<void>;
}

export interface CoreOptions {
  ctx: MainContext;
  platform: Platform;
  terminals: TerminalService;
  /** Database file; default `<userData>/oide.db`. `':memory:'` in tests. */
  dbFile?: string;
  driver?: AgentDriver;
  watch?: WatchFn;
  gh?: GhCli;
}

/** Artifacts store → the MCP server's ctx-based backend (agent attribution and project scoping). */
function mcpArtifacts(store: ArtifactStore): McpArtifactsBackend {
  return {
    list: async (ctx, f) => {
      const all = await store.list({ ...(f.kind ? { kind: f.kind } : {}) }, ctx.agentId);
      const q = f.query?.toLowerCase();
      return all.filter((m) => (!m.projectId || !ctx.projectId || m.projectId === ctx.projectId) && (!q || m.title.toLowerCase().includes(q)));
    },
    read: (ctx, id) => store.read(id, ctx.agentId),
    write: (ctx, id, content) => store.write(id, content, ctx.agentId),
    create: (ctx, input) => store.createForAgent({ title: input.title, kind: input.kind, content: input.content, ...(ctx.projectId ? { projectId: ctx.projectId } : {}) }, ctx.agentId),
  };
}

/**
 * Build every domain service. Plain Node: Electron-only pieces come through `platform`.
 * Startup work: migrations (openStore), worktree prune + orphan listing, event compaction
 * (30 days), artifact rescan, extensions, and `restore()` of agents (working ones resume).
 */
export async function createCoreServices(opts: CoreOptions): Promise<Services> {
  const { ctx, platform } = opts;
  const store = openStore(opts.dbFile ?? join(ctx.userDataDir, 'oide.db'), { backupDir: join(ctx.userDataDir, 'backups') });
  const notices: Services['notices'] = [];
  const settings = store.settings;
  for (const e of settings.loadErrors) notices.push({ level: 'warning', message: e });
  const secrets = new SqliteSecretStore(store.database, platform.cipher);
  if (platform.cipher.available && !platform.cipher.available()) {
    notices.push({ level: 'warning', message: 'Secure storage (the OS keychain) is not available, so oIDE will not save API keys or tokens. Custom model keys and MCP secrets cannot be stored until it is.' });
  }
  settings.onChange((s) => ctx.emit('settings.changed', s));

  const worktrees = new WorktreeManager({ appDataDir: ctx.userDataDir, location: settings.get().agents.worktreeLocation });
  const artifacts = new ArtifactStore({
    db: store.database,
    appDataDir: ctx.userDataDir,
    projectPath: (id) => store.projects.pathOf(id),
    onChange: (id) => ctx.emit('artifacts.changed', id ? { id } : {}),
  });
  ctx.roots.add(artifacts.root('app-data'), 'artifact');

  const mcp = new OideMcpServer({
    appDataDir: ctx.userDataDir,
    artifacts: mcpArtifacts(artifacts),
    onArtifactUse: (u) => ctx.emit('artifacts.changed', u.artifactId && u.artifactId !== '*' ? { id: u.artifactId } : {}),
    log: (m, d) => ctx.log.debug('[mcp]', m, d ?? ''),
  });
  await mcp.start();

  const cli = new CliService({ settings, emit: ctx.emit, override: platform.cliPathOverride });
  const projects = new ProjectsService({ ctx, store, platform });
  const agents = new AgentsService({ ctx, store, settings, secrets, worktrees, mcp, projects, cli, platform, ...(opts.driver ? { driver: opts.driver } : {}) });
  const git = new GitService({
    ctx,
    store,
    settings,
    worktrees,
    projects,
    agents: { list: () => agents.list(), get: (id) => agents.supervisor.get(id), setDiff: (id, d) => agents.supervisor.setDiff(id, d) },
    removeAgent: (id) => agents.remove(id, true),
    watch: platform.background ? (opts.watch ?? parcelWatch) : opts.watch,
    background: platform.background,
    ...(opts.gh ? { gh: opts.gh } : {}),
  });
  const extensions = new ExtensionsService({
    ctx,
    store,
    secrets,
    platform,
    projects,
    agents: { list: () => agents.list(), send: (id, text) => agents.send(id, { kind: 'text', text }) },
    readArtifact: async (id) => {
      const { meta, content } = await artifacts.read(id);
      return { id: meta.id, title: meta.title, kind: meta.kind, content, version: meta.version };
    },
  });
  agents.extensions = extensions;
  agents.git = git;

  projects.onOpened(async (p) => {
    git.watch(p.path, p.id);
    await artifacts.rescan([{ id: p.id, path: p.path }]).catch((err) => ctx.log.warn('artifact rescan failed', err));
  });
  projects.onRemoved(async (p) => {
    for (const a of agents.list().filter((x) => x.projectId === p.id)) await agents.remove(a.id, false).catch(() => undefined);
    await git.unwatchProject(p.id);
  });

  // ---------------------------------------------------------------- startup

  const list = await projects.restore();
  for (const p of list) {
    if (!existsSync(p.path)) {
      notices.push({ level: 'warning', message: `Project folder not found: ${p.path}` });
      continue;
    }
    await worktrees.prune(p.path).catch(() => undefined);
    const known = store.agents.list({ projectId: p.id }).flatMap((a) => (a.worktreePath ? [a.worktreePath] : []));
    const orphans = await worktrees.orphans(p.path, p.id, known).catch(() => []);
    if (orphans.length) notices.push({ level: 'info', message: `${p.name}: ${orphans.length} orphaned worktree${orphans.length === 1 ? '' : 's'} found. Remove them from Source control.` });
  }
  try {
    store.events.compactOlderThan(30);
    store.usage.deleteOlderThan(Date.now() - 90 * 24 * 60 * 60 * 1000);
  } catch (err) {
    ctx.log.warn('event compaction failed', err);
  }
  await artifacts.rescan(list.map((p) => ({ id: p.id, path: p.path }))).catch((err) => ctx.log.warn('artifact rescan failed', err));
  await extensions.start().catch((err) => ctx.log.error('extensions failed to start', err));
  await agents.restore();
  await git.sweepMerged().catch(() => undefined);
  void cli.ensure().catch((err) => ctx.log.warn('CLI detection failed', err));

  let disposed = false;
  const services: Services = {
    platform,
    terminals: opts.terminals,
    store,
    secrets,
    worktrees,
    artifacts,
    mcp,
    cli,
    projects,
    agents,
    git,
    extensions,
    picked: new Set(),
    notices,
    flushNotices() {
      for (const n of notices.splice(0)) ctx.emit('notify', n);
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      await agents.shutdown().catch((err) => ctx.log.warn('agent shutdown failed', err));
      await git.dispose().catch(() => undefined);
      await extensions.dispose().catch(() => undefined);
      store.close();
    },
  };
  return services;
}

// ---------------------------------------------------------------- artifact preview protocol

export const ARTIFACT_SCHEME = 'oide-artifact';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.excalidraw': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};

/** CSP for artifact previews: inline scripts/styles of the artifact itself, no network at all. */
export const ARTIFACT_CSP = "default-src 'none'; script-src 'unsafe-inline' oide-artifact:; style-src 'unsafe-inline' oide-artifact:; img-src oide-artifact: data: blob:; font-src oide-artifact: data:; media-src oide-artifact: data: blob:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'";

/**
 * Resolve `oide-artifact://<id>/<path>` to a file inside that artifact's folder, or null. Refuses
 * `..`, symlinks out of the folder, the `.versions` folder and `artifact.json`.
 */
export function resolveArtifactUrl(artifacts: ArtifactStore, url: string): { file: string; mime: string } | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== `${ARTIFACT_SCHEME}:`) return null;
  const id = decodeURIComponent(u.hostname || u.host);
  let dir: string;
  try {
    dir = realpathSync(artifacts.dirOf(id));
  } catch {
    return null;
  }
  const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '');
  if (!rel || rel.split(/[\\/]/).some((seg) => seg === '..' || seg === '.versions') || rel === 'artifact.json') return null;
  const candidate = resolve(dir, rel);
  let real: string;
  try {
    real = realpathSync(candidate);
  } catch {
    return null;
  }
  const r = relative(dir, real);
  if (!r || r.startsWith('..') || r.includes(`..${sep}`) || resolve(dir, r) !== real) return null;
  if (!statSync(real).isFile()) return null;
  return { file: real, mime: MIME[extname(real).toLowerCase()] ?? 'application/octet-stream' };
}
