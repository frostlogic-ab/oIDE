/**
 * Live thumbnail of an artifact for the Artifacts grid cards and the Wall's Artifacts aside: the real
 * design (the same sandboxed, network-less preview frame, scaled down), the rendered doc, or the
 * whiteboard drawing. Decorative (`aria-hidden`, no pointer events, out of the tab order): the card
 * around it is the control and carries the title. Until the card scrolls into view, and for an
 * artifact with nothing to show yet (no files, a running or failed retrieval, a broken import), it
 * shows the `placeholder` (the stylised kind blocks).
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { ArtifactMeta } from '@oide/protocol';
import { cn } from '@oide/ui';
import { invokeOr } from '../../lib/bridge';
import { DesignFrame, MarkdownView } from './Preview';
import { WhiteboardSvg } from './Whiteboard';
import './artifacts.css';

type ThumbMeta = Pick<ArtifactMeta, 'id' | 'kind' | 'title' | 'version' | 'brokenImport' | 'retrieval'>;

/** True once the element has been near the viewport (then stays true: no reload on scroll). */
function useSeen<T extends HTMLElement>(): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T>(null);
  const [seen, setSeen] = useState(() => typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    const el = ref.current;
    if (seen || !el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setSeen(true);
          io.disconnect();
        }
      },
      { rootMargin: '200px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [seen]);
  return [ref, seen];
}

/** Whether a thumbnail can show real content for this artifact. */
export function hasThumbnail(meta: ThumbMeta): boolean {
  const r = meta.retrieval?.status;
  return meta.version > 0 && !meta.brokenImport && r !== 'retrieving' && r !== 'failed';
}

export function ArtifactThumbnail({ meta, placeholder, className }: { meta: ThumbMeta; placeholder: ReactNode; className?: string }) {
  const [ref, seen] = useSeen<HTMLDivElement>();
  const live = seen && hasThumbnail(meta);
  return (
    <div ref={ref} aria-hidden="true" className={cn('relative overflow-hidden pointer-events-none select-none', className)}>
      {!live ? placeholder : meta.kind === 'design' ? <DesignFrame artifactId={meta.id} title={meta.title} html="" scaled noScroll version={meta.version} className="w-full h-full" fallback={placeholder} /> : <ContentThumb meta={meta} placeholder={placeholder} />}
    </div>
  );
}

/** Docs and whiteboards: render the current content (read once per version). */
function ContentThumb({ meta, placeholder }: { meta: ThumbMeta; placeholder: ReactNode }) {
  const [content, setContent] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    invokeOr('artifacts.get', { id: meta.id }, null)
      .then((d) => live && setContent(d?.content ?? null))
      .catch(() => live && setContent(null));
    return () => {
      live = false;
    };
  }, [meta.id, meta.version]);
  if (content === null) return <>{placeholder}</>;
  if (meta.kind === 'doc')
    return (
      <div className="absolute inset-0 bg-raised">
        <MarkdownView source={content} className="oide-md-compact" />
        <div className="oide-md-fade" />
      </div>
    );
  return <WhiteboardSvg json={content} title={meta.title} className="absolute inset-0 w-full h-full" />;
}
