/**
 * A tiny semver subset: parse, compare and range checks (`^`, `~`, `>=`, `<`, `x`-ranges,
 * hyphen ranges, `||`). Enough for manifest engines and `.oide/extensions.json` ranges.
 */

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseVersion(v: string): SemVer | null {
  const m = VERSION_RE.exec(v.trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), prerelease: m[4] ? m[4].split('.') : [] };
}

export function isValidVersion(v: string): boolean {
  return parseVersion(v) !== null;
}

function cmpIdent(a: string, b: string): number {
  const an = /^\d+$/.test(a);
  const bn = /^\d+$/.test(b);
  if (an && bn) return Number(a) - Number(b);
  if (an) return -1;
  if (bn) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

export function compareVersions(a: string | SemVer, b: string | SemVer): number {
  const x = typeof a === 'string' ? parseVersion(a) : a;
  const y = typeof b === 'string' ? parseVersion(b) : b;
  if (!x || !y) throw new Error(`invalid version: ${String(typeof a === 'string' ? a : b)}`);
  if (x.major !== y.major) return Math.sign(x.major - y.major);
  if (x.minor !== y.minor) return Math.sign(x.minor - y.minor);
  if (x.patch !== y.patch) return Math.sign(x.patch - y.patch);
  if (!x.prerelease.length && !y.prerelease.length) return 0;
  if (!x.prerelease.length) return 1;
  if (!y.prerelease.length) return -1;
  const n = Math.max(x.prerelease.length, y.prerelease.length);
  for (let i = 0; i < n; i++) {
    const p = x.prerelease[i];
    const q = y.prerelease[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const c = cmpIdent(p, q);
    if (c !== 0) return Math.sign(c);
  }
  return 0;
}

type Op = '<' | '<=' | '>' | '>=' | '=';
interface Comparator {
  op: Op;
  v: SemVer;
}

/** A partial version like `1`, `1.2`, `1.x`, `*`. Missing parts are `null`. */
interface Partial {
  major: number | null;
  minor: number | null;
  patch: number | null;
  prerelease: string[];
}

function parsePartial(s: string): Partial | null {
  const t = s.trim().replace(/^v/, '').replace(/^=/, '');
  if (t === '' || t === '*' || t === 'x' || t === 'X') return { major: null, minor: null, patch: null, prerelease: [] };
  const m = /^(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(t);
  if (!m) return null;
  const num = (g: string | undefined) => (g === undefined || /^[xX*]$/.test(g) ? null : Number(g));
  const major = num(m[1]);
  const minor = major === null ? null : num(m[2]);
  const patch = minor === null ? null : num(m[3]);
  return { major, minor, patch, prerelease: m[4] ? m[4].split('.') : [] };
}

const sv = (major: number, minor: number, patch: number, prerelease: string[] = []): SemVer => ({ major, minor, patch, prerelease });

function expand(token: string): Comparator[] | null {
  const t = token.trim();
  const opMatch = /^(<=|>=|<|>|=|\^|~>?)?\s*(.*)$/.exec(t);
  if (!opMatch) return null;
  const op = opMatch[1] ?? '';
  const p = parsePartial(opMatch[2] ?? '');
  if (!p) return null;
  const { major, minor, patch, prerelease } = p;
  if (op === '^') {
    if (major === null) return [];
    if (major > 0 || minor === null) return [{ op: '>=', v: sv(major, minor ?? 0, patch ?? 0, prerelease) }, { op: '<', v: sv(major + 1, 0, 0, ['0']) }];
    if (minor > 0 || patch === null) return [{ op: '>=', v: sv(0, minor, patch ?? 0, prerelease) }, { op: '<', v: sv(0, minor + 1, 0, ['0']) }];
    return [{ op: '>=', v: sv(0, 0, patch, prerelease) }, { op: '<', v: sv(0, 0, patch + 1, ['0']) }];
  }
  if (op === '~' || op === '~>') {
    if (major === null) return [];
    if (minor === null) return [{ op: '>=', v: sv(major, 0, 0) }, { op: '<', v: sv(major + 1, 0, 0, ['0']) }];
    return [{ op: '>=', v: sv(major, minor, patch ?? 0, prerelease) }, { op: '<', v: sv(major, minor + 1, 0, ['0']) }];
  }
  if (op === '' || op === '=') {
    if (major === null) return [];
    if (minor === null) return [{ op: '>=', v: sv(major, 0, 0) }, { op: '<', v: sv(major + 1, 0, 0, ['0']) }];
    if (patch === null) return [{ op: '>=', v: sv(major, minor, 0) }, { op: '<', v: sv(major, minor + 1, 0, ['0']) }];
    return [{ op: '=', v: sv(major, minor, patch, prerelease) }];
  }
  // <, <=, >, >= with partials
  if (major === null) return op === '<' || op === '>' ? [{ op: '<', v: sv(0, 0, 0, ['0']) }] : [];
  const lo = sv(major, minor ?? 0, patch ?? 0, prerelease);
  if (op === '>=') return [{ op: '>=', v: lo }];
  if (op === '<') return [{ op: '<', v: lo }];
  if (op === '>') {
    if (minor === null) return [{ op: '>=', v: sv(major + 1, 0, 0) }];
    if (patch === null) return [{ op: '>=', v: sv(major, minor + 1, 0) }];
    return [{ op: '>', v: lo }];
  }
  // <=
  if (minor === null) return [{ op: '<', v: sv(major + 1, 0, 0, ['0']) }];
  if (patch === null) return [{ op: '<', v: sv(major, minor + 1, 0, ['0']) }];
  return [{ op: '<=', v: lo }];
}

function test(c: Comparator, v: SemVer): boolean {
  const r = compareVersions(v, c.v);
  switch (c.op) {
    case '<':
      return r < 0;
    case '<=':
      return r <= 0;
    case '>':
      return r > 0;
    case '>=':
      return r >= 0;
    case '=':
      return r === 0;
  }
}

function parseSet(set: string): Comparator[] | null {
  const s = set.trim();
  const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(s);
  if (hyphen) {
    const a = expand('>=' + hyphen[1]);
    const b = expand('<=' + hyphen[2]);
    return a && b ? [...a, ...b] : null;
  }
  // Join operators to their versions: ">= 1.2.3" → ">=1.2.3".
  const tokens = s.replace(/(<=|>=|<|>|=|\^|~>?)\s+/g, '$1').split(/\s+/).filter(Boolean);
  const out: Comparator[] = [];
  for (const tok of tokens) {
    const c = expand(tok);
    if (!c) return null;
    out.push(...c);
  }
  return out;
}

/** Whether `range` is a range this module understands. */
export function isValidRange(range: string): boolean {
  return range.split('||').every((s) => parseSet(s) !== null);
}

/**
 * npm-style `satisfies`. Prerelease versions only match a comparator set that names a prerelease
 * of the same `major.minor.patch`.
 */
export function satisfies(version: string, range: string): boolean {
  const v = parseVersion(version);
  if (!v) return false;
  for (const set of range.split('||')) {
    const comps = parseSet(set);
    if (!comps) continue;
    if (!comps.every((c) => test(c, v))) continue;
    if (v.prerelease.length) {
      const ok = comps.some((c) => c.v.prerelease.length > 0 && c.v.prerelease[0] !== '0' && c.v.major === v.major && c.v.minor === v.minor && c.v.patch === v.patch);
      if (!ok) continue;
    }
    return true;
  }
  return false;
}
