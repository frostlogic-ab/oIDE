/**
 * Files › package.json: the latest published version of each dependency, from the public npm
 * registry (wiki: screen-files.md › Dependency versions).
 *
 * - One small GET per package: `/-/package/<name>/dist-tags` (a few hundred bytes), never the full
 *   packument. Only the package name leaves the computer.
 * - The checkout's own `.npmrc` (the package.json's folder, then each parent up to the checkout
 *   root) is honoured: a scope sent to another registry is never asked about, and a default
 *   `registry=` that is not the public one turns every lookup off for that file. Only `registry`
 *   keys are read; auth lines are skipped and never kept. The user's home `.npmrc` is not read.
 * - Results are cached in memory (30 min; 2 min after a failure), at most 8 requests in flight,
 *   no retry: a failed or rate-limited lookup just shows nothing until the cache entry expires.
 * - `OIDE_NPM_REGISTRY=off` (e2e) turns it off, so tests never reach the network.
 */
import { readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { NpmVersion, type DependencyVersions, type PackageVersions } from '@oide/protocol';

export const NPM_PUBLIC_REGISTRY = 'https://registry.npmjs.org/';
/** Hosts that serve the public npm registry (yarn's is a mirror of it). */
const PUBLIC_HOSTS = new Set(['registry.npmjs.org', 'registry.yarnpkg.com']);
const TTL_MS = 30 * 60_000;
const FAIL_TTL_MS = 2 * 60_000;
const MAX_CACHE = 2000;
const MAX_IN_FLIGHT = 8;
const TIMEOUT_MS = 10_000;
const MAX_BODY = 64 * 1024;
const MAX_TAGS = 20;

/** The registry settings of an `.npmrc` that matter here (everything else is ignored). */
export interface NpmrcRegistries {
  /** `registry=` (normalised, with a trailing slash). */
  registry?: string;
  /** `@scope:registry=` → registry. */
  scopes: Record<string, string>;
}

const normalise = (url: string) => (url.endsWith('/') ? url : `${url}/`);

/** Reads the `registry` and `@scope:registry` keys of an `.npmrc`; every other line is skipped. */
export function parseNpmrc(text: string): NpmrcRegistries {
  const out: NpmrcRegistries = { scopes: {} };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const m = /^(@[^:=\s]+:)?registry\s*=\s*(.+)$/i.exec(line);
    if (!m) continue;
    const value = m[2]!.trim().replace(/^["']|["']$/g, '');
    if (!value) continue;
    if (m[1]) out.scopes[m[1].slice(0, -1).toLowerCase()] = normalise(value);
    else out.registry = normalise(value);
  }
  return out;
}

export function isPublicRegistry(url: string): boolean {
  try {
    const u = new URL(url);
    return (u.protocol === 'https:' || u.protocol === 'http:') && PUBLIC_HOSTS.has(u.hostname.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * The `.npmrc` registries in effect for `<root>/<file>`: the nearest folder's settings win, from
 * the file's folder up to the checkout root (never above it).
 */
export async function npmrcFor(root: string, file: string, read: (p: string) => Promise<string> = (p) => readFile(p, 'utf8')): Promise<NpmrcRegistries> {
  const top = resolve(root);
  const dirs: string[] = [];
  let dir = dirname(resolve(top, file));
  for (;;) {
    const rel = relative(top, dir);
    if (rel.startsWith('..')) break;
    dirs.push(dir);
    if (!rel) break;
    dir = dirname(dir);
  }
  const merged: NpmrcRegistries = { scopes: {} };
  // Farthest first, so nearer files override.
  for (const d of dirs.reverse()) {
    const text = await read(join(d, '.npmrc')).catch(() => '');
    if (!text) continue;
    const r = parseNpmrc(text);
    if (r.registry) merged.registry = r.registry;
    Object.assign(merged.scopes, r.scopes);
  }
  return merged;
}

/** `@scope/name` → `@scope%2fname`, the form the registry's own clients use. */
const registryPath = (name: string) => name.replace('/', '%2f');

/** The dist-tags body (`{ latest: "1.2.3", next: "2.0.0-rc.1" }`) → validated versions, or null. */
export function toPackageVersions(body: unknown): PackageVersions | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const entries = Object.entries(body as Record<string, unknown>);
  const latest = (body as Record<string, unknown>).latest;
  if (!NpmVersion.safeParse(latest).success) return null;
  const tags: Record<string, string> = {};
  for (const [tag, v] of entries) {
    if (Object.keys(tags).length >= MAX_TAGS) break;
    if (tag.length > 64 || tag === '__proto__' || !NpmVersion.safeParse(v).success) continue;
    tags[tag] = v as string;
  }
  return { latest: latest as string, tags };
}

interface Entry {
  at: number;
  ttl: number;
  value: Promise<PackageVersions | null>;
}

export interface NpmRegistryOptions {
  fetch?: typeof fetch;
  /** Settings › Privacy › Show newer npm versions. */
  enabled(): boolean;
  now?: () => number;
  log?: { debug(msg: string, ...args: unknown[]): void };
  /** Tests: `.npmrc` reader. */
  read?: (p: string) => Promise<string>;
}

export class NpmRegistryService {
  private readonly cache = new Map<string, Entry>();
  private inFlight = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly o: NpmRegistryOptions) {}

  /** Latest versions of `names` for the package.json at `<root>/<file>` (both already checked by the caller). */
  async latest(root: string, file: string, names: string[]): Promise<DependencyVersions> {
    if (!this.o.enabled() || process.env.OIDE_NPM_REGISTRY === 'off') return { status: 'off', packages: {} };
    const rc = await npmrcFor(root, file, this.o.read);
    if (rc.registry && !isPublicRegistry(rc.registry)) return { status: 'private-registry', packages: {} };
    const asked = [...new Set(names)].filter((n) => {
      const scope = n.startsWith('@') ? n.slice(0, n.indexOf('/')) : undefined;
      const reg = scope ? rc.scopes[scope] : undefined;
      return !reg || isPublicRegistry(reg);
    });
    const values = await Promise.all(asked.map((n) => this.lookup(n)));
    const packages: DependencyVersions['packages'] = {};
    asked.forEach((n, i) => (packages[n] = values[i] ?? null));
    return { status: 'ok', packages };
  }

  private lookup(name: string): Promise<PackageVersions | null> {
    const now = (this.o.now ?? Date.now)();
    const hit = this.cache.get(name);
    if (hit && now - hit.at < hit.ttl) return hit.value;
    const entry: Entry = { at: now, ttl: TTL_MS, value: Promise.resolve(null) };
    entry.value = this.request(name).then(
      (v) => v,
      (err: unknown) => {
        entry.ttl = FAIL_TTL_MS;
        this.o.log?.debug('[npm] lookup failed', name, err instanceof Error ? err.message : String(err));
        return null;
      },
    );
    this.cache.delete(name);
    this.cache.set(name, entry);
    if (this.cache.size > MAX_CACHE) this.cache.delete(this.cache.keys().next().value!);
    return entry.value;
  }

  private async request(name: string): Promise<PackageVersions | null> {
    await this.slot();
    try {
      const res = await (this.o.fetch ?? fetch)(`${NPM_PUBLIC_REGISTRY}-/package/${registryPath(name)}/dist-tags`, {
        headers: { accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      // Not on the public registry (private or unpublished): nothing to show, and that is cached.
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      if (text.length > MAX_BODY) throw new Error('response too large');
      return toPackageVersions(JSON.parse(text));
    } finally {
      this.release();
    }
  }

  private async slot(): Promise<void> {
    if (this.inFlight >= MAX_IN_FLIGHT) await new Promise<void>((r) => this.waiting.push(r));
    this.inFlight++;
  }

  private release(): void {
    this.inFlight--;
    this.waiting.shift()?.();
  }
}
