import type { CustomServer, InstalledExtension, ProjectExtensions } from '@oide/protocol';

/**
 * Interfaces the app (main process) injects into the extension host package. The store package
 * implements the repositories on SQLite; main implements the rest with Electron APIs.
 */

export type MaybePromise<T> = T | Promise<T>;

/** Installed extensions table (`<app-data>/oide.db`). Builtins are stored too, only for their enable state. */
export interface ExtensionRepository {
  list(): MaybePromise<InstalledExtension[]>;
  upsert(ext: InstalledExtension): MaybePromise<void>;
  remove(id: string): MaybePromise<void>;
}

/** Custom MCP servers saved to "My settings (all my projects)". */
export interface CustomServerRepository {
  list(): MaybePromise<CustomServer[]>;
  upsert(server: CustomServer): MaybePromise<void>;
  remove(id: string): MaybePromise<void>;
}

/**
 * OS keychain (Electron `safeStorage`). Keys are namespaced by this package
 * (`extension/<name>/<key>`, `custom/<id>/…`). Never used for Claude credentials.
 */
export interface SecretStore {
  get(key: string): MaybePromise<string | undefined>;
  set(key: string, value: string): MaybePromise<void>;
  delete(key: string): MaybePromise<void>;
}

/** Plain (non-secret) per-extension settings storage. */
export interface SettingsStore {
  get(key: string): MaybePromise<unknown>;
  set(key: string, value: unknown): MaybePromise<void>;
}

/** A project as this package needs to see it. */
export interface ProjectRef {
  id: string;
  name: string;
  root: string;
  trusted: boolean;
}

/** Reads `<repo>/.oide/extensions.json` (already Zod-parsed; `null` when absent or invalid). */
export interface ProjectExtensionsReader {
  project(projectId: string): MaybePromise<ProjectRef | undefined>;
  read(projectId: string): MaybePromise<ProjectExtensions | null>;
}

/** Opens a URL in the system browser (Electron `shell.openExternal`). */
export type OpenExternal = (url: string) => MaybePromise<void>;

export type FetchFn = typeof fetch;
