import { existsSync, realpathSync, statSync } from 'node:fs';
import { extname, join, relative, resolve, sep } from 'node:path';
import type { AgentDriver } from '@oide/agent-core';
import { WorktreeManager, type GhCli } from '@oide/git';
import { OideMcpServer, type ArtifactsBackend as McpArtifactsBackend } from '@oide/mcp-server';
import { ArtifactStore, SqliteSecretStore, openStore, type Store } from '@oide/store';
import type { MainContext } from '../context.js';
import { CleanupQueue } from '../reliability/cleanup-queue.js';
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
  /** The oIDE MCP server's loopback port, or undefined when it could not start. */
  mcpPort(): number | undefined;
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
  /** An already opened store (main opens it with recovery prompts, reliability/db-recovery.ts). */
  store?: Store;
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
  const store = opts.store ?? openStore(opts.dbFile ?? join(ctx.userDataDir, 'oide.db'), { backupDir: join(ctx.userDataDir, 'backups') });
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
  // A failed bind (port in use, a firewall or security tool refusing loopback) must not stop the
  // app: retry, then start without it and tell the user. Agents cannot launch until it works.
  let mcpPort: number | undefined;
  for (let attempt = 1; attempt <= 3 && mcpPort === undefined; attempt++) {
    try {
      mcpPort = (await mcp.start()).port;
    } catch (err) {
      ctx.log.warn('MCP server failed to start', { attempt, error: err });
      if (attempt < 3) await new Promise((r) => setTimeout(r, 200 * attempt));
      else notices.push({ level: 'error', message: `oIDE's MCP server could not start (${(err as Error).message}). Agents cannot be started until oIDE restarts. Check that no security tool blocks connections to 127.0.0.1.` });
    }
  }

  const cli = new CliService({ settings, emit: ctx.emit, override: platform.cliPathOverride });
  const projects = new ProjectsService({ ctx, store, platform });
  const cleanup = new CleanupQueue(ctx.userDataDir);
  const agents = new AgentsService({ ctx, store, settings, secrets, worktrees, mcp, projects, cli, platform, cleanup, mcpReady: () => mcpPort !== undefined, ...(opts.driver ? { driver: opts.driver } : {}) });
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
      return { id: meta.id, title: meta.title, kind: meta.kind, content, version: meta.version, ...(meta.projectId ? { projectId: meta.projectId } : {}) };
    },
  });
  agents.extensions = extensions;
  const hostLog = ctx.reliability?.logs.channel('extension-host');
  extensions.host?.onState((s) => {
    const line = { extension: s.name, state: s.state, ...(s.error ? { error: s.error } : {}) };
    if (s.state === 'reloading' || s.state === 'failed') {
      hostLog?.warn('extension host', line);
      ctx.reliability?.crashReports.record('extension-host', { process: s.name, ...(s.error ? { reason: s.error } : {}) });
    } else hostLog?.info('extension host', line);
  });
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
  // Worktree folders a locked file kept us from deleting last time (Windows).
  const pending = await cleanup.runPending(async (e) => {
    if (e.projectPath && existsSync(e.projectPath)) await worktrees.prune(e.projectPath).catch(() => undefined);
  });
  if (pending.removed.length) ctx.log.debug('finished removing worktree folders from last run', pending.removed.length);
  for (const p of pending.stillLocked) notices.push({ level: 'warning', message: `Still could not delete ${p}: a program is using a file in it. Close programs using this folder; oIDE tries again on next start.` });
  for (const p of pending.gaveUp) notices.push({ level: 'warning', message: `oIDE gave up deleting ${p}. Delete the folder yourself when no program is using it.` });
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
    mcpPort: () => mcpPort,
    picked: new Set(),
    notices,
    flushNotices() {
      for (const n of notices.splice(0)) ctx.emit('notify', n);
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      await agents.shutdown().catch((err) => ctx.log.warn('agent shutdown failed', err));
      // After agents: closes watchers and waits for in-flight git work, so nothing holds files
      // in a worktree when the process exits or the caller deletes it.
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

/**
 * CSP for artifact previews: inline scripts/styles of the artifact itself, no network at all.
 * `'self'` (not the whole `oide-artifact:` scheme) so one artifact cannot load another's scripts
 * (SEC-18). WebRTC is not covered by CSP; the session's WebRTC policy turns it off (hardening.ts).
 */
export const ARTIFACT_CSP = "default-src 'none'; script-src 'unsafe-inline' 'self'; style-src 'unsafe-inline' 'self'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' data: blob:; connect-src 'none'; frame-src 'none'; worker-src 'none'; form-action 'none'; base-uri 'none'";

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
  let rel: string;
  try {
    rel = decodeURIComponent(u.pathname).replace(/^\/+/, '');
  } catch {
    return null;
  }
  // SEC-17: Windows and macOS file systems ignore case (and Windows trailing dots/spaces), so the
  // deny checks compare a normalised form, and run again on the real path below.
  const fold = (s: string) => s.toLowerCase().replace(/[. ]+$/, '');
  const denied = (p: string) => {
    const segs = p.split(/[\\/]/).filter(Boolean).map(fold);
    return segs.some((seg) => seg === '..' || seg === '.versions') || (segs.length === 1 && segs[0] === 'artifact.json');
  };
  if (!rel || rel.includes('\0') || denied(rel)) return null;
  const candidate = resolve(dir, rel);
  let real: string;
  try {
    real = realpathSync(candidate);
  } catch {
    return null;
  }
  const r = relative(dir, real);
  if (!r || r.startsWith('..') || r.includes(`..${sep}`) || resolve(dir, r) !== real || denied(r)) return null;
  if (!statSync(real).isFile()) return null;
  return { file: real, mime: MIME[extname(real).toLowerCase()] ?? 'application/octet-stream' };
}
