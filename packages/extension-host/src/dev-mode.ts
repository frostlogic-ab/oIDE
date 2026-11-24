import { watch, type FSWatcher } from 'node:fs';
import type { InstalledExtension } from '@oide/protocol';

/**
 * Developer mode (Add custom › Extension from folder): watch a folder the user picked and
 * reload the extension when its files change. Never for anything installed from the index.
 */

export interface DevReload {
  extension: InstalledExtension;
  /** Files that changed in this batch (relative to the folder). */
  files: string[];
}

export interface DevWatcherOptions {
  /** Restart host code and tell the supervisor its MCP servers changed. */
  onReload(r: DevReload): void | Promise<void>;
  debounceMs?: number;
  /** Ignore these path segments (default node_modules, .git). */
  ignore?: string[];
}

export class DevModeWatcher {
  private watchers = new Map<string, { w: FSWatcher; timer: NodeJS.Timeout | null; files: Set<string> }>();

  constructor(private readonly o: DevWatcherOptions) {}

  /** Start watching. Throws for extensions that are not a dev-mode folder the user picked. */
  watch(ext: InstalledExtension): void {
    if (ext.source !== 'folder' || !ext.devMode) throw new Error('Developer mode only works for folders you picked');
    if (this.watchers.has(ext.id)) return;
    const ignore = this.o.ignore ?? ['node_modules', '.git'];
    const entry = { w: null as unknown as FSWatcher, timer: null as NodeJS.Timeout | null, files: new Set<string>() };
    entry.w = watch(ext.path, { recursive: true }, (_event, file) => {
      const f = file ? String(file) : '';
      if (f && f.split(/[\\/]/).some((s) => ignore.includes(s))) return;
      if (f) entry.files.add(f);
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = setTimeout(() => {
        entry.timer = null;
        const files = [...entry.files];
        entry.files.clear();
        void this.o.onReload({ extension: ext, files });
      }, this.o.debounceMs ?? 300);
    });
    entry.w.on('error', () => this.unwatch(ext.id));
    this.watchers.set(ext.id, entry);
  }

  unwatch(id: string): void {
    const e = this.watchers.get(id);
    if (!e) return;
    if (e.timer) clearTimeout(e.timer);
    e.w.close();
    this.watchers.delete(id);
  }

  watching(): string[] {
    return [...this.watchers.keys()];
  }

  dispose(): void {
    for (const id of [...this.watchers.keys()]) this.unwatch(id);
  }
}
