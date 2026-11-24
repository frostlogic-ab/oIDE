import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import type { InstalledExtension } from '@oide/protocol';
import type { ExtensionRepository, ProjectExtensionsReader } from './interfaces.js';
import { loadManifest, ManifestError, type LoadedExtension } from './manifest.js';
import { satisfies } from './semver.js';

export interface RegistryOptions {
  repo: ExtensionRepository;
  /** `.oide/extensions.json` awareness. Untrusted projects' files are ignored. */
  projects?: ProjectExtensionsReader;
  /**
   * Folders whose subfolders are built-in extensions: the repo's `extensions/` in dev, and
   * `<resources>/extensions` in the packaged app.
   */
  builtinDirs?: string[];
  engineVersion?: string;
  /** Called for builtins or installed folders that fail to load. Default: ignore. */
  onLoadError?: (dir: string, error: Error) => void;
}

export type RegistryListener = (list: InstalledExtension[]) => void;

/** Why an extension is (or is not) on for a project. */
export type EnablementReason = 'project' | 'global' | 'team' | 'disabled-in-project' | 'team-version-mismatch' | 'off';

/**
 * The installed-extension list, its enable state per project and globally, and change events.
 * Persistence goes through the injected repository; built-ins are discovered from folders.
 */
export class ExtensionRegistry {
  private items = new Map<string, InstalledExtension>();
  private loaded = new Map<string, LoadedExtension>();
  private listeners = new Set<RegistryListener>();

  constructor(private readonly opts: RegistryOptions) {}

  /** Load persisted records and discover built-ins. Call once at startup. */
  async load(): Promise<InstalledExtension[]> {
    const stored = await this.opts.repo.list();
    const byId = new Map(stored.map((e) => [e.id, e]));
    this.items.clear();
    this.loaded.clear();
    for (const b of discoverBuiltins(this.opts.builtinDirs ?? [], this.opts)) {
      const prev = byId.get(b.record.id);
      const rec: InstalledExtension = prev
        ? { ...b.record, enabledGlobally: prev.enabledGlobally, enabledProjects: prev.enabledProjects, disabledProjects: prev.disabledProjects, disabledTools: prev.disabledTools }
        : b.record;
      this.items.set(rec.id, rec);
      this.loaded.set(rec.id, b.loaded);
      byId.delete(rec.id);
    }
    for (const e of byId.values()) {
      if (e.source === 'builtin') continue; // a builtin that is no longer shipped
      this.items.set(e.id, e);
    }
    this.emit();
    return this.list();
  }

  list(): InstalledExtension[] {
    return [...this.items.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  get(id: string): InstalledExtension | undefined {
    return this.items.get(id);
  }

  getByName(name: string): InstalledExtension | undefined {
    for (const e of this.items.values()) if (e.name === name) return e;
    return undefined;
  }

  /** Manifest with resolved paths (loaded lazily from the record's folder). */
  resolved(id: string): LoadedExtension | undefined {
    const hit = this.loaded.get(id);
    if (hit) return hit;
    const rec = this.items.get(id);
    if (!rec) return undefined;
    try {
      const l = loadManifest(rec.path, { ...(this.opts.engineVersion ? { engineVersion: this.opts.engineVersion } : {}) });
      this.loaded.set(id, l);
      return l;
    } catch (e) {
      this.opts.onLoadError?.(rec.path, e as Error);
      return undefined;
    }
  }

  /** Add or replace an installed extension (marketplace, folder or git). */
  async add(ext: InstalledExtension, loaded?: LoadedExtension): Promise<InstalledExtension> {
    const prev = this.items.get(ext.id);
    if (prev?.source === 'builtin' && ext.source !== 'builtin') throw new Error(`${ext.name} is built in and cannot be replaced`);
    this.items.set(ext.id, ext);
    if (loaded) this.loaded.set(ext.id, loaded);
    else this.loaded.delete(ext.id);
    await this.opts.repo.upsert(ext);
    this.emit();
    return ext;
  }

  async remove(id: string): Promise<InstalledExtension | undefined> {
    const prev = this.items.get(id);
    if (!prev) return undefined;
    if (prev.source === 'builtin') throw new Error(`${prev.name} is built in; disable it instead`);
    this.items.delete(id);
    this.loaded.delete(id);
    await this.opts.repo.remove(id);
    this.emit();
    return prev;
  }

  /** Turn on or off globally (no projectId) or for one project. */
  async setEnabled(id: string, enabled: boolean, projectId?: string): Promise<InstalledExtension> {
    const prev = this.items.get(id);
    if (!prev) throw new Error(`Unknown extension ${id}`);
    const next: InstalledExtension = { ...prev, enabledProjects: [...prev.enabledProjects], disabledProjects: [...prev.disabledProjects] };
    if (projectId === undefined) {
      next.enabledGlobally = enabled;
      if (!enabled) next.enabledProjects = [];
      next.disabledProjects = [];
    } else if (enabled) {
      if (!next.enabledProjects.includes(projectId)) next.enabledProjects.push(projectId);
      next.disabledProjects = next.disabledProjects.filter((p) => p !== projectId);
    } else {
      next.enabledProjects = next.enabledProjects.filter((p) => p !== projectId);
      if (!next.disabledProjects.includes(projectId)) next.disabledProjects.push(projectId);
    }
    this.items.set(id, next);
    await this.opts.repo.upsert(next);
    this.emit();
    return next;
  }

  /** Turn one tool (`mcp__<server>__<tool>`) on or off for this extension. */
  async setToolEnabled(id: string, fullToolName: string, enabled: boolean): Promise<InstalledExtension> {
    const prev = this.items.get(id);
    if (!prev) throw new Error(`Unknown extension ${id}`);
    const set = new Set(prev.disabledTools);
    if (enabled) set.delete(fullToolName);
    else set.add(fullToolName);
    const next = { ...prev, disabledTools: [...set] };
    this.items.set(id, next);
    await this.opts.repo.upsert(next);
    this.emit();
    return next;
  }

  /** Whether `ext` is on for `projectId`, and why. */
  async enablement(ext: InstalledExtension, projectId: string): Promise<EnablementReason> {
    if (ext.disabledProjects.includes(projectId)) return 'disabled-in-project';
    if (ext.enabledProjects.includes(projectId)) return 'project';
    const team = await this.teamRanges(projectId);
    const range = team?.[ext.name];
    if (range !== undefined) {
      if (range === '' || range === '*' || satisfies(ext.version, range)) return 'team';
      if (!ext.enabledGlobally) return 'team-version-mismatch';
    }
    if (ext.enabledGlobally) return 'global';
    return 'off';
  }

  async isEnabledFor(ext: InstalledExtension, projectId: string): Promise<boolean> {
    const r = await this.enablement(ext, projectId);
    return r === 'project' || r === 'team' || r === 'global';
  }

  async enabledFor(projectId: string): Promise<InstalledExtension[]> {
    const out: InstalledExtension[] = [];
    for (const e of this.list()) if (await this.isEnabledFor(e, projectId)) out.push(e);
    return out;
  }

  /** Names a trusted project's `.oide/extensions.json` asks for that are not installed. */
  async missingForProject(projectId: string): Promise<Array<{ name: string; range: string }>> {
    const team = await this.teamRanges(projectId);
    if (!team) return [];
    return Object.entries(team)
      .filter(([name]) => !this.getByName(name))
      .map(([name, range]) => ({ name, range }));
  }

  onChange(listener: RegistryListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async teamRanges(projectId: string): Promise<Record<string, string> | null> {
    const p = this.opts.projects;
    if (!p) return null;
    const project = await p.project(projectId);
    if (!project?.trusted) return null; // untrusted repos cannot turn on agent tools
    const cfg = await p.read(projectId);
    return cfg?.enabled ?? null;
  }

  private emit(): void {
    const list = this.list();
    for (const l of this.listeners) l(list);
  }
}

export interface DiscoveredBuiltin {
  record: InstalledExtension;
  loaded: LoadedExtension;
}

/** Each subfolder of each dir with a valid `oide` manifest becomes a builtin, on globally by default. */
export function discoverBuiltins(dirs: string[], opts: Pick<RegistryOptions, 'engineVersion' | 'onLoadError'> = {}): DiscoveredBuiltin[] {
  const out: DiscoveredBuiltin[] = [];
  const seen = new Set<string>();
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (!statSync(full).isDirectory() || !existsSync(path.join(full, 'package.json'))) continue;
      try {
        const loaded = loadManifest(full, opts.engineVersion ? { engineVersion: opts.engineVersion } : {});
        const m = loaded.manifest;
        if (seen.has(m.name)) continue;
        seen.add(m.name);
        out.push({
          loaded,
          record: {
            id: m.name,
            name: m.name,
            version: m.version,
            displayName: m.oide.displayName,
            source: 'builtin',
            path: full,
            enabledProjects: [],
            enabledGlobally: true,
            disabledProjects: [],
            disabledTools: [],
            reviewed: true,
            devMode: false,
            manifest: m,
          },
        });
      } catch (e) {
        if (!(e instanceof ManifestError) || e.code !== 'not-found') opts.onLoadError?.(full, e as Error);
      }
    }
  }
  return out;
}

/** Build the record for an extension loaded from a folder (Add custom › Extension from folder). */
export function recordFromLoaded(loaded: LoadedExtension, source: InstalledExtension['source'], extra: Partial<InstalledExtension> = {}): InstalledExtension {
  const m = loaded.manifest;
  return {
    id: m.name,
    name: m.name,
    version: m.version,
    displayName: m.oide.displayName,
    source,
    path: loaded.dir,
    enabledProjects: [],
    enabledGlobally: false,
    disabledProjects: [],
    disabledTools: [],
    reviewed: source === 'builtin' || source === 'marketplace' ? extra.reviewed ?? false : false,
    devMode: false,
    manifest: m,
    ...extra,
  };
}
