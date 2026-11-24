import type { Database } from './db.js';
import type { Row } from './util.js';

/**
 * Third-party secrets: custom model API keys, extension secrets, custom MCP server env secrets and
 * OAuth tokens for remote MCP servers. Never Claude credentials: keys are restricted to the
 * namespaces below, and the CLI's own sign-in is never read (see CLAUDE.md, hard rule 3).
 *
 * Key shapes: `model:<id>`, `ext:<extension>:<key>`, `mcp:<server>:token`, `mcp:<server>:env:<VAR>`.
 */
export interface SecretStore {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
  delete(key: string): boolean;
  has(key: string): boolean;
  /** Keys (never values) under a prefix, e.g. `ext:my-ext:`. */
  keys(prefix?: string): string[];
}

const KEY_RE = /^(model|ext|mcp|env):[A-Za-z0-9@/._~-]+(:[A-Za-z0-9@/._~-]+)*$/;

export function assertSecretKey(key: string): void {
  if (!KEY_RE.test(key) || key.length > 512) {
    throw new Error(`Invalid secret key ${JSON.stringify(key)}: expected model:<id>, ext:<name>:<key> or mcp:<server>:<…>`);
  }
}

export interface Cipher {
  /** Electron: `safeStorage.encryptString`. */
  encrypt(plain: string): Uint8Array;
  /** Electron: `safeStorage.decryptString`. */
  decrypt(cipher: Uint8Array): string;
  /** Electron: `safeStorage.isEncryptionAvailable`. Writes are refused when false. */
  available?(): boolean;
}

/** Ciphertext in SQLite (`secrets` table); encryption by the OS keychain through `safeStorage`. */
export class SqliteSecretStore implements SecretStore {
  constructor(
    private readonly d: Database,
    private readonly cipher: Cipher,
  ) {}

  get(key: string): string | undefined {
    assertSecretKey(key);
    const r = this.d.db.prepare('SELECT ciphertext FROM secrets WHERE key = ?').get(key) as Row | undefined;
    if (!r) return undefined;
    const buf = r.ciphertext as Uint8Array;
    return this.cipher.decrypt(Buffer.from(buf));
  }

  set(key: string, value: string): void {
    assertSecretKey(key);
    if (this.cipher.available && !this.cipher.available()) throw new Error('Secure storage is not available on this system; the secret was not saved.');
    const ct = this.cipher.encrypt(value);
    this.d.db.prepare('INSERT INTO secrets (key, ciphertext, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET ciphertext = excluded.ciphertext, updated_at = excluded.updated_at').run(key, ct, Date.now());
  }

  delete(key: string): boolean {
    assertSecretKey(key);
    return this.d.db.prepare('DELETE FROM secrets WHERE key = ?').run(key).changes > 0;
  }

  has(key: string): boolean {
    assertSecretKey(key);
    return !!this.d.db.prepare('SELECT 1 FROM secrets WHERE key = ?').get(key);
  }

  keys(prefix = ''): string[] {
    const all = (this.d.db.prepare('SELECT key FROM secrets ORDER BY key').all() as Row[]).map((r) => String(r.key));
    return all.filter((k) => k.startsWith(prefix));
  }

  /** Remove every secret under a prefix (an uninstalled extension, a removed server). */
  deletePrefix(prefix: string): number {
    if (!prefix || !/^(model|ext|mcp|env):/.test(prefix)) throw new Error('A namespaced prefix is required.');
    let n = 0;
    for (const k of this.keys(prefix)) if (this.delete(k)) n++;
    return n;
  }
}

/** In-memory store for tests. */
export class MemorySecretStore implements SecretStore {
  private readonly map = new Map<string, string>();
  get(key: string): string | undefined {
    assertSecretKey(key);
    return this.map.get(key);
  }
  set(key: string, value: string): void {
    assertSecretKey(key);
    this.map.set(key, value);
  }
  delete(key: string): boolean {
    assertSecretKey(key);
    return this.map.delete(key);
  }
  has(key: string): boolean {
    assertSecretKey(key);
    return this.map.has(key);
  }
  keys(prefix = ''): string[] {
    return [...this.map.keys()].filter((k) => k.startsWith(prefix)).sort();
  }
}

/** Key helpers. */
export const secretKeys = {
  model: (id: string) => `model:${id}`,
  extension: (name: string, key: string) => `ext:${name}:${key}`,
  mcpToken: (server: string) => `mcp:${server}:token`,
  mcpEnv: (server: string, envVar: string) => `mcp:${server}:env:${envVar}`,
};
