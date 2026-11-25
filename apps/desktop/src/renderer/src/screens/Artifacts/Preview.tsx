/**
 * Artifact previews:
 * - design: sandboxed <iframe> on `artifacts.previewUrl` (oide-artifact:// served by main with a
 *   no-network CSP; HTML as is, React through main's generated page and the bundled offline
 *   runtime). `sandbox="allow-scripts"` without `allow-same-origin` keeps it an opaque origin. When
 *   main has no preview URL (dev:web mock, or a past version) HTML goes in via `srcdoc` with an
 *   empty sandbox (no scripts at all); React source never does, a short notice shows instead.
 * - doc: Markdown rendered with `marked`, sanitised with DOMPurify.
 * - whiteboard: read-only SVG render of the Excalidraw JSON (v1; no embedded Excalidraw editor).
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { looksLikeReact, type ArtifactKind } from '@oide/protocol';
import { cn } from '@oide/ui';
import { invokeOr, oide } from '../../lib/bridge';
import { stripFrontMatter } from './model';
import { WhiteboardSvg } from './Whiteboard';

export function renderMarkdown(md: string): string {
  const html = marked.parse(stripFrontMatter(md), { async: false, gfm: true }) as string;
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true }, FORBID_TAGS: ['style', 'form', 'input', 'iframe'], FORBID_ATTR: ['style'] });
}

export function MarkdownView({ source, className }: { source: string; className?: string }) {
  // Sanitised by DOMPurify in renderMarkdown.
  const html = useMemo(() => renderMarkdown(source), [source]);
  return (
    <div
      className={cn('oide-md', className)}
      onClick={(e) => {
        // Links never navigate the app window: https links open in the system browser.
        const a = (e.target as HTMLElement).closest('a');
        if (!a) return;
        e.preventDefault();
        const href = a.getAttribute('href') ?? '';
        if (/^https:\/\//i.test(href)) void oide.invoke('shell.openExternal', { url: href }).catch(() => {});
      }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

/** Width of an element, tracked with ResizeObserver. */
function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.clientWidth);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

interface DesignFrameProps {
  artifactId: string;
  title: string;
  /** HTML used when there is no preview URL (and for past versions). */
  html: string;
  /** Use `html` even when main serves a preview URL (viewing an older version, unsaved edits). */
  forceInline?: boolean;
  /** Render a 1280px-wide page scaled down to the box (thumbnail-style preview). */
  scaled?: boolean;
  /** Bumped after a save so the iframe reloads. */
  version?: number;
  className?: string;
}

export function DesignFrame({ artifactId, title, html, forceInline, scaled, version, className }: DesignFrameProps) {
  const [url, setUrl] = useState<string | null | undefined>(undefined);
  const [ref, width] = useWidth<HTMLDivElement>();

  useEffect(() => {
    if (forceInline) return;
    let live = true;
    setUrl(undefined);
    invokeOr('artifacts.previewUrl', { id: artifactId }, null)
      .then((r) => live && setUrl(r?.url ?? null))
      .catch(() => live && setUrl(null));
    return () => {
      live = false;
    };
  }, [artifactId, forceInline, version]);

  const PAGE = 1280;
  const scale = scaled && width ? width / PAGE : 1;
  const frameStyle = scaled && width ? { width: PAGE, height: `${100 / scale}%`, transform: `scale(${scale})`, transformOrigin: '0 0' } : undefined;
  const common = {
    title: `Preview of ${title}`,
    className: cn('border-0 bg-white block', !scaled && 'w-full h-full'),
    style: frameStyle,
    referrerPolicy: 'no-referrer' as const,
    tabIndex: scaled ? -1 : 0,
  };

  // React needs the runtime that main serves with the saved version: it never goes into srcdoc.
  const inline = forceInline || url === null;
  const react = useMemo(() => inline && looksLikeReact(html), [inline, html]);

  return (
    <div ref={ref} className={cn('relative overflow-hidden', className)}>
      {react ? (
        <ReactNotice text={forceInline ? 'Only the saved version of a React design can be previewed. Save your changes, or use Compare to see older versions.' : 'React designs preview in the desktop app.'} scaled={scaled} />
      ) : inline ? (
        <iframe {...common} sandbox="" srcDoc={html} />
      ) : url ? (
        <iframe key={`${url}#${version ?? 0}`} {...common} sandbox="allow-scripts" src={url} />
      ) : null}
    </div>
  );
}

/** Stands in for a React design's preview where only the saved version can run (past versions). */
function ReactNotice({ text, scaled }: { text: string; scaled?: boolean }) {
  return (
    <div role="note" className={cn('absolute inset-0 flex items-center justify-center bg-raised text-ink-2 text-center', scaled ? 'p-4 text-[12.5px]' : 'p-6 text-[13px]')}>
      {text}
    </div>
  );
}

export interface ArtifactPreviewProps {
  artifactId: string;
  title: string;
  kind: ArtifactKind;
  content: string;
  forceInline?: boolean;
  /** Compact (detail pane) vs full (Open view). */
  compact?: boolean;
  version?: number;
  className?: string;
}

export function ArtifactPreview({ artifactId, title, kind, content, forceInline, compact, version, className }: ArtifactPreviewProps) {
  if (kind === 'design') return <DesignFrame artifactId={artifactId} title={title} html={content} forceInline={forceInline} scaled={compact} version={version} className={cn('w-full h-full', className)} />;
  if (kind === 'doc')
    return (
      <div className={cn('relative w-full h-full overflow-auto', compact && 'overflow-hidden', className)}>
        <MarkdownView source={content} className={compact ? 'oide-md-compact' : undefined} />
        {/* The compact preview is cut at a fixed height: fade the last line out instead of slicing it. */}
        {compact && <div aria-hidden="true" className="oide-md-fade" />}
      </div>
    );
  return <WhiteboardSvg json={content} title={title} className={cn('w-full h-full', className)} />;
}

/** Stylised thumbnails from the design (grid cards): grey blocks per kind, not real content. */
export function KindThumb({ kind }: { kind: ArtifactKind }) {
  if (kind === 'design')
    return (
      <div className="absolute inset-[14px] flex gap-1.5" aria-hidden="true">
        <div className="w-[22%] bg-line-2 rounded-[4px]" />
        <div className="flex-1 grid grid-cols-3 gap-[5px]">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="bg-line-5 rounded-xs" />
          ))}
        </div>
      </div>
    );
  if (kind === 'doc')
    return (
      <div className="absolute inset-x-5 inset-y-4 flex flex-col gap-2" aria-hidden="true">
        <div className="w-[55%] h-[9px] bg-line-3 rounded-xs" />
        {[92, 86, 90, 60].map((w) => (
          <div key={w} className="h-[5px] bg-line-5 rounded-xs" style={{ width: `${w}%` }} />
        ))}
      </div>
    );
  return (
    <div aria-hidden="true">
      <div className="absolute left-[18px] top-[26px] w-[52px] h-[30px] border-[1.5px] border-link rounded-sm" />
      <div className="absolute left-[70px] top-[41px] w-9 h-[1.5px] bg-ink-4" />
      <div className="absolute left-[106px] top-[26px] w-[52px] h-[30px] border-[1.5px] border-ok rounded-[15px]" />
      <div className="absolute left-[60px] top-[74px] w-[60px] h-[26px] bg-warn-line rounded-xs" />
    </div>
  );
}
