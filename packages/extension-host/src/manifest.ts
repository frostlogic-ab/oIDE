import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { API_VERSION } from '@oide/extension-api';
import { ExtensionManifest, type ToolRisk } from '@oide/protocol';
import { isValidRange, isValidVersion, satisfies } from './semver.js';

/** The extension API version this host implements. Manifests declare a range for it in `oide.engine`. */
export const ENGINE_VERSION = API_VERSION;

export type ManifestErrorCode = 'not-found' | 'invalid-json' | 'schema' | 'engine' | 'path-escape' | 'missing-file' | 'invalid';

export class ManifestError extends Error {
  constructor(
    readonly code: ManifestErrorCode,
    message: string,
    readonly issues: string[] = [],
  ) {
    super(message);
    this.name = 'ManifestError';
  }
}

export interface ResolvedMcpServer {
  /** Executable (`node`, `uvx`, …) or an absolute path inside the package. */
  command: string;
  /** Args with package-relative paths made absolute. */
  args: string[];
  env: Record<string, string>;
  cwd: string;
  tools: Record<string, { risk: ToolRisk; description?: string | undefined }>;
}

export interface ResolvedPanel {
  id: string;
  title: string;
  location: 'inspector' | 'screen';
  /** Absolute path of the panel's HTML entry. */
  entry: string;
}

export interface LoadedExtension {
  dir: string;
  manifest: ExtensionManifest;
  /** Absolute path of the host module, if the extension has host code. */
  main?: string;
  panels: ResolvedPanel[];
  artifactTypes: Array<{ id: string; label: string; entry: string }>;
  languages: Array<{ id: string; extensions: string[]; command: string; args: string[] }>;
  mcpServers: Record<string, ResolvedMcpServer>;
  /** Declared activation events plus `onCommand:<id>` for every contributed command. */
  activation: string[];
  /** Every tool the extension hands to agents, flattened. */
  tools: Array<{ server: string; tool: string; risk: ToolRisk; description?: string | undefined }>;
}

export interface LoadManifestOptions {
  /** Defaults to ENGINE_VERSION. */
  engineVersion?: string;
  /** Check that referenced files exist (default true). */
  requireFiles?: boolean;
}

const SERVER_NAME = /^[a-zA-Z0-9_-]+$/;

function isAbsoluteAnywhere(p: string): boolean {
  return path.isAbsolute(p) || path.win32.isAbsolute(p) || path.posix.isAbsolute(p) || /^[a-zA-Z]:/.test(p);
}

/**
 * Resolve a package-relative path and make sure it stays inside `dir`, also through symlinks.
 * Throws ManifestError('path-escape').
 */
export function resolveInside(dir: string, rel: string, what: string): string {
  if (!rel || isAbsoluteAnywhere(rel)) throw new ManifestError('path-escape', `${what} must be a relative path inside the package: ${rel}`);
  if (rel.split(/[\\/]+/).includes('..')) throw new ManifestError('path-escape', `${what} escapes the package folder: ${rel}`);
  const root = path.resolve(dir);
  const abs = path.resolve(root, rel);
  const relToRoot = path.relative(root, abs);
  if (relToRoot.startsWith('..') || path.isAbsolute(relToRoot)) throw new ManifestError('path-escape', `${what} escapes the package folder: ${rel}`);
  if (existsSync(abs)) {
    const realRoot = realpathSync(root);
    const real = realpathSync(abs);
    const r = path.relative(realRoot, real);
    if (r.startsWith('..') || path.isAbsolute(r)) throw new ManifestError('path-escape', `${what} resolves outside the package folder (symlink): ${rel}`);
  }
  return abs;
}

/** Heuristic: does an MCP server arg name a file in the package (`dist/mcp.js`, `./server.py`)? */
export function isPathLikeArg(arg: string): boolean {
  if (!arg || arg.startsWith('-') || arg.includes('://') || arg.includes('=') || arg.startsWith('@')) return false;
  if (isAbsoluteAnywhere(arg)) return true;
  if (arg.startsWith('./') || arg.startsWith('../') || arg.startsWith('.\\') || arg.startsWith('..\\')) return true;
  return /^[\w.-]+([\\/][\w.@-]+)+$/.test(arg) || /\.(m?js|cjs|py|sh|ts)$/.test(arg);
}

function isPathLikeCommand(cmd: string): boolean {
  return cmd.includes('/') || cmd.includes('\\') || cmd.startsWith('.');
}

/** Parse and validate a package.json object (no file access). */
export function parseManifest(pkg: unknown, opts: Pick<LoadManifestOptions, 'engineVersion'> = {}): ExtensionManifest {
  if (!pkg || typeof pkg !== 'object' || !('oide' in pkg)) throw new ManifestError('schema', 'package.json has no "oide" manifest');
  const parsed = ExtensionManifest.safeParse(pkg);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new ManifestError('schema', `Invalid oide manifest: ${issues.join('; ')}`, issues);
  }
  const m = parsed.data;
  const issues: string[] = [];
  if (!isValidVersion(m.version)) issues.push(`version: not a semver version: ${m.version}`);
  if (!isValidRange(m.oide.engine)) issues.push(`oide.engine: not a semver range: ${m.oide.engine}`);
  for (const name of Object.keys(m.oide.mcpServers)) if (!SERVER_NAME.test(name)) issues.push(`oide.mcpServers.${name}: server names may only use letters, digits, _ and -`);
  const dup = (ids: string[]) => ids.filter((id, i) => ids.indexOf(id) !== i);
  for (const d of dup(m.oide.contributes.panels.map((p) => p.id))) issues.push(`oide.contributes.panels: duplicate id ${d}`);
  for (const d of dup(m.oide.contributes.commands.map((c) => c.id))) issues.push(`oide.contributes.commands: duplicate id ${d}`);
  for (const a of m.oide.activation) if (!/^(\*|onStartup|onAgentSpawn|onCommand:.+)$/.test(a)) issues.push(`oide.activation: unknown event ${a}`);
  if (issues.length) throw new ManifestError('invalid', `Invalid oide manifest: ${issues.join('; ')}`, issues);
  const engineVersion = opts.engineVersion ?? ENGINE_VERSION;
  if (!satisfies(engineVersion, m.oide.engine)) {
    throw new ManifestError('engine', `${m.name} needs oIDE extension API ${m.oide.engine}; this oIDE has ${engineVersion}`);
  }
  return m;
}

/** Read `<dir>/package.json`, validate its `oide` manifest and resolve every path inside `dir`. */
export function loadManifest(dir: string, opts: LoadManifestOptions = {}): LoadedExtension {
  const root = path.resolve(dir);
  const pkgPath = path.join(root, 'package.json');
  if (!existsSync(pkgPath)) throw new ManifestError('not-found', `No package.json in ${root}`);
  let pkg: unknown;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  } catch {
    throw new ManifestError('invalid-json', `package.json in ${root} is not valid JSON`);
  }
  const manifest = parseManifest(pkg, opts);
  return resolveManifest(root, manifest, opts.requireFiles ?? true);
}

function mustExist(p: string, what: string, requireFiles: boolean): void {
  if (!requireFiles) return;
  if (!existsSync(p) || !statSync(p).isFile()) throw new ManifestError('missing-file', `${what} not found: ${p}`);
}

export function resolveManifest(root: string, manifest: ExtensionManifest, requireFiles = true): LoadedExtension {
  const o = manifest.oide;
  let main: string | undefined;
  if (o.main) {
    main = resolveInside(root, o.main, 'oide.main');
    mustExist(main, 'oide.main', requireFiles);
  }
  const panels = o.contributes.panels.map((p) => {
    const entry = resolveInside(root, p.entry, `panel ${p.id} entry`);
    mustExist(entry, `panel ${p.id} entry`, requireFiles);
    return { id: p.id, title: p.title, location: p.location, entry };
  });
  const artifactTypes = o.contributes.artifactTypes.map((a) => {
    const entry = resolveInside(root, a.entry, `artifact type ${a.id} entry`);
    mustExist(entry, `artifact type ${a.id} entry`, requireFiles);
    return { ...a, entry };
  });
  const resolveCmd = (command: string, what: string) => (isPathLikeCommand(command) ? resolveInside(root, command, what) : command);
  const resolveArgs = (args: string[], what: string) =>
    args.map((a) => {
      if (!isPathLikeArg(a)) return a;
      const abs = resolveInside(root, a, what);
      if (/\.(m?js|cjs|py|sh)$/.test(a)) mustExist(abs, what, requireFiles);
      return abs;
    });
  const languages = o.contributes.languages.map((l) => ({
    id: l.id,
    extensions: l.extensions,
    command: resolveCmd(l.command, `language ${l.id} command`),
    args: resolveArgs(l.args, `language ${l.id} args`),
  }));
  const mcpServers: Record<string, ResolvedMcpServer> = {};
  const tools: LoadedExtension['tools'] = [];
  for (const [name, s] of Object.entries(o.mcpServers)) {
    mcpServers[name] = {
      command: resolveCmd(s.command, `mcp server ${name} command`),
      args: resolveArgs(s.args, `mcp server ${name} args`),
      env: s.env,
      cwd: root,
      tools: s.tools,
    };
    for (const [tool, t] of Object.entries(s.tools)) tools.push({ server: name, tool, risk: t.risk, description: t.description });
  }
  const activation = [...o.activation];
  for (const c of o.contributes.commands) if (!activation.includes(`onCommand:${c.id}`)) activation.push(`onCommand:${c.id}`);
  const loaded: LoadedExtension = { dir: root, manifest, panels, artifactTypes, languages, mcpServers, activation, tools };
  if (main) loaded.main = main;
  return loaded;
}

/** Capabilities as consent strings ("network: localhost", "spawn processes", "fs: ~/data"). */
export function capabilityList(m: ExtensionManifest | { oide: { capabilities: { network: string[]; spawn: boolean; fs?: string[] } } }): string[] {
  const c = m.oide.capabilities;
  return [...c.network.map((n) => `network:${n}`), ...(c.spawn ? ['spawn'] : []), ...(c.fs ?? []).map((f) => `fs:${f}`)];
}
