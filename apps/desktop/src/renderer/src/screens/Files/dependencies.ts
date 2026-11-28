/**
 * Files › package.json dependency versions (wiki: screen-files.md › Dependency versions): find the
 * dependencies a package.json lists (with their place in the text), read their version specs,
 * compare them with the registry's latest, and write the goal of an upgrade agent. Pure functions,
 * no Monaco: `monaco/npmVersions.ts` draws the hints.
 */
import type { PackageVersions } from '@oide/protocol';

/** The sections whose entries get a hint. */
export const DEPENDENCY_SECTIONS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const;
export type DependencySection = (typeof DEPENDENCY_SECTIONS)[number];
const SECTIONS = new Set<string>(DEPENDENCY_SECTIONS);

/** A `package.json` file (not one inside node_modules). */
export function isPackageJson(path: string): boolean {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] === 'package.json' && !parts.includes('node_modules');
}

/** One `"name": "spec"` entry of a dependency section. Lines and columns are 1-based (Monaco's). */
export interface DependencyEntry {
  section: DependencySection;
  name: string;
  spec: string;
  line: number;
  /** Column of the value's opening quote. */
  startColumn: number;
  /** Column just after the value's closing quote. */
  endColumn: number;
}

interface Frame {
  kind: 'obj' | 'arr';
  /** The key this container is the value of. */
  name: string | undefined;
  expectKey: boolean;
  key: string | undefined;
}

/**
 * The entries of the top-level dependency sections. A small tolerant scanner rather than
 * `JSON.parse`: it keeps positions and still works while the file is half edited (a missing comma,
 * a trailing one, comments). Values that are not strings (or keys of nested objects) are skipped.
 */
export function findDependencies(text: string): DependencyEntry[] {
  const out: DependencyEntry[] = [];
  const stack: Frame[] = [];
  let line = 1;
  let lineStart = 0;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i]!;
    if (c === '\n') {
      line++;
      lineStart = ++i;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end < 0 ? n : end + 2;
      for (let j = i; j < stop; j++) {
        if (text[j] !== '\n') continue;
        line++;
        lineStart = j + 1;
      }
      i = stop;
      continue;
    }
    const top = stack[stack.length - 1];
    if (c === '{' || c === '[') {
      stack.push({ kind: c === '{' ? 'obj' : 'arr', name: top?.kind === 'obj' ? top.key : undefined, expectKey: c === '{', key: undefined });
      i++;
      continue;
    }
    if (c === '}' || c === ']') {
      stack.pop();
      // The container was a value: its pair is complete (the next string is a key, comma or not).
      const parent = stack[stack.length - 1];
      if (parent?.kind === 'obj') {
        parent.expectKey = true;
        parent.key = undefined;
      }
      i++;
      continue;
    }
    if (c === ':') {
      if (top?.kind === 'obj') top.expectKey = false;
      i++;
      continue;
    }
    if (c === ',') {
      if (top?.kind === 'obj') {
        top.expectKey = true;
        top.key = undefined;
      }
      i++;
      continue;
    }
    if (c === '"') {
      const start = i;
      let value = '';
      i++;
      let closed = false;
      while (i < n) {
        const ch = text[i]!;
        if (ch === '\n') break; // unterminated: the string ends with the line
        if (ch === '\\') {
          const esc = text[i + 1];
          if (esc === 'u') {
            value += String.fromCharCode(parseInt(text.slice(i + 2, i + 6), 16) || 0);
            i += 6;
          } else {
            value += esc === 'n' ? '\n' : esc === 't' ? '\t' : (esc ?? '');
            i += 2;
          }
          continue;
        }
        if (ch === '"') {
          closed = true;
          i++;
          break;
        }
        value += ch;
        i++;
      }
      if (top?.kind !== 'obj') continue;
      if (top.expectKey) {
        top.key = value;
        continue;
      }
      if (closed && top.key !== undefined && stack.length === 2 && stack[0]!.kind === 'obj' && top.name && SECTIONS.has(top.name)) {
        out.push({ section: top.name as DependencySection, name: top.key, spec: value, line, startColumn: start - lineStart + 1, endColumn: i - lineStart + 1 });
      }
      // The pair is complete: the next string is a key, even when the comma is missing.
      top.expectKey = true;
      top.key = undefined;
      continue;
    }
    // A number, true / false / null, or stray text: skip to the next delimiter.
    const from = i;
    while (i < n && !/[\s{}[\]:,"/]/.test(text[i]!)) i++;
    if (i === from) i++; // a lone `/`, other whitespace: always move on
  }
  return out;
}

/** A parsed semver version. */
export interface Version {
  major: number;
  minor: number;
  patch: number;
  pre: string[];
}

export function parseVersion(v: string): Version | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(v.trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ? m[4].split('.') : [] };
}

/** Semver precedence: negative when `a` is older than `b`. */
export function compareVersions(a: Version, b: Version): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  // A release is newer than its prereleases.
  if (!a.pre.length || !b.pre.length) return (a.pre.length ? -1 : 0) + (b.pre.length ? 1 : 0);
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i];
    const y = b.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      const d = Number(x) - Number(y);
      if (d) return d;
    } else if (xn !== yn) return xn ? -1 : 1;
    else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** What a dependency's spec asks for, when it is a plain registry version. */
export interface DependencySpec {
  /** The package to look up (an `npm:` alias's target). */
  lookup: string;
  /** The range operator kept on upgrade (`^`, `~`, `>=`, or empty for an exact version). */
  prefix: string;
  /** The lowest version the spec names (`~5.9` → 5.9.0). */
  version: Version;
  /** That version as written, filled to three parts (`5.9.0`). */
  text: string;
}

/**
 * The spec of a registry dependency (`^1.2.3`, `~5.9`, `2.0.0-alpha.21`, `>=18`, `npm:pkg@^1`), or
 * null for what has no "latest" to compare with: workspace / file / link / git / URL specs, tags
 * (`latest`, `next`), `*`, unions (`^1 || ^2`) and upper bounds.
 */
export function parseSpec(name: string, spec: string): DependencySpec | null {
  let lookup = name;
  let s = spec.trim();
  const alias = /^npm:((?:@[^/@\s]+\/)?[^@\s]+)@(.+)$/.exec(s);
  if (alias) {
    lookup = alias[1]!;
    s = alias[2]!.trim();
  } else if (s.includes(':') || s.includes('/')) return null;
  const m = /^(\^|~|>=|=|v)?\s*v?(\d+)(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(-[0-9A-Za-z.-]+)?$/.exec(s);
  if (!m) return null;
  const num = (p: string | undefined) => (p === undefined || /^[xX*]$/.test(p) ? 0 : Number(p));
  // A prerelease tag only counts on a full version (`1.2.3-beta.1`).
  if (m[5] && (m[3] === undefined || m[4] === undefined)) return null;
  const text = `${m[2]}.${num(m[3])}.${num(m[4])}${m[5] ?? ''}`;
  const version = parseVersion(text);
  if (!version) return null;
  const prefix = m[1] === '=' || m[1] === 'v' ? '' : (m[1] ?? '');
  return { lookup, prefix, version, text };
}

export type Bump = 'major' | 'minor' | 'patch' | 'prerelease';

export type DependencyHint =
  | { kind: 'update'; version: string; bump: Bump }
  /** Nothing newer on the registry (on this prerelease channel, for a prerelease spec). */
  | { kind: 'latest'; version: string };

/** How far `to` is ahead of `from`. A 0.x minor (or 0.0.x patch) counts as major: it may break. */
export function bumpOf(from: Version, to: Version): Bump {
  if (to.major !== from.major) return 'major';
  if (to.minor !== from.minor) return from.major === 0 ? 'major' : 'minor';
  if (to.patch !== from.patch) return from.major === 0 && from.minor === 0 ? 'major' : 'patch';
  return 'prerelease';
}

/**
 * The hint for a spec, given the registry's dist-tags. A spec on a prerelease newer than `latest`
 * (`2.0.0-alpha.21` while latest is 1.6.4) follows its own channel: the newest tag above it.
 */
export function hintFor(spec: DependencySpec, versions: PackageVersions): DependencyHint | null {
  const latest = parseVersion(versions.latest);
  if (!latest) return null;
  if (compareVersions(latest, spec.version) > 0) return { kind: 'update', version: versions.latest, bump: bumpOf(spec.version, latest) };
  if (spec.version.pre.length && compareVersions(spec.version, latest) > 0) {
    let best: { v: Version; text: string } | undefined;
    for (const text of Object.values(versions.tags)) {
      const v = parseVersion(text);
      if (v && compareVersions(v, spec.version) > 0 && (!best || compareVersions(v, best.v) > 0)) best = { v, text };
    }
    if (best) return { kind: 'update', version: best.text, bump: bumpOf(spec.version, best.v) };
    return { kind: 'latest', version: spec.text };
  }
  return { kind: 'latest', version: versions.latest };
}

/** What the upgrade agent is asked to do (Spawn's goal, editable before it starts). */
export interface UpgradeRequest {
  /** The package.json, relative to its checkout. */
  path: string;
  name: string;
  /** The lookup name when the entry is an `npm:` alias. */
  lookup: string;
  section: DependencySection;
  spec: string;
  to: string;
  bump: Bump;
}

export function upgradeGoal(u: UpgradeRequest): string {
  const pkg = u.lookup === u.name ? `\`${u.name}\`` : `\`${u.name}\` (an alias of \`${u.lookup}\`)`;
  const major = u.bump === 'major' ? ' This is a major upgrade: expect breaking changes.' : '';
  return [
    `Upgrade the npm package ${pkg} in ${u.path} (${u.section}) from \`${u.spec}\` to ${u.to}.${major}`,
    '',
    `1. Read the changelog, release notes and migration guides of ${u.lookup} for every version after the one we use up to ${u.to} (the package's CHANGELOG, its repository's releases). List the breaking changes, deprecations and notable improvements.`,
    `2. Update the version in ${u.path}, keeping its range style, and refresh the lockfile with the project's package manager.`,
    '3. Fix every breaking change in the codebase and replace deprecated APIs. Where a new feature or improvement makes our code simpler, faster or safer, adopt it.',
    "4. Run the project's typecheck, tests and lint, and fix what fails.",
    '5. In your summary, list what changed upstream, what you changed and why, and what you chose not to adopt.',
  ].join('\n');
}
