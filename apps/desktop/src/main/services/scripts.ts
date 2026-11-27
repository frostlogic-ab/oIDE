import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import type { ProjectScript, ScriptRunner } from '@oide/protocol';

/**
 * Files › Run: finds the run scripts of a checkout from its own files, like VS Code's npm scripts
 * view and task detection. Only the checkout's top folder is read; nothing is executed here.
 *
 * - package.json `scripts` → `<pm> run <name>` (pm from `packageManager`, else the lockfile)
 * - deno.json(c) `tasks` → `deno task <name>`; composer.json `scripts` → `composer run-script <name>`
 * - Makefile targets → `make <target>`; justfile recipes → `just <recipe>`
 * - Cargo.toml, go.mod, *.sln / *.csproj, gradlew, pom.xml, manage.py → their usual verbs
 *
 * Names that are not plain words (shell metacharacters, spaces) are skipped, so a command line is
 * never built from text that a shell would interpret.
 */

/** Script names that are safe to put on a command line unquoted, in PowerShell, bash and zsh. */
const SAFE_NAME = /^[A-Za-z0-9_][A-Za-z0-9_:.+/@-]{0,199}$/;
/** Cap per source, so a generated Makefile can't flood the menu. */
const MAX_PER_SOURCE = 100;
/** Larger manifests are skipped rather than parsed. */
const MAX_FILE_BYTES = 1024 * 1024;

export interface ScriptDetectOptions {
  platform?: NodeJS.Platform;
  /** PATH lookup for the Windows `.cmd` shims (injected in tests). */
  hasCmdShim?: (name: string) => boolean;
}

interface Found {
  runner: ScriptRunner;
  file: string;
  name: string;
  command: string;
}

export async function detectScripts(root: string, opts: ScriptDetectOptions = {}): Promise<ProjectScript[]> {
  const platform = opts.platform ?? process.platform;
  let names: Set<string>;
  try {
    names = new Set(await readdir(root));
  } catch {
    return [];
  }
  const read = async (file: string): Promise<string | null> => {
    if (!names.has(file)) return null;
    try {
      const st = await stat(join(root, file));
      if (!st.isFile() || st.size > MAX_FILE_BYTES) return null;
      return await readFile(join(root, file), 'utf8');
    } catch {
      return null;
    }
  };
  const found: Found[] = [];
  const add = (runner: ScriptRunner, file: string, list: Array<{ name: string; command: string }>) => {
    for (const s of list.slice(0, MAX_PER_SOURCE)) found.push({ runner, file, ...s });
  };

  // ---- Node: package.json scripts
  const pkg = parseJson(await read('package.json'));
  const pkgScripts = scriptNames(pkg?.scripts);
  if (pkgScripts.length) {
    const pm = packageManager(pkg, names);
    const bin = shim(pm, platform, opts.hasCmdShim);
    add(pm, 'package.json', pkgScripts.map((name) => ({ name, command: `${bin} run ${name}` })));
  }

  // ---- Deno tasks
  for (const file of ['deno.json', 'deno.jsonc']) {
    const deno = parseJson(await read(file), file.endsWith('c'));
    const tasks = scriptNames(deno?.tasks);
    if (tasks.length) {
      add('deno', file, tasks.map((name) => ({ name, command: `deno task ${name}` })));
      break;
    }
  }

  // ---- Composer scripts
  const composer = parseJson(await read('composer.json'));
  const composerScripts = scriptNames(composer?.scripts);
  if (composerScripts.length) add('composer', 'composer.json', composerScripts.map((name) => ({ name, command: `composer run-script ${name}` })));

  // ---- Make
  for (const file of ['Makefile', 'makefile', 'GNUmakefile']) {
    const text = await read(file);
    if (text === null) continue;
    add('make', file, makeTargets(text).map((name) => ({ name, command: `make ${name}` })));
    break;
  }

  // ---- just
  for (const file of ['justfile', 'Justfile', '.justfile']) {
    const text = await read(file);
    if (text === null) continue;
    add('just', file, justRecipes(text).map((name) => ({ name, command: `just ${name}` })));
    break;
  }

  // ---- Fixed verbs per ecosystem
  if (names.has('Cargo.toml')) add('cargo', 'Cargo.toml', verbs('cargo', ['build', 'run', 'test', 'check', 'clippy']));
  if (names.has('go.mod')) add('go', 'go.mod', [
    { name: 'build', command: 'go build ./...' },
    { name: 'run', command: 'go run .' },
    { name: 'test', command: 'go test ./...' },
    { name: 'vet', command: 'go vet ./...' },
  ]);
  const dotnet = [...names].find((n) => /\.(sln|csproj|fsproj)$/i.test(n));
  if (dotnet) add('dotnet', dotnet, verbs('dotnet', ['build', 'run', 'test', 'watch']));
  const gradlew = names.has('gradlew') || names.has('gradlew.bat');
  if (gradlew || names.has('build.gradle') || names.has('build.gradle.kts')) {
    const bin = gradlew ? (platform === 'win32' ? '.\\gradlew.bat' : './gradlew') : 'gradle';
    add('gradle', gradlew ? (names.has('gradlew') ? 'gradlew' : 'gradlew.bat') : names.has('build.gradle') ? 'build.gradle' : 'build.gradle.kts', verbs(bin, ['build', 'run', 'test', 'clean']));
  }
  if (names.has('pom.xml')) add('maven', 'pom.xml', verbs('mvn', ['compile', 'test', 'package', 'clean']));
  if (names.has('manage.py')) {
    const py = platform === 'win32' ? 'python' : 'python3';
    add('python', 'manage.py', [
      { name: 'runserver', command: `${py} manage.py runserver` },
      { name: 'test', command: `${py} manage.py test` },
      { name: 'migrate', command: `${py} manage.py migrate` },
    ]);
  }

  return found.map((f) => ({ id: `${f.runner}:${f.file}:${f.name}`, name: f.name, runner: f.runner, command: f.command, file: f.file }));
}

function verbs(bin: string, list: string[]): Array<{ name: string; command: string }> {
  return list.map((name) => ({ name, command: `${bin} ${name}` }));
}

function parseJson(text: string | null, comments = false): Record<string, unknown> | null {
  if (text === null) return null;
  try {
    const src = comments ? stripJsonComments(text) : text;
    const v: unknown = JSON.parse(src.charCodeAt(0) === 0xfeff ? src.slice(1) : src);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Drops // and /* *\/ comments outside strings (deno.jsonc). */
export function stripJsonComments(text: string): string {
  let out = '';
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inStr) {
      out += c;
      if (c === '\\') out += text[++i] ?? '';
      else if (c === '"') inStr = false;
    } else if (c === '"') {
      inStr = true;
      out += c;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
    } else out += c;
  }
  return out;
}

function scriptNames(scripts: unknown): string[] {
  if (!scripts || typeof scripts !== 'object' || Array.isArray(scripts)) return [];
  return Object.entries(scripts as Record<string, unknown>)
    .filter(([name, v]) => SAFE_NAME.test(name) && (typeof v === 'string' || (v && typeof v === 'object')))
    .map(([name]) => name);
}

type NodePm = 'npm' | 'pnpm' | 'yarn' | 'bun';

export function packageManager(pkg: Record<string, unknown> | null, names: ReadonlySet<string>): NodePm {
  const field = typeof pkg?.packageManager === 'string' ? pkg.packageManager.split('@')[0] : undefined;
  if (field === 'pnpm' || field === 'yarn' || field === 'bun' || field === 'npm') return field;
  if (names.has('pnpm-lock.yaml')) return 'pnpm';
  if (names.has('yarn.lock')) return 'yarn';
  if (names.has('bun.lockb') || names.has('bun.lock')) return 'bun';
  return 'npm';
}

/**
 * On Windows the terminal is PowerShell, where `npm` resolves to `npm.ps1` first, which the default
 * execution policy refuses to load. The `.cmd` shim next to it runs either way, so it is used when
 * it is on PATH.
 */
function shim(pm: NodePm, platform: NodeJS.Platform, hasCmdShim = cmdShimOnPath): string {
  if (platform !== 'win32' || pm === 'bun') return pm;
  return hasCmdShim(pm) ? `${pm}.cmd` : pm;
}

const shimCache = new Map<string, boolean>();
function cmdShimOnPath(name: string): boolean {
  const cached = shimCache.get(name);
  if (cached !== undefined) return cached;
  const dirs = (process.env.PATH ?? process.env.Path ?? '').split(delimiter).filter(Boolean);
  // Synchronous on purpose: a handful of stat calls, cached for the app's lifetime.
  const hit = dirs.some((d) => existsSync(join(d, `${name}.cmd`)));
  shimCache.set(name, hit);
  return hit;
}

/**
 * Explicit Makefile targets: `name:` at the start of a line. Special targets (`.PHONY`), variable
 * assignments, pattern rules and file targets (`main.o`, `build/app`) are left out.
 */
export function makeTargets(text: string): string[] {
  const out = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Za-z0-9_][A-Za-z0-9_.\-/ ]*?)\s*::?(?![:=])/.exec(line);
    if (!m) continue;
    for (const t of m[1]!.split(/\s+/)) if (t && SAFE_NAME.test(t) && !/[%./]/.test(t)) out.add(t);
  }
  return [...out];
}

/** justfile recipes: `name args...:` at the start of a line (not `set`, `alias`, `export`, assignments). */
export function justRecipes(text: string): string[] {
  const out = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^@?([A-Za-z_][A-Za-z0-9_-]*)(?:\s+[^:]*)?:(?!=)/.exec(line);
    if (!m) continue;
    const name = m[1]!;
    if (['set', 'alias', 'export', 'import', 'mod'].includes(name)) continue;
    out.add(name);
  }
  return [...out];
}
