import { replacementFor, stickyRegExp, type ContentMatch, type SearchOptions } from '@oide/protocol';

/** A piece of a preview line: plain, a match (`hit`) or its replacement (`added`). */
export interface Seg {
  text: string;
  hit?: boolean;
  added?: boolean;
}

/** What a match turns into (null when it cannot be computed from the preview alone). */
export function replacedText(m: ContentMatch, o: SearchOptions, replacement: string): string | null {
  if (!o.isRegex) return replacement;
  return replacementFor(m.preview, { column: m.column - m.previewStart, text: m.text }, o, replacement, stickyRegExp(o));
}

/** One result row: the preview around a match, the match marked; with a replacement, old and new inline. */
export function matchSegments(m: ContentMatch, o?: SearchOptions, replacement?: string): Seg[] {
  const at = m.column - m.previewStart;
  const before = m.preview.slice(0, at).replace(/^\s+/, '');
  const after = m.preview.slice(at + m.length);
  const segs: Seg[] = [{ text: (m.previewStart > 0 ? '…' : '') + before }, { text: m.preview.slice(at, at + m.length), hit: true }];
  if (o && replacement !== undefined) {
    const next = replacedText(m, o, replacement);
    if (next !== null && next !== '') segs.push({ text: next, added: true });
  }
  segs.push({ text: after });
  return segs.filter((s) => s.text !== '' || s.hit);
}

export interface LineDiff {
  line: number;
  old: Seg[];
  next: Seg[];
  /** Matches on this line that the preview covers. */
  count: number;
}

/** Old and new text of each matched line (within the first match's preview window), for the confirm dialog. */
export function lineDiffs(matches: readonly ContentMatch[], o: SearchOptions, replacement: string): LineDiff[] {
  const byLine = new Map<number, ContentMatch[]>();
  for (const m of matches) byLine.set(m.line, [...(byLine.get(m.line) ?? []), m]);
  const out: LineDiff[] = [];
  for (const [line, list] of [...byLine].sort((a, b) => a[0] - b[0])) {
    const base = list[0]!;
    const start = base.previewStart;
    const end = start + base.preview.length;
    const inside = list.filter((m) => m.column >= start && m.column + m.length <= end).sort((a, b) => a.column - b.column);
    const old: Seg[] = [];
    const next: Seg[] = [];
    let at = 0;
    for (const m of inside) {
      const from = m.column - start;
      if (from < at) continue;
      const plain = base.preview.slice(at, from);
      old.push({ text: plain });
      next.push({ text: plain });
      old.push({ text: m.text, hit: true });
      const rep = o.isRegex
        ? replacementFor(base.preview, { column: from, text: m.text }, o, replacement, stickyRegExp(o))
        : replacement;
      next.push({ text: rep ?? replacement, added: true });
      at = from + m.length;
    }
    const tail = base.preview.slice(at);
    old.push({ text: tail });
    next.push({ text: tail });
    const trim = (segs: Seg[]) => {
      if (segs[0] && !segs[0].hit && !segs[0].added) segs[0] = { text: (start > 0 ? '…' : '') + segs[0].text.replace(/^\s+/, '') };
      return segs.filter((s) => s.text !== '' || s.hit || s.added);
    };
    out.push({ line, old: trim(old), next: trim(next), count: inside.length });
  }
  return out;
}

/** "3 results in 2 files" */
export function resultSummary(matches: number, files: number): string {
  return `${matches} ${matches === 1 ? 'result' : 'results'} in ${files} ${files === 1 ? 'file' : 'files'}`;
}
