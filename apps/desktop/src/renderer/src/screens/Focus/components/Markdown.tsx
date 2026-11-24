import { memo, type MouseEvent } from 'react';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { invokeOr } from '../../../lib/bridge';

/**
 * Assistant markdown: `marked` (GFM) → DOMPurify → innerHTML. Never injects unsanitized HTML.
 * Results are cached by text (assistant blocks never change once complete). Link clicks never
 * navigate the window: https links open in the system browser through `shell.openExternal`.
 */
const cache = new Map<string, string>();
const MAX_CACHE = 800;

const PURIFY = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: ['style', 'iframe', 'form', 'input', 'button', 'textarea', 'select', 'img', 'video', 'audio', 'object', 'embed'],
  FORBID_ATTR: ['style', 'srcset'],
};

export function renderMarkdown(text: string): string {
  const hit = cache.get(text);
  if (hit !== undefined) return hit;
  const raw = marked.parse(text, { gfm: true, breaks: false, async: false }) as string;
  const html = DOMPurify.sanitize(raw, PURIFY) as unknown as string;
  if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value as string);
  cache.set(text, html);
  return html;
}

function onLinkClick(e: MouseEvent<HTMLDivElement>) {
  const a = (e.target as HTMLElement).closest('a');
  if (!a) return;
  e.preventDefault();
  const href = a.getAttribute('href') ?? '';
  if (/^https:\/\//i.test(href)) void invokeOr('shell.openExternal', { url: href }, { ok: true as const }).catch(() => {});
}

export const Markdown = memo(function Markdown({ text, className }: { text: string; className?: string }) {
  return <div className={`oide-md ${className ?? ''}`} onClick={onLinkClick} dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />;
});
