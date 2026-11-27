/**
 * The rendered page of a Markdown file in the Files editor: `renderMarkdown` (marked + DOMPurify)
 * into a scrolling article. Links never navigate the window: https opens the system browser, `#id`
 * scrolls to the heading, a relative link opens that file of the checkout in a tab.
 */
import { memo, useMemo, type MouseEvent, type Ref } from 'react';
import { invokeOr } from '../../lib/bridge';
import { renderMarkdown } from '../../lib/markdown';
import { headingSlug, resolveMarkdownLink } from './markdownLinks';
import './MarkdownPreview.css';

export interface MarkdownPreviewProps {
  /** Markdown source. */
  source: string;
  /** The file's path in its checkout (relative links resolve against its folder). */
  path: string;
  /** A relative link was clicked: open this checkout-relative path. */
  onOpenFile(path: string): void;
  scrollRef?: Ref<HTMLDivElement>;
  className?: string;
}

export const MarkdownPreview = memo(function MarkdownPreview({ source, path, onOpenFile, scrollRef, className }: MarkdownPreviewProps) {
  // Sanitised by DOMPurify in renderMarkdown.
  const html = useMemo(() => renderMarkdown(source), [source]);

  const onClick = (e: MouseEvent<HTMLElement>) => {
    const a = (e.target as HTMLElement).closest('a');
    if (!a) return;
    e.preventDefault();
    const link = resolveMarkdownLink(path, a.getAttribute('href') ?? '');
    if (!link) return;
    if (link.kind === 'external') void invokeOr('shell.openExternal', { url: link.url }, { ok: true as const }).catch(() => {});
    else if (link.kind === 'file') onOpenFile(link.path);
    else {
      const want = headingSlug(link.id);
      const heading = [...e.currentTarget.querySelectorAll('h1, h2, h3, h4, h5, h6')].find((h) => headingSlug(h.textContent ?? '') === want);
      heading?.scrollIntoView({ block: 'start' });
    }
  };

  return (
    <div ref={scrollRef} className={`min-h-0 overflow-auto bg-ground ${className ?? ''}`} data-testid="markdown-preview">
      <article aria-label={`Preview of ${path.split('/').pop() ?? path}`} className="oide-md-file" onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
});
