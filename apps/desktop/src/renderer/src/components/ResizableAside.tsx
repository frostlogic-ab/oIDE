import { useEffect, useId, useRef, useState, type ComponentPropsWithoutRef, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import { cn } from '@oide/ui';
import { MAIN_MIN_WIDTH, clampPanelWidth, dragPanelWidth, keyPanelWidth, type PanelSpec } from '../lib/panels';
import { useSettings } from '../stores/settings';

/** Keyboard resizing saves once the keys stop for this long. */
const KEY_SAVE_DELAY = 400;
/** Class on <html> while a handle is dragged: col-resize cursor everywhere, no text selection. */
export const RESIZING_CLASS = 'oide-resizing';

/** Save one panel's width (null = back to the default). A failure keeps the width for this session. */
async function savePanelWidth(id: string, width: number | null): Promise<void> {
  try {
    await useSettings.getState().update({ ui: { panelWidths: { [id]: width } } });
  } catch {
    // Settings unavailable (no settings service yet) or refused: the live width stays on screen.
  }
}

/**
 * What a resize starts from: the width the sidebar really renders at (a narrow window may have
 * shrunk it below the saved width) and the widest it may go so the screen's main area keeps
 * `MAIN_MIN_WIDTH` next to the other sidebars. Without layout (tests) it falls back to the panel's
 * own width and max.
 */
function measure(spec: PanelSpec, asideId: string, width: number): { start: number; max: number } {
  const el = typeof document === 'undefined' ? null : document.getElementById(asideId);
  const rendered = el ? Math.round(el.getBoundingClientRect().width) : 0;
  const start = rendered > 0 ? clampPanelWidth(spec, rendered) : width;
  let max = spec.max;
  const parent = el?.parentElement;
  if (el && parent && parent.clientWidth > 0) {
    let others = 0;
    for (const c of Array.from(parent.children)) {
      if (c !== el && c.tagName !== 'MAIN') others += c.getBoundingClientRect().width;
    }
    max = Math.min(spec.max, Math.max(spec.min, Math.floor(parent.clientWidth - others - MAIN_MIN_WIDTH)));
  }
  return { start: Math.min(start, Math.max(max, spec.min)), max };
}

/** A width set by dragging or keys, tied to the saved width it overrode: a new saved width wins. */
interface LiveWidth {
  width: number;
  over: number | undefined;
}

interface Drag {
  pointerId: number;
  startX: number;
  startWidth: number;
  max: number;
  last: number;
  /** The live width before the drag, put back by Escape. */
  before: LiveWidth | null;
}

export interface PanelWidth {
  spec: PanelSpec;
  asideId: string;
  /** The width to render, already clamped. */
  width: number;
  dragging: boolean;
  onPointerDown(e: PointerEvent<HTMLElement>): void;
  onPointerMove(e: PointerEvent<HTMLElement>): void;
  onPointerUp(e: PointerEvent<HTMLElement>): void;
  onPointerCancel(e: PointerEvent<HTMLElement>): void;
  onLostPointerCapture(e: PointerEvent<HTMLElement>): void;
  onKeyDown(e: KeyboardEvent<HTMLElement>): void;
  /** Back to the panel's default width (double-click on the handle). */
  reset(): void;
}

/**
 * The width of a resizable sidebar: the user's saved width (`settings.ui.panelWidths[id]`), or the
 * live width while it is dragged or keyed and until that is saved. Saved when the drag ends; any
 * new saved width (this save, or Settings › Reset sidebar widths) replaces the live one.
 */
export function usePanelWidth(spec: PanelSpec, asideId: string): PanelWidth {
  const stored = useSettings((st) => {
    const v = st.settings?.ui.panelWidths?.[spec.id];
    return typeof v === 'number' ? v : undefined;
  });
  const [live, setLive] = useState<LiveWidth | null>(null);
  const [dragging, setDragging] = useState(false);
  const current = live && live.over === stored ? live : null;
  const width = clampPanelWidth(spec, current ? current.width : stored);
  const drag = useRef<Drag | null>(null);
  const keyTimer = useRef<{ timer: ReturnType<typeof setTimeout>; width: number } | null>(null);
  const id = spec.id;

  // While dragging: the resize cursor shows everywhere and text is not selected. Escape puts the
  // width back; losing the window (Alt+Tab, a dialog) or the screen ends the drag and keeps it.
  useEffect(() => {
    if (!dragging) return;
    const root = document.documentElement;
    root.classList.add(RESIZING_CLASS);
    const finish = (keep: boolean) => {
      const d = drag.current;
      if (!d) return;
      drag.current = null;
      if (keep && d.last !== d.startWidth) void savePanelWidth(id, d.last);
      return d;
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape' || !drag.current) return;
      e.preventDefault();
      e.stopPropagation();
      const d = finish(false);
      setDragging(false);
      if (d) setLive(d.before);
    };
    const onBlur = () => {
      finish(true);
      setDragging(false);
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', onBlur);
    return () => {
      root.classList.remove(RESIZING_CLASS);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', onBlur);
      // Unmounted mid-drag (the screen changed): keep what the user dragged to.
      finish(true);
    };
  }, [dragging, id]);

  // Leaving the screen mid-keyboard-resize still saves the width.
  useEffect(
    () => () => {
      const k = keyTimer.current;
      if (!k) return;
      clearTimeout(k.timer);
      keyTimer.current = null;
      void savePanelWidth(id, k.width);
    },
    [id],
  );

  const endDrag = (e: PointerEvent<HTMLElement>, keep: boolean) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointerId) return;
    drag.current = null;
    setDragging(false);
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    if (!keep) setLive(d.before);
    else if (d.last !== d.startWidth) void savePanelWidth(id, d.last);
  };

  const cancelKeySave = () => {
    if (keyTimer.current) clearTimeout(keyTimer.current.timer);
    keyTimer.current = null;
  };

  return {
    spec,
    asideId,
    width,
    dragging,
    onPointerDown: (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.currentTarget.focus({ preventScroll: true });
      e.currentTarget.setPointerCapture?.(e.pointerId);
      const { start, max } = measure(spec, asideId, width);
      drag.current = { pointerId: e.pointerId, startX: e.clientX, startWidth: start, max, last: start, before: current };
      setDragging(true);
    },
    onPointerMove: (e) => {
      const d = drag.current;
      if (!d || e.pointerId !== d.pointerId) return;
      const next = Math.min(d.max, dragPanelWidth(spec, d.startWidth, e.clientX - d.startX));
      if (next === d.last) return;
      d.last = next;
      setLive({ width: next, over: stored });
    },
    onPointerUp: (e) => endDrag(e, true),
    onPointerCancel: (e) => endDrag(e, false),
    // Capture can go without a pointerup (the handle hidden mid-drag, the window losing focus).
    onLostPointerCapture: (e) => endDrag(e, true),
    onKeyDown: (e) => {
      if (drag.current || e.altKey || e.ctrlKey || e.metaKey) return;
      const { start, max } = measure(spec, asideId, width);
      const next = keyPanelWidth(spec, start, e.key, e.shiftKey);
      if (next === null) return;
      e.preventDefault();
      e.stopPropagation();
      const w = Math.min(max, next);
      setLive({ width: w, over: stored });
      cancelKeySave();
      keyTimer.current = {
        width: w,
        timer: setTimeout(() => {
          keyTimer.current = null;
          void savePanelWidth(id, w);
        }, KEY_SAVE_DELAY),
      };
    },
    reset: () => {
      cancelKeySave();
      setLive({ width: spec.defaultWidth, over: stored });
      void savePanelWidth(id, null);
    },
  };
}

/**
 * The grab edge of a resizable sidebar: a focusable vertical separator on the sidebar's inner
 * border (zero layout width). Its 6px hit area leans to the side that has no scrollbar. Drag to
 * resize, arrows / Home / End from the keyboard, double-click to restore the default width.
 */
export function ResizeHandle({ panel, className }: { panel: PanelWidth; className?: string }) {
  const { spec, width, dragging } = panel;
  const grows = spec.side === 'left' ? 'right' : 'left';
  return (
    <div
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label={`Resize the ${spec.label}`}
      aria-controls={panel.asideId}
      aria-valuenow={width}
      aria-valuemin={spec.min}
      aria-valuemax={spec.max}
      aria-valuetext={`${width} pixels wide`}
      title={`Drag to resize the ${spec.label} (arrow ${grows} widens it). Double-click to reset.`}
      data-panel-handle={spec.id}
      onPointerDown={panel.onPointerDown}
      onPointerMove={panel.onPointerMove}
      onPointerUp={panel.onPointerUp}
      onPointerCancel={panel.onPointerCancel}
      onLostPointerCapture={panel.onLostPointerCapture}
      onKeyDown={panel.onKeyDown}
      onDoubleClick={panel.reset}
      className={cn('group relative z-20 w-0 shrink-0 self-stretch outline-none touch-none', className)}
    >
      {/* Left sidebars: their own scrollbar is on the left of the edge. Right sidebars: main's is. */}
      <span aria-hidden className="absolute inset-y-0 -left-px w-[6px] cursor-col-resize" />
      <span
        aria-hidden
        className={cn(
          'pointer-events-none absolute inset-y-0 -left-px w-[2px] bg-accent opacity-0 transition-opacity group-hover:opacity-100 group-hover:delay-150 group-focus-visible:opacity-100',
          dragging && 'opacity-100',
        )}
      />
    </div>
  );
}

type AsideProps = Omit<ComponentPropsWithoutRef<'aside'>, 'style'> & {
  panel: PanelSpec;
  style?: CSSProperties;
  /** Extra classes for the handle (e.g. hide it with the sidebar at small widths). */
  handleClassName?: string;
};

/**
 * An `<aside>` sidebar the user can resize by dragging its inner edge. The width is saved to
 * `settings.ui.panelWidths` and comes back after a restart. When the window is too narrow for
 * everything it shrinks (down to `min`) once the main area is at its own minimum.
 */
export function ResizableAside({ panel: spec, style, handleClassName, id, children, ...rest }: AsideProps) {
  const autoId = useId();
  const asideId = id ?? `panel-${autoId}`;
  const panel = usePanelWidth(spec, asideId);
  const aside = (
    <aside {...rest} id={asideId} data-panel={spec.id} style={{ ...style, flex: `0 1 ${panel.width}px`, width: panel.width, minWidth: spec.min }}>
      {children}
    </aside>
  );
  const handle = <ResizeHandle panel={panel} className={handleClassName} />;
  return spec.side === 'left' ? (
    <>
      {aside}
      {handle}
    </>
  ) : (
    <>
      {handle}
      {aside}
    </>
  );
}
