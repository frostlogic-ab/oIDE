import { useEffect, useId, useRef, useState, type ComponentPropsWithoutRef, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import { cn } from '@oide/ui';
import { clampPanelWidth, dragPanelWidth, keyPanelWidth, type PanelSpec } from '../lib/panels';
import { useSettings } from '../stores/settings';

/** A sidebar never takes more than this share of the window, whatever its own max. */
const VIEWPORT_SHARE = 0.5;
/** Keyboard resizing saves once the keys stop for this long. */
const KEY_SAVE_DELAY = 400;
/** Class on <html> while a handle is dragged: col-resize cursor everywhere, no text selection. */
export const RESIZING_CLASS = 'oide-resizing';

function viewportLimit(spec: PanelSpec, width: number): number {
  if (typeof window === 'undefined' || !window.innerWidth) return width;
  return clampPanelWidth(spec, Math.min(width, Math.max(spec.min, Math.floor(window.innerWidth * VIEWPORT_SHARE))));
}

/** Save one panel's width (null = back to the default). Failures keep the width for this session. */
async function savePanelWidth(id: string, width: number | null): Promise<boolean> {
  try {
    await useSettings.getState().update({ ui: { panelWidths: { [id]: width } } });
    return true;
  } catch {
    return false;
  }
}

export interface PanelWidth {
  spec: PanelSpec;
  /** The width to render, already clamped. */
  width: number;
  dragging: boolean;
  onPointerDown(e: PointerEvent<HTMLElement>): void;
  onPointerMove(e: PointerEvent<HTMLElement>): void;
  onPointerUp(e: PointerEvent<HTMLElement>): void;
  onPointerCancel(e: PointerEvent<HTMLElement>): void;
  onKeyDown(e: KeyboardEvent<HTMLElement>): void;
  /** Back to the panel's default width (double-click on the handle). */
  reset(): void;
}

/**
 * The width of a resizable sidebar: the user's saved width (`settings.ui.panelWidths[id]`), or the
 * live width while the handle is dragged or keyed. Saved when the drag ends.
 */
export function usePanelWidth(spec: PanelSpec): PanelWidth {
  const stored = useSettings((st) => {
    const v = st.settings?.ui.panelWidths?.[spec.id];
    return typeof v === 'number' ? v : undefined;
  });
  const [live, setLive] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const width = clampPanelWidth(spec, live ?? stored);
  const drag = useRef<{ pointerId: number; startX: number; startWidth: number; last: number } | null>(null);
  const saveGen = useRef(0);
  const keyTimer = useRef<{ timer: ReturnType<typeof setTimeout>; width: number } | null>(null);

  const save = (w: number | null) => {
    const gen = ++saveGen.current;
    void savePanelWidth(spec.id, w).then((ok) => {
      // Once saved, the setting is the source of truth again (unless a newer change is under way).
      if (ok && gen === saveGen.current && !drag.current && !keyTimer.current) setLive(null);
    });
  };

  // A drag shows the resize cursor everywhere and stops text selection; Escape puts the width back.
  useEffect(() => {
    if (!dragging) return;
    const root = document.documentElement;
    root.classList.add(RESIZING_CLASS);
    const onKey = (e: globalThis.KeyboardEvent) => {
      const d = drag.current;
      if (e.key !== 'Escape' || !d) return;
      e.preventDefault();
      e.stopPropagation();
      drag.current = null;
      setDragging(false);
      setLive(d.startWidth);
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      root.classList.remove(RESIZING_CLASS);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [dragging]);

  // Leaving the screen mid-keyboard-resize still saves the width.
  useEffect(
    () => () => {
      const k = keyTimer.current;
      if (!k) return;
      clearTimeout(k.timer);
      keyTimer.current = null;
      void savePanelWidth(spec.id, k.width);
    },
    [spec.id],
  );

  const endDrag = (e: PointerEvent<HTMLElement>, commit: boolean) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointerId) return;
    drag.current = null;
    setDragging(false);
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    if (!commit) setLive(d.startWidth);
    else if (d.last !== d.startWidth) save(d.last);
  };

  return {
    spec,
    width,
    dragging,
    onPointerDown: (e) => {
      if (e.button !== 0 || drag.current) return;
      e.preventDefault();
      e.currentTarget.focus({ preventScroll: true });
      e.currentTarget.setPointerCapture?.(e.pointerId);
      drag.current = { pointerId: e.pointerId, startX: e.clientX, startWidth: width, last: width };
      setDragging(true);
    },
    onPointerMove: (e) => {
      const d = drag.current;
      if (!d || e.pointerId !== d.pointerId) return;
      const next = viewportLimit(spec, dragPanelWidth(spec, d.startWidth, e.clientX - d.startX));
      if (next === d.last) return;
      d.last = next;
      setLive(next);
    },
    onPointerUp: (e) => endDrag(e, true),
    onPointerCancel: (e) => endDrag(e, false),
    onKeyDown: (e) => {
      if (drag.current || e.altKey || e.ctrlKey || e.metaKey) return;
      const next = keyPanelWidth(spec, width, e.key, e.shiftKey);
      if (next === null) return;
      e.preventDefault();
      e.stopPropagation();
      const w = viewportLimit(spec, next);
      setLive(w);
      if (keyTimer.current) clearTimeout(keyTimer.current.timer);
      keyTimer.current = {
        width: w,
        timer: setTimeout(() => {
          keyTimer.current = null;
          save(w);
        }, KEY_SAVE_DELAY),
      };
    },
    reset: () => {
      if (keyTimer.current) clearTimeout(keyTimer.current.timer);
      keyTimer.current = null;
      setLive(spec.defaultWidth);
      save(null);
    },
  };
}

/**
 * The grab edge of a resizable sidebar: a focusable vertical separator sitting on the sidebar's
 * border (zero layout width, a 7px hit area). Drag to resize, arrows / Home / End from the keyboard,
 * double-click to restore the default width.
 */
export function ResizeHandle({ panel, controls, className }: { panel: PanelWidth; controls?: string; className?: string }) {
  const { spec, width, dragging } = panel;
  const grows = spec.side === 'left' ? 'right' : 'left';
  return (
    <div
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label={`Resize the ${spec.label}`}
      aria-controls={controls}
      aria-valuenow={width}
      aria-valuemin={spec.min}
      aria-valuemax={spec.max}
      aria-valuetext={`${width} pixels wide`}
      title={`Drag to resize the ${spec.label} (arrow ${grows} widens it). Double-click to reset.`}
      data-panel={spec.id}
      onPointerDown={panel.onPointerDown}
      onPointerMove={panel.onPointerMove}
      onPointerUp={panel.onPointerUp}
      onPointerCancel={panel.onPointerCancel}
      onKeyDown={panel.onKeyDown}
      onDoubleClick={panel.reset}
      className={cn('group relative z-20 w-0 shrink-0 self-stretch outline-none touch-none', className)}
    >
      <span aria-hidden className="absolute inset-y-0 -left-[3px] w-[7px] cursor-col-resize" />
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
 * `settings.ui.panelWidths` and comes back after a restart. It may shrink to `min` when the window
 * is too narrow for everything, and never takes more than half the window.
 */
export function ResizableAside({ panel: spec, style, handleClassName, id, children, ...rest }: AsideProps) {
  const panel = usePanelWidth(spec);
  const autoId = useId();
  const asideId = id ?? `panel-${autoId}`;
  const aside = (
    <aside
      {...rest}
      id={asideId}
      data-panel={spec.id}
      style={{ ...style, flex: `0 1 ${panel.width}px`, width: panel.width, minWidth: spec.min, maxWidth: `${VIEWPORT_SHARE * 100}vw` }}
    >
      {children}
    </aside>
  );
  const handle = <ResizeHandle panel={panel} controls={asideId} className={handleClassName} />;
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
