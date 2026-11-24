import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { MarketplaceIndex, type ExtensionUpdate, type InstalledExtension, type MarketplaceEntry } from '@oide/protocol';
import type { FetchFn } from './interfaces.js';
import { assertIntegrity } from './integrity.js';
import { capabilityList, ENGINE_VERSION, loadManifest, type LoadedExtension } from './manifest.js';
import { recordFromLoaded } from './registry.js';
import { compareVersions, satisfies } from './semver.js';
import { extractTarball } from './tarball.js';

export const DEFAULT_INDEX_URL = 'https://raw.githubusercontent.com/oide-dev/oide-marketplace/main/index.json';
const DAY = 24 * 60 * 60 * 1000;
const MAX_TARBALL_BYTES = 64 * 1024 * 1024;

export interface InstallerOptions {
  /** `<app-data>/extensions` */
  extensionsDir: string;
  /** Where the fetched index is cached, e.g. `<app-data>/marketplace`. */
  cacheDir: string;
  indexUrl?: string;
  /** The offline fallback shipped with the app (tools/marketplace-index/bundled/index.json). */
  bundledIndexPath?: string;
  fetch?: FetchFn;
  now?: () => number;
  engineVersion?: string;
  /** Refresh the cached index when older than this (default one day). */
  maxAgeMs?: number;
}

export interface IndexResult {
  index: MarketplaceIndex;
  from: 'network' | 'cache' | 'bundled';
  fetchedAt?: number;
}

export interface InstallResult {
  record: InstalledExtension;
  loaded: LoadedExtension;
  /** Things the install dialog should mention (ignored install scripts, unbundled dependencies). */
  warnings: string[];
}

export class InstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InstallError';
  }
}

/** Fetches the marketplace index, installs tarballs safely and computes updates. */
export class MarketplaceInstaller {
  private readonly fetch: FetchFn;
  private readonly now: () => number;
  private readonly engine: string;
  private memo: IndexResult | null = null;

  constructor(private readonly opts: InstallerOptions) {
    this.fetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.now = opts.now ?? Date.now;
    this.engine = opts.engineVersion ?? ENGINE_VERSION;
  }

  get indexUrl(): string {
    return this.opts.indexUrl ?? DEFAULT_INDEX_URL;
  }

  private get cacheFile(): string {
    return path.join(this.opts.cacheDir, 'index.json');
  }

  /** Cached index (refreshed daily), the network, then the bundled index as offline fallback. */
  async getIndex(opts: { refresh?: boolean } = {}): Promise<IndexResult> {
    const maxAge = this.opts.maxAgeMs ?? DAY;
    const cached = this.memo ?? (await this.readCache());
    if (!opts.refresh && cached?.fetchedAt !== undefined && this.now() - cached.fetchedAt < maxAge) return (this.memo = cached);
    try {
      const res = await this.fetch(this.indexUrl, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const index = MarketplaceIndex.parse(await res.json());
      const fetchedAt = this.now();
      await mkdir(this.opts.cacheDir, { recursive: true });
      await writeFile(this.cacheFile, JSON.stringify({ fetchedAt, url: this.indexUrl, index }), 'utf8');
      return (this.memo = { index, from: 'network', fetchedAt });
    } catch {
      if (cached) return (this.memo = cached);
      const bundled = this.readBundled();
      if (bundled) return (this.memo = { index: bundled, from: 'bundled' });
      throw new InstallError('The marketplace index is unavailable (offline and no cached or bundled copy)');
    }
  }

  private async readCache(): Promise<IndexResult | null> {
    try {
      const raw = JSON.parse(await readFile(this.cacheFile, 'utf8')) as { fetchedAt?: unknown; url?: unknown; index?: unknown };
      if (raw.url !== this.indexUrl || typeof raw.fetchedAt !== 'number') return null;
      return { index: MarketplaceIndex.parse(raw.index), from: 'cache', fetchedAt: raw.fetchedAt };
    } catch {
      return null;
    }
  }

  private readBundled(): MarketplaceIndex | null {
    const p = this.opts.bundledIndexPath;
    if (!p || !existsSync(p)) return null;
    try {
      return MarketplaceIndex.parse(JSON.parse(readFileSync(p, 'utf8')));
    } catch {
      return null;
    }
  }

  /** The version to install: the exact one asked for, or the newest one whose engine range fits. */
  pickVersion(entry: MarketplaceEntry, version?: string): MarketplaceEntry['versions'][number] {
    if (version) {
      const v = entry.versions.find((x) => x.version === version);
      if (!v) throw new InstallError(`${entry.name}@${version} is not in the marketplace index`);
      if (!satisfies(this.engine, v.engine)) throw new InstallError(`${entry.name}@${version} needs oIDE extension API ${v.engine}`);
      return v;
    }
    const ok = entry.versions.filter((v) => satisfies(this.engine, v.engine)).sort((a, b) => compareVersions(b.version, a.version));
    const best = ok[0];
    if (!best) throw new InstallError(`No version of ${entry.name} works with this oIDE (extension API ${this.engine})`);
    return best;
  }

  async findEntry(name: string): Promise<MarketplaceEntry> {
    const { index } = await this.getIndex();
    const entry = index.extensions.find((e) => e.name === name);
    if (!entry) throw new InstallError(`${name} is not in the marketplace index`);
    return entry;
  }

  /**
   * Download the npm tarball, verify its SRI hash before anything is unpacked, extract it to
   * `<extensionsDir>/<name>@<version>` and validate the manifest. No install scripts run and no
   * dependencies are installed. The caller adds `record` to the registry.
   */
  async install(name: string, version?: string): Promise<InstallResult> {
    const entry = await this.findEntry(name);
    if (entry.source === 'builtin') throw new InstallError(`${name} ships with oIDE`);
    const v = this.pickVersion(entry, version);
    const res = await this.fetch(v.tarball, { signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new InstallError(`Download failed for ${name}@${v.version}: HTTP ${res.status}`);
    const data = new Uint8Array(await res.arrayBuffer());
    if (data.byteLength > MAX_TARBALL_BYTES) throw new InstallError(`${name}@${v.version} is too large`);
    return this.installTarball(data, entry, v);
  }

  /** Install from tarball bytes already in hand (used by `install` and by tests). */
  async installTarball(data: Uint8Array, entry: MarketplaceEntry, v: MarketplaceEntry['versions'][number]): Promise<InstallResult> {
    assertIntegrity(data, v.integrity, `${entry.name}@${v.version}`);
    const dest = this.packageDir(entry.name, v.version);
    await extractTarball(data, dest);
    try {
      const loaded = loadManifest(dest, { engineVersion: this.engine });
      const m = loaded.manifest;
      if (m.name !== entry.name || m.version !== v.version) throw new InstallError(`Tarball is ${m.name}@${m.version}, expected ${entry.name}@${v.version}`);
      const listed = new Set(v.tools.map((t) => t.name));
      const unlisted = loaded.tools.filter((t) => !listed.has(t.tool));
      if (unlisted.length) throw new InstallError(`${entry.name} declares tools the index does not list: ${unlisted.map((t) => t.tool).join(', ')}`);
      for (const t of loaded.tools) {
        const idx = v.tools.find((x) => x.name === t.tool);
        if (idx?.risk === 'ask' && t.risk === 'read') throw new InstallError(`${entry.name} marks ${t.tool} read-only but the index says it asks first`);
      }
      const warnings = [...requireBundled(loaded), ...packageWarnings(dest)];
      const record = recordFromLoaded(loaded, 'marketplace', { reviewed: entry.verified });
      return { record, loaded, warnings };
    } catch (e) {
      await rm(dest, { recursive: true, force: true });
      throw e;
    }
  }

  packageDir(name: string, version: string): string {
    const safe = name.replace(/^@/, '').replace(/\//g, '__');
    if (!/^[a-z0-9-~._]+$/i.test(safe) || !/^[0-9A-Za-z.+-]+$/.test(version)) throw new InstallError(`Bad package name or version: ${name}@${version}`);
    return path.join(this.opts.extensionsDir, `${safe}@${version}`);
  }

  /** Remove an installed (marketplace or git) extension's folder. Folders the user picked are left alone. */
  async removeFiles(ext: InstalledExtension): Promise<void> {
    if (ext.source !== 'marketplace' && ext.source !== 'git') return;
    const root = path.resolve(this.opts.extensionsDir);
    const p = path.resolve(ext.path);
    const rel = path.relative(root, p);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return;
    await rm(p, { recursive: true, force: true });
  }

  /** Updates for marketplace installs. `needsConsent` when the new version adds tools or capabilities. */
  async checkUpdates(installed: InstalledExtension[]): Promise<ExtensionUpdate[]> {
    const { index } = await this.getIndex();
    const out: ExtensionUpdate[] = [];
    for (const ext of installed) {
      if (ext.source !== 'marketplace') continue;
      const entry = index.extensions.find((e) => e.name === ext.name);
      if (!entry) continue;
      let next;
      try {
        next = this.pickVersion(entry);
      } catch {
        continue;
      }
      if (compareVersions(next.version, ext.version) <= 0) continue;
      const diff = diffConsent(ext, next);
      out.push({ id: ext.id, name: ext.name, from: ext.version, to: next.version, ...diff, needsConsent: diff.addedTools.length > 0 || diff.addedCapabilities.length > 0 });
    }
    return out;
  }

  /** Clone a git repo (no hooks, no submodules, no scripts) and load it as an unreviewed extension. */
  async installFromGit(url: string, opts: { gitPath?: string } = {}): Promise<InstallResult> {
    if (!/^(https:\/\/|git@|ssh:\/\/)/.test(url)) throw new InstallError('Only https:// or ssh git URLs are supported');
    const dest = path.join(this.opts.extensionsDir, 'git', createHash('sha256').update(url).digest('hex').slice(0, 16));
    await rm(dest, { recursive: true, force: true });
    await mkdir(path.dirname(dest), { recursive: true });
    const run = promisify(execFile);
    await run(opts.gitPath ?? 'git', ['-c', 'protocol.file.allow=never','clone', '--depth', '1', '--no-recurse-submodules', '--', url, dest], {
      env: { ...pickEnv(['PATH', 'HOME', 'USERPROFILE', 'SystemRoot', 'APPDATA', 'LOCALAPPDATA', 'SSH_AUTH_SOCK']), GIT_TERMINAL_PROMPT: '0' },
      timeout: 120_000,
    });
    try {
      const loaded = loadManifest(dest, { engineVersion: this.engine });
      const warnings = [...requireBundled(loaded), ...packageWarnings(dest)];
      return { record: recordFromLoaded(loaded, 'git', { reviewed: false }), loaded, warnings };
    } catch (e) {
      await rm(dest, { recursive: true, force: true });
      throw e;
    }
  }
}

/** Load an extension from a folder the user picked (not copied; unreviewed). Nothing runs. */
export function loadFromFolder(dir: string, opts: { devMode?: boolean; engineVersion?: string } = {}): InstallResult {
  const loaded = loadManifest(dir, opts.engineVersion ? { engineVersion: opts.engineVersion } : {});
  const warnings = [...requireBundled(loaded, { strict: false }), ...packageWarnings(loaded.dir)];
  return { record: recordFromLoaded(loaded, 'folder', { reviewed: false, devMode: !!opts.devMode }), loaded, warnings };
}

function pickEnv(keys: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of keys) {
    const v = process.env[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/** Host code and MCP server scripts must be bundled under `dist/`. Throws (strict) or warns. */
export function requireBundled(loaded: LoadedExtension, opts: { strict?: boolean } = {}): string[] {
  const dist = path.join(loaded.dir, 'dist');
  const code: string[] = [];
  if (loaded.main) code.push(loaded.main);
  for (const s of Object.values(loaded.mcpServers)) for (const a of s.args) if (path.isAbsolute(a) && a.startsWith(loaded.dir)) code.push(a);
  if (!code.length) return [];
  const hasDist = existsSync(dist) && statSync(dist).isDirectory();
  const outside = code.filter((c) => {
    const rel = path.relative(dist, c);
    return rel.startsWith('..') || path.isAbsolute(rel);
  });
  const msg = !hasDist ? 'Extension has no bundled dist/ folder' : outside.length ? `Code must be bundled in dist/: ${outside.map((c) => path.relative(loaded.dir, c)).join(', ')}` : null;
  if (!msg) return [];
  if (opts.strict === false) return [msg];
  throw new InstallError(msg);
}

function packageWarnings(dir: string): string[] {
  const out: string[] = [];
  try {
    const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as { scripts?: Record<string, string>; dependencies?: Record<string, string> };
    const scripts = Object.keys(pkg.scripts ?? {}).filter((s) => /^(pre|post)?install$|^prepare$/.test(s));
    if (scripts.length) out.push(`Install scripts are never run: ${scripts.join(', ')}`);
    const deps = Object.keys(pkg.dependencies ?? {});
    if (deps.length) out.push(`Dependencies are not installed; they must be bundled: ${deps.join(', ')}`);
  } catch {
    /* already validated by loadManifest */
  }
  return out;
}

/** Tools and capabilities a new index version adds compared with what the user consented to. */
export function diffConsent(ext: InstalledExtension, next: MarketplaceEntry['versions'][number]): { addedTools: string[]; addedCapabilities: string[] } {
  const current = new Map<string, string>();
  for (const s of Object.values(ext.manifest.oide.mcpServers)) for (const [name, t] of Object.entries(s.tools)) current.set(name, t.risk);
  const addedTools: string[] = [];
  for (const t of next.tools) {
    const prev = current.get(t.name);
    if (prev === undefined) addedTools.push(t.name);
    else if (prev === 'ask' && t.risk === 'read') addedTools.push(`${t.name} (now read only)`);
  }
  const had = new Set(capabilityList(ext.manifest));
  const nextCaps = next.capabilities ? capabilityList({ oide: { capabilities: next.capabilities } }) : [];
  const addedCapabilities = nextCaps.filter((c) => !had.has(c));
  return { addedTools, addedCapabilities };
}
