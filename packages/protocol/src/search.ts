import { z } from 'zod';

/**
 * Files › quick open (Ctrl/Cmd+K file names) and Files › Search (content search and replace).
 * Schemas for the IPC contract plus the pure text helpers both sides share, so the renderer's
 * replace preview and main's replace produce exactly the same text (wiki: screen-files.md).
 */

/** A checkout root: a project folder or an agent worktree (absolute path, checked in main). */
const Root = z.string().min(1).max(4096);
/** A path relative to its root, `/` separators. */
const RelPath = z.string().min(1).max(4096);

/** Query text for content search: one line, no NUL (git gets it as an argument). */
export const SearchQuery = z
  .string()
  .min(1)
  .max(1000)
  .refine((q) => !/[\0\r\n]/.test(q), 'Search text must be a single line');

export const SearchFlags = z.object({
  isRegex: z.boolean().default(false),
  matchCase: z.boolean().default(false),
  wholeWord: z.boolean().default(false),
});
export type SearchFlags = z.infer<typeof SearchFlags>;
export interface SearchOptions extends SearchFlags {
  query: string;
}

export const FileNameMatch = z.object({
  root: z.string(),
  path: z.string(),
  score: z.number(),
  /** Indexes into `path` of the matched characters (for highlighting). */
  positions: z.array(z.number().int().nonnegative()),
  /** In the caller's recently opened list (ranked first). */
  recent: z.boolean().default(false),
});
export type FileNameMatch = z.infer<typeof FileNameMatch>;

export const FindByNameInput = z.object({
  roots: z.array(Root).min(1).max(32),
  query: z.string().max(300),
  limit: z.number().int().min(1).max(200).default(50),
  /** Recently opened files, most recent first; matching ones rank first. */
  recent: z.array(z.object({ root: Root, path: RelPath })).max(100).default([]),
});
export const FindByNameOutput = z.object({
  results: z.array(FileNameMatch),
  /** Files indexed across the roots. */
  total: z.number().int().nonnegative(),
  /** An index was (re)building; results may be from the previous index. */
  stale: z.boolean(),
});

export const ContentMatch = z.object({
  /** 1-based line number. */
  line: z.number().int().positive(),
  /** 0-based UTF-16 offset of the match in the line (line without its `\r\n` / `\n`). */
  column: z.number().int().nonnegative(),
  length: z.number().int().positive(),
  /** The matched text (replace checks it is still there). */
  text: z.string(),
  /** A window of the line around the match (long lines are cut). */
  preview: z.string(),
  /** Offset of `preview` in the line: the match is at `column - previewStart` in the preview. */
  previewStart: z.number().int().nonnegative(),
});
export type ContentMatch = z.infer<typeof ContentMatch>;

export const ContentFileResult = z.object({
  root: z.string(),
  path: z.string(),
  /** sha256 (hex) of the file's bytes when it was searched; replace refuses the file if it changed. */
  hash: z.string(),
  mtimeMs: z.number(),
  matches: z.array(ContentMatch),
});
export type ContentFileResult = z.infer<typeof ContentFileResult>;

export const SearchContentInput = SearchFlags.extend({
  /** Chosen by the renderer; results arrive as `files.searchResults` events with this id. */
  searchId: z.string().min(1).max(64),
  roots: z.array(Root).min(1).max(32),
  query: SearchQuery,
  /** Comma-separated globs ("src/**, *.ts"); a name without `/` matches at any depth. */
  include: z.string().max(2000).default(''),
  exclude: z.string().max(2000).default(''),
  maxResults: z.number().int().min(1).max(20_000).default(2000),
});

export const SearchResultsEvent = z.object({
  searchId: z.string(),
  files: z.array(ContentFileResult),
  done: z.boolean(),
  /** The result cap was reached (or files were skipped for size); the search stopped early. */
  truncated: z.boolean().default(false),
  cancelled: z.boolean().optional(),
  error: z.string().optional(),
  /** Set on the final batch. */
  stats: z.object({ files: z.number().int(), matches: z.number().int(), ms: z.number(), engine: z.enum(['git-grep', 'scan', 'mixed']) }).optional(),
});
export type SearchResultsEvent = z.infer<typeof SearchResultsEvent>;

export const ReplaceInput = SearchFlags.extend({
  query: SearchQuery,
  replacement: z.string().max(10_000),
  files: z
    .array(
      z.object({
        root: Root,
        path: RelPath,
        hash: z.string().regex(/^[a-f0-9]{64}$/),
        matches: z.array(ContentMatch.pick({ line: true, column: true, length: true, text: true })).min(1).max(20_000),
      }),
    )
    .min(1)
    .max(2000),
});
export const ReplaceFileResult = z.object({
  root: z.string(),
  path: z.string(),
  /** `stale`: the file changed since the search (or a match moved); nothing was written. */
  status: z.enum(['replaced', 'stale', 'failed']),
  replaced: z.number().int().nonnegative(),
  message: z.string().optional(),
});
export type ReplaceFileResult = z.infer<typeof ReplaceFileResult>;
export const ReplaceOutput = z.object({ results: z.array(ReplaceFileResult) });

// ---------------------------------------------------------------------------------------- text

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The JavaScript regular expression for a search (global). Literal text is escaped; whole word
 * uses lookarounds (like `git grep -w`: no word character on either side), so a query that starts
 * or ends with punctuation still matches. Throws `SyntaxError` for an invalid regex.
 */
export function buildSearchRegExp(o: SearchOptions): RegExp {
  let src = o.isRegex ? o.query : escapeRegExp(o.query);
  if (o.wholeWord) src = `(?<!\\w)(?:${src})(?!\\w)`;
  return new RegExp(src, `g${o.matchCase ? '' : 'i'}`);
}

/** Lines of a text without their terminators, with the offset where each starts. */
export function splitLines(content: string): Array<{ text: string; start: number }> {
  const out: Array<{ text: string; start: number }> = [];
  let start = 0;
  for (;;) {
    const nl = content.indexOf('\n', start);
    if (nl < 0) {
      if (start < content.length || out.length === 0) out.push({ text: content.slice(start), start });
      return out;
    }
    const end = nl > start && content.charCodeAt(nl - 1) === 13 ? nl - 1 : nl;
    out.push({ text: content.slice(start, end), start });
    start = nl + 1;
  }
}

const PREVIEW_BEFORE = 40;
const PREVIEW_MAX = 240;

/** Matches of `re` (global) in one line; empty matches are skipped. */
export function lineMatches(lineText: string, lineNo: number, re: RegExp, max = Infinity): ContentMatch[] {
  const out: ContentMatch[] = [];
  re.lastIndex = 0;
  for (let m = re.exec(lineText); m && out.length < max; m = re.exec(lineText)) {
    if (m[0].length === 0) {
      re.lastIndex++;
      continue;
    }
    const previewStart = Math.max(0, m.index - PREVIEW_BEFORE);
    // Do not start the preview in the middle of a surrogate pair.
    const ps = previewStart > 0 && /[\uDC00-\uDFFF]/.test(lineText[previewStart] ?? '') ? previewStart - 1 : previewStart;
    out.push({
      line: lineNo,
      column: m.index,
      length: m[0].length,
      text: m[0].slice(0, 1000),
      preview: lineText.slice(ps, Math.max(ps + PREVIEW_MAX, m.index + m[0].length + 40)).slice(0, PREVIEW_MAX + 1000),
      previewStart: ps,
    });
  }
  re.lastIndex = 0;
  return out;
}

/** Every match in a text (capped). */
export function findMatches(content: string, re: RegExp, max = Infinity): ContentMatch[] {
  const out: ContentMatch[] = [];
  const lines = splitLines(content);
  for (let i = 0; i < lines.length && out.length < max; i++) out.push(...lineMatches(lines[i]!.text, i + 1, re, max - out.length));
  return out;
}

/** `$&`, `$1`…`$99`, `$<name>` and `$$` in a regex replacement, like `String.prototype.replace`. */
export function expandReplacement(template: string, m: RegExpExecArray): string {
  return template.replace(/\$(\$|&|<([^>]*)>|(\d{1,2}))/g, (whole, tok: string, name: string | undefined, num: string | undefined) => {
    if (tok === '$') return '$';
    if (tok === '&') return m[0];
    if (name !== undefined) return m.groups?.[name] ?? '';
    if (num !== undefined) {
      const two = Number(num);
      if (num.length === 2 && two < m.length) return m[two] ?? '';
      const one = Number(num[0]);
      if (one >= 1 && one < m.length) return (m[one] ?? '') + (num.length === 2 ? num[1] : '');
      return whole;
    }
    return whole;
  });
}

export function stickyRegExp(o: SearchOptions): RegExp {
  const re = buildSearchRegExp(o);
  return new RegExp(re.source, re.flags.replace('g', '') + 'y');
}

/** What one match becomes: the replacement verbatim for text searches, expanded for regexes; null when it no longer matches there. */
export function replacementFor(
  lineText: string,
  match: Pick<ContentMatch, 'column' | 'text'>,
  o: SearchOptions,
  replacement: string,
  sticky: RegExp = stickyRegExp(o),
): string | null {
  sticky.lastIndex = match.column;
  const m = sticky.exec(lineText);
  if (!m || m[0] !== match.text) return null;
  return o.isRegex ? expandReplacement(replacement, m) : replacement;
}

export interface ReplaceResult {
  content: string;
  replaced: number;
  /** Matches that are no longer where the search found them. */
  missing: number;
}

/**
 * Replaces exactly the given matches (line, column, text) in `content`. Each match is re-checked
 * against the regex at its position; matches that moved are counted in `missing` and left alone.
 * Overlapping matches are skipped. Line endings are preserved.
 */
export function applyReplacements(
  content: string,
  o: SearchOptions,
  replacement: string,
  matches: ReadonlyArray<Pick<ContentMatch, 'line' | 'column' | 'length' | 'text'>>,
): ReplaceResult {
  const lines = splitLines(content);
  const sticky = stickyRegExp(o);
  const edits: Array<{ start: number; end: number; text: string }> = [];
  let missing = 0;
  for (const mt of matches) {
    const ln = lines[mt.line - 1];
    if (!ln || mt.column + mt.length > ln.text.length || ln.text.slice(mt.column, mt.column + mt.length) !== mt.text) {
      missing++;
      continue;
    }
    const rep = replacementFor(ln.text, mt, o, replacement, sticky);
    if (rep === null) {
      missing++;
      continue;
    }
    edits.push({ start: ln.start + mt.column, end: ln.start + mt.column + mt.length, text: rep });
  }
  edits.sort((a, b) => a.start - b.start);
  let out = '';
  let at = 0;
  let replaced = 0;
  for (const e of edits) {
    if (e.start < at) {
      missing++;
      continue;
    }
    out += content.slice(at, e.start) + e.text;
    at = e.end;
    replaced++;
  }
  out += content.slice(at);
  return { content: out, replaced, missing };
}

// ---------------------------------------------------------------------------------------- globs

/** Splits "a, {b,c}/*.ts" on commas outside braces. */
export function splitGlobList(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of list) {
    if (ch === '{') depth++;
    else if (ch === '}') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function globBody(glob: string): string {
  let re = '';
  let inClass = false;
  let braces = 0;
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (inClass) {
      if (ch === ']') {
        inClass = false;
        re += ']';
      } else re += ch === '\\' || ch === '^' ? `\\${ch}` : ch;
      continue;
    }
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        const slash = glob[i + 2] === '/';
        re += slash ? '(?:.*/)?' : '.*';
        i += slash ? 2 : 1;
      } else re += '[^/]*';
    } else if (ch === '?') re += '[^/]';
    else if (ch === '[' && glob.indexOf(']', i + 1) > i + 1) {
      inClass = true;
      re += '[';
      if (glob[i + 1] === '!') {
        re += '^';
        i++;
      }
    } else if (ch === '{') {
      braces++;
      re += '(?:';
    } else if (ch === '}' && braces > 0) {
      braces--;
      re += ')';
    } else if (ch === ',' && braces > 0) re += '|';
    else re += escapeRegExp(ch);
  }
  return re + ')'.repeat(braces);
}

/**
 * A path glob as a RegExp over `/`-separated relative paths. A pattern without `/` matches a file
 * or folder name at any depth ("*.ts", "node_modules"); one with `/` is relative to the root
 * ("src/**", "./docs"). A match on a folder covers everything inside it.
 */
export function globToRegExp(glob: string): RegExp {
  let g = glob.trim().replace(/\\/g, '/');
  g = g.replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+$/, '');
  const anywhere = !g.includes('/') || g.startsWith('**/');
  const body = globBody(g.startsWith('**/') ? g.slice(3) : g);
  return new RegExp(`^${anywhere ? '(?:.*/)?' : ''}${body}(?:/.*)?$`, 'i');
}

/** `include` / `exclude` glob lists → a path filter (empty include = everything). */
export function pathFilter(include: string, exclude: string): (path: string) => boolean {
  const inc = splitGlobList(include).map(globToRegExp);
  const exc = splitGlobList(exclude).map(globToRegExp);
  return (p) => (inc.length === 0 || inc.some((r) => r.test(p))) && !exc.some((r) => r.test(p));
}

// ---------------------------------------------------------------------------------------- fuzzy

const SEP = new Set(['/', '\\', '.', '_', '-', ' ']);

function isWordStart(path: string, i: number): boolean {
  if (i === 0) return true;
  const prev = path[i - 1]!;
  if (SEP.has(prev)) return true;
  const ch = path[i]!;
  return prev === prev.toLowerCase() && ch !== ch.toLowerCase() && ch === ch.toUpperCase();
}

/** Subsequence positions of `q` in `t` from `from`, greedy left to right (null when absent). */
function forward(q: string, t: string, from: number): number[] | null {
  const pos: number[] = [];
  let ti = from;
  for (let qi = 0; qi < q.length; qi++) {
    const f = t.indexOf(q[qi]!, ti);
    if (f < 0) return null;
    pos.push(f);
    ti = f + 1;
  }
  return pos;
}

/** Subsequence positions matched right to left, so the end of the query lands in the file name. */
function backward(q: string, t: string): number[] | null {
  const pos: number[] = new Array(q.length);
  let ti = t.length - 1;
  for (let qi = q.length - 1; qi >= 0; qi--) {
    const f = t.lastIndexOf(q[qi]!, ti);
    if (f < 0) return null;
    pos[qi] = f;
    ti = f - 1;
  }
  return pos;
}

function runScore(path: string, pos: number[]): number {
  let s = 0;
  for (let i = 0; i < pos.length; i++) {
    if (i > 0 && pos[i] === pos[i - 1]! + 1) s += 15;
    else if (i > 0) s -= Math.min((pos[i]! - pos[i - 1]! - 1) * 2, 20);
    if (isWordStart(path, pos[i]!)) s += 8;
  }
  return s;
}

/**
 * Score one term (lowercase, no spaces) against a path, VS Code quick-open style: the file name
 * beats the folders (exact name > name prefix > name substring > name subsequence), then a path
 * substring, then a path subsequence with the query's end in the name. Shorter paths win ties.
 */
export function scorePathTerm(q: string, path: string, lower: string): { score: number; positions: number[] } | null {
  if (!q) return { score: 0, positions: [] };
  const base = lower.lastIndexOf('/') + 1;
  const name = lower.slice(base);
  const lenPenalty = path.length * 0.2 + (name.length - q.length) * 0.5;
  const idx = name.indexOf(q);
  if (idx >= 0) {
    const positions = Array.from({ length: q.length }, (_, k) => base + idx + k);
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    let score = 10_000 + (idx === 0 ? 2_000 : isWordStart(path, base + idx) ? 1_000 : 0);
    if (name === q) score += 6_000;
    else if (stem === q) score += 5_000;
    return { score: score - lenPenalty, positions };
  }
  const inName = forward(q, name, 0);
  if (inName) {
    const positions = inName.map((p) => p + base);
    return { score: 7_000 + runScore(path, positions) - lenPenalty, positions };
  }
  const sub = lower.indexOf(q);
  if (sub >= 0) {
    const positions = Array.from({ length: q.length }, (_, k) => sub + k);
    return { score: 5_000 + (isWordStart(path, sub) ? 300 : 0) - lenPenalty, positions };
  }
  const pos = backward(q, lower);
  if (!pos) return null;
  const inBase = pos.filter((p) => p >= base).length;
  return { score: 1_000 + inBase * 40 + runScore(path, pos) - lenPenalty, positions: pos };
}

/** Score a query (space-separated terms must all match) against a path; null when it does not match. */
export function scorePath(query: string, path: string, lower = path.toLowerCase()): { score: number; positions: number[] } | null {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return { score: 0, positions: [] };
  let score = 0;
  const positions = new Set<number>();
  for (const t of terms) {
    const r = scorePathTerm(t.replace(/\\/g, '/'), path, lower);
    if (!r) return null;
    score += r.score;
    for (const p of r.positions) positions.add(p);
  }
  return { score, positions: [...positions].sort((a, b) => a - b) };
}

/** Quick open's query suffix: "file.ts:42" or "file.ts:42:7" → name and line/column. */
export function parseQuickOpenQuery(raw: string): { query: string; line?: number; column?: number } {
  const m = /^(.*?):(\d+)(?::(\d+))?\s*$/.exec(raw);
  if (!m || !m[1]!.trim()) return { query: raw.trim() };
  return { query: m[1]!.trim(), line: Number(m[2]), ...(m[3] ? { column: Number(m[3]) } : {}) };
}
