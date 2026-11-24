/**
 * Unified-diff model for the Review screen. `FileDiff.patch` (from git.diff) is the hunk text from
 * the first `@@`. Bodies are read by line prefix; numbering follows the hunk headers.
 */

export type DiffLineKind = 'context' | 'add' | 'del' | 'no-newline';

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  oldLine?: number;
  newLine?: number;
}

export interface DiffHunk {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  section: string;
  lines: DiffLine[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

export function parseHunks(patch: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let h: DiffHunk | undefined;
  let oldNo = 0;
  let newNo = 0;
  const lines = patch.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  for (const rawLine of lines) {
    const raw = rawLine.replace(/\r$/, '');
    const m = HUNK_RE.exec(raw);
    if (m) {
      h = {
        header: raw,
        oldStart: Number(m[1]),
        oldLines: m[2] === undefined ? 1 : Number(m[2]),
        newStart: Number(m[3]),
        newLines: m[4] === undefined ? 1 : Number(m[4]),
        section: m[5] ?? '',
        lines: [],
      };
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

/** One rendered row of the unified view. */
export type DiffRow =
  | { type: 'hunk'; key: string; hunk: number; text: string }
  | { type: 'line'; key: string; hunk: number; line: DiffLine };

export function toRows(hunks: DiffHunk[]): DiffRow[] {
  const rows: DiffRow[] = [];
  hunks.forEach((h, i) => {
    rows.push({ type: 'hunk', key: `h${i}`, hunk: i, text: h.header });
    h.lines.forEach((line, j) => rows.push({ type: 'line', key: `h${i}l${j}`, hunk: i, line }));
  });
  return rows;
}

/** The line number a comment refers to: the new-side number, or the old one for removed lines. */
export function commentLine(line: DiffLine): number | undefined {
  return line.kind === 'del' ? line.oldLine : line.newLine;
}

/** Marker + space, as drawn on the canvas ("+ import …", "  const …"). */
export function displayText(line: DiffLine): string {
  if (line.kind === 'no-newline') return `\\ ${line.text}`;
  const mark = line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' ';
  return `${mark} ${line.text}`;
}

/**
 * Rebuild the original file from the modified file and the patch (reverse-apply). Used by the
 * Split view so Monaco can diff whole files. Returns undefined if the patch does not fit.
 */
export function reverseApply(modified: string, hunks: DiffHunk[]): string | undefined {
  const eol = modified.includes('\r\n') ? '\r\n' : '\n';
  const trailing = modified.endsWith('\n');
  const lines = modified.split(/\r?\n/);
  if (trailing) lines.pop();
  const out: string[] = [];
  let cursor = 0; // index into `lines` (0-based new-side)
  for (const h of hunks) {
    const start = Math.max(0, h.newLines === 0 ? h.newStart : h.newStart - 1);
    if (start < cursor || start > lines.length) return undefined;
    out.push(...lines.slice(cursor, start));
    let idx = start;
    for (const l of h.lines) {
      if (l.kind === 'context') {
        if (lines[idx] !== l.text) return undefined;
        out.push(l.text);
        idx++;
      } else if (l.kind === 'add') {
        if (lines[idx] !== l.text) return undefined;
        idx++;
      } else if (l.kind === 'del') out.push(l.text);
    }
    cursor = idx;
  }
  out.push(...lines.slice(cursor));
  return out.join(eol) + (trailing && out.length ? eol : '');
}

/**
 * Fallback for Split when the file cannot be read: both sides built from the hunks alone, padded
 * with blank lines so line numbers match the real file (Monaco then folds the unchanged gaps).
 */
export function sidesFromHunks(hunks: DiffHunk[]): { original: string; modified: string } {
  const o: string[] = [];
  const m: string[] = [];
  for (const h of hunks) {
    while (o.length < h.oldStart - 1) o.push('');
    while (m.length < h.newStart - 1) m.push('');
    for (const l of h.lines) {
      if (l.kind === 'context') {
        o.push(l.text);
        m.push(l.text);
      } else if (l.kind === 'del') o.push(l.text);
      else if (l.kind === 'add') m.push(l.text);
    }
  }
  return { original: o.join('\n'), modified: m.join('\n') };
}

/** Basename without directories. */
export function baseName(path: string): string {
  return path.split('/').pop() ?? path;
}

/** The canvas lists files relative to `src/` ("webhooks/retry.ts"). */
export function listName(path: string): string {
  return path.startsWith('src/') ? path.slice(4) : path;
}
