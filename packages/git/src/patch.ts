import type { FileDiff } from '@oide/protocol';

/**
 * A tolerant parser for `git diff` unified output (with `--src-prefix=a/ --dst-prefix=b/`).
 * Handles renames and copies, new and deleted files, mode-only changes, binary files (both
 * "Binary files differ" and `GIT binary patch`), quoted paths and "\ No newline at end of file".
 * Hunk bodies are consumed by their line counts, so content lines that look like headers
 * (for example a deleted line "-- a/x") never confuse it.
 */

export interface DiffLine {
  kind: 'context' | 'add' | 'del' | 'no-newline';
  text: string;
  oldLine?: number;
  newLine?: number;
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** Text after the second `@@` (usually the enclosing function). */
  section: string;
  lines: DiffLine[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

/** Decode a C-style quoted git path (`"a/caf\303\251 \"x\""`). Returns the input when not quoted. */
export function unquoteGitPath(s: string): string {
  if (s.length < 2 || s[0] !== '"' || s[s.length - 1] !== '"') return s;
  const body = s.slice(1, -1);
  const bytes: number[] = [];
  const pushStr = (str: string) => {
    for (const b of Buffer.from(str, 'utf8')) bytes.push(b);
  };
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (c !== '\\') {
      pushStr(c);
      continue;
    }
    const n = body[++i];
    if (n === undefined) break;
    if (/[0-7]/.test(n)) {
      let oct = n;
      while (oct.length < 3 && /[0-7]/.test(body[i + 1] ?? '')) oct += body[++i];
      bytes.push(parseInt(oct, 8));
      continue;
    }
    const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', f: '\f', v: '\v', '"': '"', '\\': '\\' };
    pushStr(map[n] ?? n);
  }
  return Buffer.from(bytes).toString('utf8');
}

/** Strip `a/` / `b/` prefix (after unquoting). `/dev/null` → undefined. */
function stripPrefix(p: string): string | undefined {
  const raw = unquoteGitPath(p.replace(/\t$/, ''));
  if (raw === '/dev/null') return undefined;
  if (raw.startsWith('a/') || raw.startsWith('b/')) return raw.slice(2);
  return raw;
}

/** `--- a/foo\t` lines may carry a trailing tab + timestamp from some tools; git adds a tab only for paths with spaces. */
function headerPath(line: string, marker: '--- ' | '+++ '): string | undefined {
  let rest = line.slice(marker.length);
  if (!rest.startsWith('"')) {
    const tab = rest.indexOf('\t');
    if (tab >= 0) rest = rest.slice(0, tab);
  }
  return stripPrefix(rest);
}

/** Paths from `diff --git a/x b/y` when no ---/+++ lines follow (binary or mode-only). */
function pathsFromDiffGit(line: string): { a?: string; b?: string } {
  const rest = line.slice('diff --git '.length);
  if (rest.startsWith('"')) {
    // "a/…" "b/…" or "a/…" b/…
    const end = findQuoteEnd(rest, 0);
    const a = rest.slice(0, end + 1);
    const b = rest.slice(end + 2);
    return { a: stripPrefix(a), b: stripPrefix(b) };
  }
  const bq = rest.indexOf(' "b/');
  if (bq >= 0) return { a: stripPrefix(rest.slice(0, bq)), b: stripPrefix(rest.slice(bq + 1)) };
  // Unquoted: when a and b are the same path, the line is "a/P b/P", so split in the middle.
  const half = (rest.length - 1) / 2;
  if (Number.isInteger(half) && rest[half] === ' ') {
    const a = rest.slice(0, half);
    const b = rest.slice(half + 1);
    if (a.slice(2) === b.slice(2)) return { a: stripPrefix(a), b: stripPrefix(b) };
  }
  const idx = rest.lastIndexOf(' b/');
  if (idx >= 0) return { a: stripPrefix(rest.slice(0, idx)), b: stripPrefix(rest.slice(idx + 1)) };
  return {};
}

function findQuoteEnd(s: string, start: number): number {
  for (let i = start + 1; i < s.length; i++) {
    if (s[i] === '\\') {
      i++;
      continue;
    }
    if (s[i] === '"') return i;
  }
  return s.length - 1;
}

interface Building {
  oldPath?: string;
  newPath?: string;
  status: FileDiff['status'];
  binary: boolean;
  additions: number;
  deletions: number;
  patchLines: string[];
  gitPaths: { a?: string; b?: string };
  sawHeaders: boolean;
}

/** Parse a whole `git diff` output into protocol `FileDiff`s. `patch` holds the hunks (from the first `@@`). */
export function parseUnifiedDiff(text: string): FileDiff[] {
  const lines = text.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const out: FileDiff[] = [];
  let cur: Building | undefined;
  let oldLeft = 0;
  let newLeft = 0;

  const finish = () => {
    if (!cur) return;
    const newPath = cur.newPath ?? (cur.status === 'deleted' ? undefined : cur.gitPaths.b);
    const oldPath = cur.oldPath ?? (cur.status === 'added' ? undefined : cur.gitPaths.a);
    const path = newPath ?? oldPath ?? '';
    const fd: FileDiff = {
      path,
      status: cur.status,
      additions: cur.additions,
      deletions: cur.deletions,
      binary: cur.binary,
      patch: cur.patchLines.length ? cur.patchLines.join('\n') + '\n' : '',
    };
    if (cur.status === 'renamed' && oldPath && oldPath !== path) fd.oldPath = oldPath;
    out.push(fd);
    cur = undefined;
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    if (cur && (oldLeft > 0 || newLeft > 0)) {
      // Inside a hunk body.
      const c = raw[0];
      if (c === '+') {
        cur.additions++;
        newLeft--;
      } else if (c === '-') {
        cur.deletions++;
        oldLeft--;
      } else if (c === ' ' || raw === '' || raw === '\r') {
        oldLeft--;
        newLeft--;
      } else if (c === '\\') {
        // "\ No newline at end of file" does not count.
      } else {
        // Malformed / truncated hunk: fall through to header handling.
        oldLeft = 0;
        newLeft = 0;
        i--;
        continue;
      }
      cur.patchLines.push(raw);
      continue;
    }
    const line = raw.replace(/\r$/, '');
    if (line.startsWith('diff --git ')) {
      finish();
      cur = { status: 'modified', binary: false, additions: 0, deletions: 0, patchLines: [], gitPaths: pathsFromDiffGit(line), sawHeaders: false };
      continue;
    }
    if (!cur) {
      // Plain `diff -u` output without a git header.
      if (line.startsWith('--- ') && lines[i + 1]?.startsWith('+++ ')) {
        cur = { status: 'modified', binary: false, additions: 0, deletions: 0, patchLines: [], gitPaths: {}, sawHeaders: false };
      } else continue;
    }
    if (line.startsWith('\\') && cur.patchLines.length) {
      // "\ No newline at end of file" right after the last line of a hunk.
      cur.patchLines.push(raw);
      continue;
    }
    const m = HUNK_RE.exec(line);
    if (m) {
      oldLeft = m[2] === undefined ? 1 : Number(m[2]);
      newLeft = m[4] === undefined ? 1 : Number(m[4]);
      cur.patchLines.push(line);
      continue;
    }
    if (line.startsWith('--- ')) {
      const p = headerPath(line, '--- ');
      if (p === undefined) cur.status = 'added';
      else cur.oldPath ??= p;
      cur.sawHeaders = true;
    } else if (line.startsWith('+++ ')) {
      const p = headerPath(line, '+++ ');
      if (p === undefined) cur.status = 'deleted';
      else cur.newPath = p;
      cur.sawHeaders = true;
    } else if (line.startsWith('new file mode')) cur.status = 'added';
    else if (line.startsWith('deleted file mode')) cur.status = 'deleted';
    else if (line.startsWith('rename from ')) {
      cur.status = 'renamed';
      cur.oldPath = unquoteGitPath(line.slice('rename from '.length));
    } else if (line.startsWith('rename to ')) {
      cur.status = 'renamed';
      cur.newPath = unquoteGitPath(line.slice('rename to '.length));
    } else if (line.startsWith('copy from ')) {
      cur.status = 'added';
      cur.oldPath = unquoteGitPath(line.slice('copy from '.length));
    } else if (line.startsWith('copy to ')) {
      cur.status = 'added';
      cur.newPath = unquoteGitPath(line.slice('copy to '.length));
    } else if (line.startsWith('Binary files ') && line.endsWith(' differ')) {
      cur.binary = true;
      const bm = /^Binary files (.+) and (.+) differ$/.exec(line);
      if (bm) {
        if (bm[1] === '/dev/null') cur.status = 'added';
        if (bm[2] === '/dev/null') cur.status = 'deleted';
      }
    } else if (line === 'GIT binary patch') {
      cur.binary = true;
      // Skip the base85 payload up to the next file header.
      while (i + 1 < lines.length && !lines[i + 1]!.startsWith('diff --git ')) i++;
    }
    // index, similarity index, old mode, new mode: ignored.
  }
  finish();
  return out;
}

/** Parse the hunks of one file's patch (the `patch` field of a `FileDiff`). */
export function parseHunks(patch: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let h: DiffHunk | undefined;
  let oldNo = 0;
  let newNo = 0;
  const lines = patch.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  for (const raw of lines) {
    const m = HUNK_RE.exec(raw.replace(/\r$/, ''));
    if (m) {
      h = { oldStart: Number(m[1]), oldLines: m[2] === undefined ? 1 : Number(m[2]), newStart: Number(m[3]), newLines: m[4] === undefined ? 1 : Number(m[4]), section: m[5] ?? '', lines: [] };
      hunks.push(h);
      oldNo = h.oldStart;
      newNo = h.newStart;
      continue;
    }
    if (!h) continue;
    const c = raw[0];
    const text = raw.slice(1);
    if (c === '+') h.lines.push({ kind: 'add', text, newLine: newNo++ });
    else if (c === '-') h.lines.push({ kind: 'del', text, oldLine: oldNo++ });
    else if (c === '\\') h.lines.push({ kind: 'no-newline', text: raw.slice(2) });
    else h.lines.push({ kind: 'context', text, oldLine: oldNo++, newLine: newNo++ });
  }
  return hunks;
}

/** Build the patch for a new (untracked) text file, in the same shape git uses. */
export function synthesizeAddedPatch(content: string): { patch: string; additions: number } {
  if (content === '') return { patch: '', additions: 0 };
  const endsWithNewline = content.endsWith('\n');
  const body = endsWithNewline ? content.slice(0, -1) : content;
  const lines = body.split('\n');
  const parts = [`@@ -0,0 +1${lines.length === 1 ? '' : ',' + lines.length} @@`, ...lines.map((l) => '+' + l)];
  if (!endsWithNewline) parts.push('\\ No newline at end of file');
  return { patch: parts.join('\n') + '\n', additions: lines.length };
}
