/**
 * Pure helpers for the Markdown preview of the Files editor: which files get it, and where a link in
 * a rendered file goes. Paths are relative to the checkout root with `/` separators.
 */
import { parentDir } from './treeOps';

/** How a Markdown tab shows: the rendered page alone, or the source and the page side by side. */
export type MarkdownView = 'preview' | 'edit';

// Not .mdx: the sanitiser would drop its JSX, so MDX opens as source like any other file.
const MARKDOWN_EXT = /\.(md|markdown|mdown|mkd|mkdn)$/i;

/** True for files the editor opens in the Markdown preview by default. */
export const isMarkdownPath = (path: string): boolean => MARKDOWN_EXT.test(path);

export type MarkdownLink =
  /** An https link: the system browser. */
  | { kind: 'external'; url: string }
  /** A heading on the same page (`#install`). */
  | { kind: 'anchor'; id: string }
  /** Another file of the same checkout (`../guide.md`, `/docs/a.md#usage`). */
  | { kind: 'file'; path: string; anchor?: string };

/**
 * Where a link in the rendered `fromPath` points. Relative links resolve against the file's folder,
 * `/`-links against the checkout root; links that climb out of the checkout, and schemes other than
 * https (http, mailto, file, javascript…), go nowhere.
 */
export function resolveMarkdownLink(fromPath: string, href: string): MarkdownLink | null {
  const raw = href.trim();
  if (!raw) return null;
  if (/^https:\/\//i.test(raw)) return { kind: 'external', url: raw };
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('//')) return null;
  if (raw.startsWith('#')) return raw.length > 1 ? { kind: 'anchor', id: safeDecode(raw.slice(1)) } : null;

  const hash = raw.indexOf('#');
  const anchor = hash >= 0 ? safeDecode(raw.slice(hash + 1)) : '';
  const target = safeDecode((hash >= 0 ? raw.slice(0, hash) : raw).replace(/\?.*$/, '')).replace(/\\/g, '/');
  if (!target) return anchor ? { kind: 'anchor', id: anchor } : null;

  const parts = target.startsWith('/') ? [] : parentDir(fromPath).split('/').filter(Boolean);
  for (const seg of target.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(seg);
  }
  if (!parts.length) return null;
  return { kind: 'file', path: parts.join('/'), ...(anchor ? { anchor } : {}) };
}

/** GitHub-style heading slug: lower case, punctuation dropped, spaces to dashes. */
export function headingSlug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
