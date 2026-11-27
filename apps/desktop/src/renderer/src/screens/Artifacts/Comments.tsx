/**
 * Point and comment (Artifacts › open view › Preview): the user turns on Comment, points at a part
 * of the preview and writes what should change there. Each comment becomes a numbered pin
 * (feedbackStore.ts) that the Agent panel's Feedback tray sends to the artifact agent.
 *
 * - Design: the preview is the user's or an agent's page in a sandboxed, opaque-origin frame. Every
 *   HTML page main serves loads a picker script. The screen tells the frame the pick mode and the
 *   pins of its page (`oide-pick-mode`, `oide-pins`); the frame answers with `oide-picked` (selector,
 *   tag, text, page, rect), `oide-pick-cancel` (Esc) and `oide-picker-ready` (each load, so mode and
 *   pins are sent again). A message counts only when it comes from that frame's window and parses
 *   with `PreviewPickerMessage`; its text only ever fills a note the user writes and chooses to send.
 *   The srcdoc fallback (past versions, the dev mock without a URL) runs no scripts: no picker.
 * - Doc: the rendered Markdown is in the renderer's own DOM, so a click on a block picks it directly
 *   (its text and the nearest heading above); markers are drawn on the picked blocks.
 */
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from 'react';
import { PreviewPickerMessage, type ArtifactMeta, type PreviewPicked } from '@oide/protocol';
import { Button, cn } from '@oide/ui';
import { useKeymapScope } from '../../lib/useKeymap';
import { useArtifactFeedback, usePins } from './feedbackStore';
import { DesignFrame, MarkdownView, type DesignSource } from './Preview';
import { pinWhere, snippet, type FeedbackPin } from './model';

/** Speech-bubble stroke icon (same style as @oide/ui icons: viewBox 24, stroke 1.7). */
export function CommentIcon({ size = 14, className }: { size?: number; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" focusable="false" className={cn('ico shrink-0', className)} fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 15a2 2 0 0 1-2 2H8l-4 4V5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2z" />
      <path d="M8 8.5h8M8 12h5" />
    </svg>
  );
}

/** The preview toolbar's Comment toggle (icon and text, aria-pressed). */
export function CommentToggle({ on, onChange, disabledReason }: { on: boolean; onChange: (on: boolean) => void; disabledReason?: string }) {
  const hintId = useId();
  return (
    <>
      <button
        type="button"
        aria-pressed={on}
        aria-describedby={disabledReason ? hintId : undefined}
        disabled={!!disabledReason}
        title={disabledReason ?? (on ? 'Stop commenting (Esc)' : 'Point at the preview and say what should change')}
        onClick={() => onChange(!on)}
        className={cn(
          'h-7 px-2.5 rounded-md border text-[12px] flex items-center gap-1.5 shrink-0 disabled:opacity-50',
          on ? 'border-accent bg-selected text-ink' : 'border-line-3 bg-transparent text-ink-2 hover:bg-raised',
        )}
      >
        <CommentIcon />
        Comment
      </button>
      {disabledReason && (
        <span id={hintId} className="sr-only">
          {disabledReason}
        </span>
      )}
    </>
  );
}

const FORM_W = 300;
const FORM_H = 168;

/** "What should change here?": a small form at the picked point. Esc or Cancel closes it. */
export function CommentForm({ where, quote, style, onAdd, onCancel }: { where: string; quote: string; style: CSSProperties; onAdd: (comment: string) => void; onCancel: () => void }) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  const id = useId();
  useEffect(() => ref.current?.focus(), []);
  const add = () => text.trim() && onAdd(text.trim());
  return (
    <div
      role="dialog"
      aria-label="Comment on the preview"
      aria-describedby={`${id}-where`}
      style={{ width: FORM_W, ...style }}
      className="absolute z-30 flex flex-col gap-2 p-3 rounded-[10px] border border-line-3 bg-card shadow-dialog text-[12.5px]"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          onCancel();
        } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          add();
        }
      }}
    >
      <div id={`${id}-where`} className="flex flex-col gap-0.5 min-w-0">
        <span className="font-mono text-[11.5px] text-ink-3 truncate" title={where}>
          {where}
        </span>
        {quote && <span className="text-ink-2 truncate">&ldquo;{quote}&rdquo;</span>}
      </div>
      <label htmlFor={`${id}-text`} className="text-ink-2 text-[12px]">
        What should change here?
      </label>
      <textarea
        ref={ref}
        id={`${id}-text`}
        rows={3}
        maxLength={2000}
        value={text}
        onChange={(e) => setText(e.target.value)}
        className="resize-none rounded-md border border-line-3 bg-chrome text-ink text-[12.5px] leading-[1.45] px-2 py-1.5 outline-none focus:border-accent"
      />
      <div className="flex items-center justify-end gap-2">
        <Button size={28} variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button size={28} variant="primary" onClick={add} disabled={!text.trim()}>
          Add
        </Button>
      </div>
    </div>
  );
}

/** Place the form below the picked box (above it when there is no room), inside the preview box. */
function formPosition(box: { w: number; h: number }, target: { x: number; y: number; w: number; h: number }, scrollTop = 0): CSSProperties {
  const left = Math.max(8, Math.min(target.x, box.w - FORM_W - 8));
  const below = target.y + target.h + 6;
  const fitsBelow = below + FORM_H <= scrollTop + box.h;
  const top = fitsBelow || target.y - FORM_H - 6 < scrollTop ? Math.min(below, scrollTop + Math.max(8, box.h - FORM_H - 8)) : target.y - FORM_H - 6;
  return { left, top: Math.max(scrollTop + 8, top) };
}

/** Escape while commenting (focus outside the frame and outside a field) stops commenting, not the Viewer. */
function useStopOnEscape(on: boolean, stop: () => void) {
  useKeymapScope('artifact-commenting', { 'view.back': () => stop() }, { enabled: on });
}

/* ------------------------------------------------------------------ design */

/** The picker draws at most this many markers on a page (main's picker contract). */
const MAX_FRAME_PINS = 100;

export interface DesignCommentPreviewProps {
  meta: ArtifactMeta;
  saved: { version: number; content: string };
  dirty: boolean;
  commenting: boolean;
  onCommenting: (on: boolean) => void;
  /** Whether the frame can take comments (main serves it with the picker), for the toolbar. */
  onPickable: (pickable: boolean) => void;
}

/** The design preview (saved version) with the picker wired in. */
export function DesignCommentPreview({ meta, saved, dirty, commenting, onCommenting, onPickable }: DesignCommentPreviewProps) {
  const frame = useRef<HTMLIFrameElement | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const pins = usePins(meta.id);
  const [page, setPage] = useState('');
  const [picked, setPicked] = useState<PreviewPicked | null>(null);
  const [source, setSource] = useState<DesignSource>('loading');
  const pickable = source === 'url';
  useEffect(() => onPickable(pickable), [pickable, onPickable]);
  useStopOnEscape(commenting, () => onCommenting(false));

  const live = useRef({ commenting, pins, page });
  live.current = { commenting, pins, page };

  const post = useCallback((msg: unknown) => {
    // The frame is an opaque origin: '*' is the only target origin it matches. What goes in is
    // only the pick mode and marker numbers with the selectors the frame itself reported.
    frame.current?.contentWindow?.postMessage(msg, '*');
  }, []);
  const pagePins = useCallback((list: readonly FeedbackPin[], p: string) => list.filter((x) => x.selector && (x.page ?? '') === p).slice(0, MAX_FRAME_PINS).map((x) => ({ n: x.n, selector: x.selector!.slice(0, 500) })), []);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const win = frame.current?.contentWindow;
      if (!win || e.source !== win) return;
      const parsed = PreviewPickerMessage.safeParse(e.data);
      if (!parsed.success) return;
      const m = parsed.data;
      if (m.type === 'oide-picker-ready') {
        setPage(m.page);
        post({ type: 'oide-pick-mode', on: live.current.commenting });
        post({ type: 'oide-pins', pins: pagePins(live.current.pins, m.page) });
      } else if (m.type === 'oide-pick-cancel') {
        setPicked(null);
        onCommenting(false);
      } else if (live.current.commenting) {
        setPage(m.page);
        setPicked(m);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [post, pagePins, onCommenting]);

  useEffect(() => {
    if (!pickable) return;
    post({ type: 'oide-pick-mode', on: commenting });
    if (!commenting) setPicked(null);
  }, [commenting, pickable, post]);
  useEffect(() => {
    if (pickable) post({ type: 'oide-pins', pins: pagePins(pins, page) });
  }, [pins, page, pickable, post, pagePins]);

  const formStyle = (): CSSProperties => {
    const el = box.current;
    if (!el || !picked) return { left: 8, top: 8 };
    const w = el.clientWidth || picked.viewport.w;
    const h = el.clientHeight || picked.viewport.h;
    const sx = w / picked.viewport.w;
    const sy = h / picked.viewport.h;
    return formPosition({ w, h }, { x: picked.rect.x * sx, y: picked.rect.y * sy, w: picked.rect.w * sx, h: picked.rect.h * sy });
  };

  const where = picked ? pinWhere({ page: picked.page || meta.entry, selector: picked.selector, tag: picked.tag }) : '';
  return (
    <div className="flex-1 min-w-0 min-h-0 flex flex-col gap-1.5">
      <div ref={box} className={cn('relative flex-1 min-h-0 rounded-xl border bg-raised overflow-hidden', commenting && pickable ? 'border-accent' : 'border-line-2')}>
        <DesignFrame artifactId={meta.id} title={meta.title} html={saved.content} version={saved.version} className="w-full h-full" frameRef={frame} onSource={setSource} />
        {picked && (
          <CommentForm
            key={`${picked.selector}#${picked.rect.x},${picked.rect.y}`}
            where={where}
            quote={snippet(picked.text, 80)}
            style={formStyle()}
            onCancel={() => setPicked(null)}
            onAdd={(comment) => {
              useArtifactFeedback.getState().add(meta.id, { page: picked.page || meta.entry, selector: picked.selector, tag: picked.tag, text: snippet(picked.text, 300), comment });
              setPicked(null);
            }}
          />
        )}
      </div>
      <span className="text-[11.5px] text-ink-3" aria-live="polite">
        {commenting && pickable
          ? 'Click a part of the page to comment on it. Esc stops.'
          : dirty
            ? `Showing v${saved.version}. Save to refresh the preview.`
            : `v${saved.version}, sandboxed: no network, no access to oIDE.`}
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------ doc */

const BLOCKS = 'h1,h2,h3,h4,h5,h6,p,li,pre,blockquote,table,img';
const HEADING = /^H[1-6]$/;
const BLOCK_LABEL: Record<string, string> = { P: 'paragraph', LI: 'list item', PRE: 'code block', BLOCKQUOTE: 'quote', TABLE: 'table', IMG: 'image' };

interface DocPick {
  blockIndex: number;
  block: string;
  heading?: string;
  text: string;
  /** Where the form goes, in the scroll content's coordinates. */
  at: { x: number; y: number; w: number; h: number };
}

/** The block under a click in the rendered doc, its text and the nearest heading above (exported for tests). */
export function pickDocBlock(root: HTMLElement, target: EventTarget | null): Omit<DocPick, 'at'> & { el: HTMLElement } | null {
  if (!(target instanceof Element)) return null;
  const el = target.closest(BLOCKS);
  if (!(el instanceof HTMLElement) || !root.contains(el)) return null;
  const blocks = Array.from(root.querySelectorAll<HTMLElement>(BLOCKS));
  const blockIndex = blocks.indexOf(el);
  if (blockIndex < 0) return null;
  const isHeading = HEADING.test(el.tagName);
  let heading: string | undefined;
  for (let i = blockIndex; i >= 0; i--) {
    const b = blocks[i]!;
    if (HEADING.test(b.tagName)) {
      heading = snippet(b.textContent ?? '', 120);
      break;
    }
  }
  const raw = el.tagName === 'IMG' ? (el.getAttribute('alt') ?? '') : (el.textContent ?? '');
  return { el, blockIndex, block: isHeading ? 'heading' : (BLOCK_LABEL[el.tagName] ?? 'block'), ...(heading ? { heading } : {}), text: snippet(raw, 300) };
}

export interface DocCommentPreviewProps {
  meta: ArtifactMeta;
  /** The text shown (the live draft). */
  source: string;
  commenting: boolean;
  onCommenting: (on: boolean) => void;
}

/** The rendered doc (live draft) with click-to-pick and markers on the picked blocks. */
export function DocCommentPreview({ meta, source, commenting, onCommenting }: DocCommentPreviewProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const view = useRef<HTMLDivElement>(null);
  const pins = usePins(meta.id);
  const [pick, setPick] = useState<DocPick | null>(null);
  useStopOnEscape(commenting, () => onCommenting(false));
  useEffect(() => {
    if (!commenting) setPick(null);
  }, [commenting]);

  // Markers: a numbered badge on each picked block (CSS draws it from data-oide-pin). The HTML is
  // React's dangerouslySetInnerHTML, which React never reconciles, so marking it here is safe.
  useLayoutEffect(() => {
    const root = view.current;
    if (!root) return;
    for (const el of Array.from(root.querySelectorAll('[data-oide-pin]'))) el.removeAttribute('data-oide-pin');
    const blocks = root.querySelectorAll<HTMLElement>(BLOCKS);
    const byBlock = new Map<number, number[]>();
    for (const p of pins) if (p.blockIndex !== undefined) byBlock.set(p.blockIndex, [...(byBlock.get(p.blockIndex) ?? []), p.n]);
    for (const [i, ns] of byBlock) blocks[i]?.setAttribute('data-oide-pin', ns.join(', '));
  });

  const onClickCapture = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (!commenting || !view.current) return;
    // Commenting: a click picks; it never follows a link.
    e.preventDefault();
    e.stopPropagation();
    const hit = pickDocBlock(view.current, e.target);
    if (!hit) return;
    const s = scroller.current;
    const r = hit.el.getBoundingClientRect();
    const sr = s?.getBoundingClientRect();
    const at = { x: r.left - (sr?.left ?? 0), y: r.top - (sr?.top ?? 0) + (s?.scrollTop ?? 0), w: r.width, h: r.height };
    const { el: _el, ...rest } = hit;
    setPick({ ...rest, at });
  };

  const formStyle = (): CSSProperties => {
    const s = scroller.current;
    if (!pick) return { left: 8, top: 8 };
    return formPosition({ w: s?.clientWidth || 600, h: s?.clientHeight || 400 }, pick.at, s?.scrollTop ?? 0);
  };

  return (
    <div className="flex-1 min-w-0 min-h-0 flex flex-col gap-1.5">
      <div
        ref={scroller}
        className={cn('relative flex-1 min-h-0 rounded-xl border bg-raised overflow-auto', commenting ? 'border-accent' : 'border-line-2')}
        aria-label={`Preview of ${meta.title}`}
        role="region"
      >
        <MarkdownView source={source} viewRef={view} onClickCapture={onClickCapture} className={cn('oide-md-pins', commenting && 'oide-md-picking')} />
        {pick && (
          <CommentForm
            key={`${pick.blockIndex}`}
            where={pinWhere({ heading: pick.heading, block: pick.block })}
            quote={snippet(pick.text, 80)}
            style={formStyle()}
            onCancel={() => setPick(null)}
            onAdd={(comment) => {
              useArtifactFeedback.getState().add(meta.id, { heading: pick.heading, block: pick.block, blockIndex: pick.blockIndex, text: pick.text, comment });
              setPick(null);
            }}
          />
        )}
      </div>
      {commenting && (
        <span className="text-[11.5px] text-ink-3" aria-live="polite">
          Click a paragraph, heading or list item to comment on it. Esc stops.
        </span>
      )}
    </div>
  );
}
