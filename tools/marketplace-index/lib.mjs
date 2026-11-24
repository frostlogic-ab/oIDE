// Shared logic for build.mjs and validate.mjs (also imported by the tests).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { computeIntegrity, ENGINE_VERSION, extractTarball, isValidRange, isValidVersion, loadManifest, requireBundled, verifyIntegrity } from '@oide/extension-host';
import { MARKETPLACE_CATEGORIES, MarketplaceIndex } from '@oide/protocol';

/** @type {Set<string>} */
const CATEGORY_IDS = new Set(MARKETPLACE_CATEGORIES.map((c) => c.id));

/**
 * Schema plus the rules CI enforces on top of it.
 * @param {unknown} json
 * @returns {{ index: import('@oide/protocol').MarketplaceIndex | null, errors: string[] }}
 */
export function validateIndex(json) {
  const parsed = MarketplaceIndex.safeParse(json);
  if (!parsed.success) return { index: null, errors: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`) };
  const index = parsed.data;
  const errors = [];
  const names = new Set();
  for (const e of index.extensions) {
    const where = e.name;
    if (names.has(e.name)) errors.push(`${where}: listed twice`);
    names.add(e.name);
    if (!/^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/.test(e.name)) errors.push(`${where}: not a valid npm package name`);
    for (const c of e.categories) if (!CATEGORY_IDS.has(c)) errors.push(`${where}: unknown category ${c}`);
    if (!e.versions.length) errors.push(`${where}: no versions`);
    const versions = new Set();
    for (const v of e.versions) {
      if (versions.has(v.version)) errors.push(`${where}@${v.version}: version listed twice`);
      versions.add(v.version);
      if (!isValidVersion(v.version)) errors.push(`${where}@${v.version}: not a semver version`);
      if (!isValidRange(v.engine)) errors.push(`${where}@${v.version}: engine is not a semver range`);
      if (e.source === 'npm' && !v.tarball.startsWith('https://')) errors.push(`${where}@${v.version}: tarball must be an https URL`);
      const tools = new Set();
      for (const t of v.tools) {
        if (tools.has(t.name)) errors.push(`${where}@${v.version}: tool ${t.name} listed twice`);
        tools.add(t.name);
      }
    }
  }
  return { index, errors };
}

/**
 * Index entry for a package folder or an extracted tarball.
 * @param {import('@oide/extension-host').LoadedExtension} loaded
 * @param {{ tarball: string, integrity: string, source?: 'npm' | 'builtin', verified?: boolean, repository?: string }} v
 */
export function entryFromLoaded(loaded, v) {
  const m = loaded.manifest;
  const repo = typeof m.repository === 'string' ? m.repository : m.repository?.url;
  /** @type {import('@oide/protocol').MarketplaceEntry} */
  const entry = {
    name: m.name,
    displayName: m.oide.displayName,
    publisher: m.oide.publisher ?? (m.name.startsWith('@') ? (m.name.slice(1).split('/')[0] ?? 'unknown') : 'unknown'),
    description: m.description ?? '',
    categories: m.oide.categories,
    verified: v.verified ?? false,
    source: v.source ?? 'npm',
    downloads: 0,
    versions: [
      {
        version: m.version,
        tarball: v.tarball,
        integrity: v.integrity,
        engine: m.oide.engine,
        tools: loaded.tools.map((t) => (t.description ? { name: t.tool, risk: t.risk, description: t.description } : { name: t.tool, risk: t.risk })),
        capabilities: { network: m.oide.capabilities.network, spawn: m.oide.capabilities.spawn },
      },
    ],
  };
  if (v.repository ?? repo) entry.repository = (v.repository ?? repo)?.replace(/^git\+/, '').replace(/\.git$/, '');
  return entry;
}

/**
 * The URL npm would serve the tarball from once published.
 * @param {string} name
 * @param {string} version
 */
export function npmTarballUrl(name, version) {
  const base = name.includes('/') ? name.split('/')[1] : name;
  return `https://registry.npmjs.org/${name}/-/${base}-${version}.tgz`;
}

/**
 * `npm pack` one package folder into outDir (no scripts run: --ignore-scripts).
 * @param {string} dir
 * @param {string} outDir
 * @returns {{ file: string, integrity: string }}
 */
export function npmPack(dir, outDir) {
  mkdirSync(outDir, { recursive: true });
  const args = ['pack', '--json', '--ignore-scripts', '--pack-destination', outDir];
  /** @type {import('node:child_process').ExecFileSyncOptionsWithStringEncoding} */
  const opts = { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] };
  // Run npm's own CLI with this Node, so no shell is needed for npm.cmd on Windows.
  const nodeDir = path.dirname(process.execPath);
  const cli = [path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'), path.join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')].find((p) => existsSync(p));
  const out = cli ? execFileSync(process.execPath, [cli, ...args], opts) : execFileSync('npm', args, opts);
  const info = JSON.parse(out.slice(out.indexOf('[')))[0];
  const file = path.join(outDir, info.filename);
  const integrity = computeIntegrity(readFileSync(file), 'sha512');
  if (info.integrity && info.integrity !== integrity) throw new Error(`npm and oIDE disagree on the integrity of ${file}`);
  return { file, integrity };
}

/**
 * Pack every built-in extension and build the bundled offline index. Only oIDE's own
 * extensions go in it; integrity comes from the locally packed tarballs.
 * @param {{ extensionsDir: string, tarballDir: string, generatedAt?: string }} o
 */
export function buildBundledIndex(o) {
  const extensions = [];
  for (const name of readdirSync(o.extensionsDir).sort()) {
    const dir = path.join(o.extensionsDir, name);
    if (!statSync(dir).isDirectory() || !existsSync(path.join(dir, 'package.json'))) continue;
    const loaded = loadManifest(dir);
    requireBundled(loaded);
    const { file, integrity } = npmPack(dir, o.tarballDir);
    extensions.push({ entry: entryFromLoaded(loaded, { tarball: npmTarballUrl(loaded.manifest.name, loaded.manifest.version), integrity, source: 'builtin', verified: true }), file });
  }
  const index = { version: 1, generatedAt: o.generatedAt ?? new Date().toISOString(), extensions: extensions.map((e) => e.entry) };
  const { errors } = validateIndex(index);
  if (errors.length) throw new Error(`Built index is invalid:\n${errors.join('\n')}`);
  return { index, tarballs: Object.fromEntries(extensions.map((e) => [`${e.entry.name}@${e.entry.versions[0]?.version}`, e.file])) };
}

/**
 * Check one version's tarball: integrity first, then safe extraction, the manifest, and that
 * the index entry lists exactly the manifest's tools (with no lowered risk) and capabilities.
 * @param {import('@oide/protocol').MarketplaceEntry} entry
 * @param {import('@oide/protocol').MarketplaceEntry['versions'][number]} v
 * @param {Uint8Array} data
 * @returns {Promise<string[]>}
 */
export async function checkTarball(entry, v, data) {
  const where = `${entry.name}@${v.version}`;
  if (!verifyIntegrity(data, v.integrity)) return [`${where}: tarball does not match its integrity hash`];
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'oide-index-'));
  const errors = [];
  try {
    const dest = path.join(tmp, 'pkg');
    await extractTarball(data, dest);
    const loaded = loadManifest(dest, { engineVersion: ENGINE_VERSION });
    requireBundled(loaded);
    const m = loaded.manifest;
    if (m.name !== entry.name) errors.push(`${where}: tarball is ${m.name}`);
    if (m.version !== v.version) errors.push(`${where}: tarball version is ${m.version}`);
    if (m.oide.engine !== v.engine) errors.push(`${where}: engine is ${m.oide.engine} in the manifest`);
    const listed = new Map(v.tools.map((t) => [t.name, t.risk]));
    for (const t of loaded.tools) {
      if (!listed.has(t.tool)) errors.push(`${where}: tool ${t.tool} is not listed in the index`);
      else if (listed.get(t.tool) !== t.risk) errors.push(`${where}: tool ${t.tool} is ${t.risk} in the manifest, ${listed.get(t.tool)} in the index`);
    }
    for (const name of listed.keys()) if (!loaded.tools.some((t) => t.tool === name)) errors.push(`${where}: index lists tool ${name} the manifest does not have`);
    const caps = m.oide.capabilities;
    const ic = v.capabilities ?? { network: [], spawn: false };
    if (caps.spawn !== ic.spawn || caps.network.join(',') !== ic.network.join(',')) errors.push(`${where}: capabilities differ from the manifest`);
  } catch (e) {
    errors.push(`${where}: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return errors;
}

/**
 * Validate an index and every tarball. Tarballs come from `local` (name@version → file) when
 * given, otherwise they are downloaded; builtin entries must be given locally.
 * @param {unknown} json
 * @param {{ local?: Record<string, string>, fetch?: typeof fetch }} [o]
 */
export async function validateAll(json, o = {}) {
  const { index, errors } = validateIndex(json);
  if (!index) return errors;
  const f = o.fetch ?? fetch;
  for (const e of index.extensions) {
    for (const v of e.versions) {
      const key = `${e.name}@${v.version}`;
      let data;
      try {
        const local = o.local?.[key];
        if (local) data = readFileSync(local);
        else if (e.source === 'builtin') {
          errors.push(`${key}: builtin entries are checked against locally packed tarballs (none given)`);
          continue;
        } else {
          const res = await f(v.tarball);
          if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
          data = new Uint8Array(await res.arrayBuffer());
        }
      } catch (err) {
        errors.push(`${key}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      errors.push(...(await checkTarball(e, v, data)));
    }
  }
  return errors;
}

/**
 * @param {string} file
 * @param {unknown} value
 */
export function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}
