import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Icon, Spinner } from '@oide/ui';
import { RowView, type RowContext, type ViewRow } from './rows';

/**
 * Virtualized transcript (@tanstack/react-virtual, measured rows). Sticks to the bottom while the
 * user is there; scrolling up pauses it and shows "Jump to latest". Reaching the top asks for the
 * previous page (`onLoadOlder`) and keeps the scroll position when it lands.
 */
export interface TranscriptProps {
  rows: ViewRow[];
  ctx: RowContext;
  /** Changing it (another agent or subagent) jumps back to the bottom. */
  resetKey: string;
  hasMore: boolean;
  loading: boolean;
  onLoadOlder(): void;
  /** Rendered after the rows (live "Writing…" text). */
  footer?: ReactNode;
  label: string;
}

const ESTIMATE: Partial<Record<ViewRow['kind'], number>> = { user: 64, assistant: 60, tools: 110, subagent: 76, notice: 20, result: 20, thinking: 22, 'sub-intro': 130 };
const STICK_PX = 48;
const TOP_PX = 400;

export function Transcript({ rows, ctx, resetKey, hasMore, loading, onLoadOlder, footer, label }: TranscriptProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const prevFirst = useRef<{ key?: string; height: number }>({ height: 0 });

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => ESTIMATE[rows[i]!.kind] ?? 48,
    getItemKey: (i) => rows[i]!.key,
    overscan: 8,
    // First paint (and jsdom, which has no layout) renders a screenful before the first measure.
    initialRect: { width: 860, height: 900 },
  });

  const toBottom = useCallback(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  // New agent / subagent: start at the bottom again.
  useLayoutEffect(() => {
    stick.current = true;
    setAtBottom(true);
    prevFirst.current = { height: 0 };
    toBottom();
  }, [resetKey, toBottom]);

  // Keep the position when older rows are prepended; follow the tail when stuck.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const first = rows[0]?.key;
    if (prevFirst.current.key && first !== prevFirst.current.key && !stick.current) {
      el.scrollTop += el.scrollHeight - prevFirst.current.height;
    }
    prevFirst.current = { key: first, height: el.scrollHeight };
    if (stick.current) toBottom();
  });

  // Rows measured, diffs expanded, streaming text growing: stay at the bottom when stuck.
  useEffect(() => {
    const el = contentRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (stick.current) toBottom();
      if (scrollRef.current) prevFirst.current.height = scrollRef.current.scrollHeight;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [toBottom]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX;
    stick.current = bottom;
    if (bottom !== atBottom) setAtBottom(bottom);
    prevFirst.current.height = el.scrollHeight;
    if (el.scrollTop < TOP_PX && hasMore && !loading) onLoadOlder();
  };

  const items = virtualizer.getVirtualItems();

  return (
    <div className="relative flex-1 min-h-0 flex flex-col">
      <div ref={scrollRef} onScroll={onScroll} tabIndex={0} role="region" aria-label={label} className="flex-1 min-h-0 overflow-y-auto focus-visible:outline-offset-[-2px]">
        <div ref={contentRef} className="max-w-[860px] w-full mx-auto px-5 pt-[18px] pb-1 box-border">
          {(hasMore || loading) && (
            <div className="flex items-center justify-center gap-2 h-7 mb-2 text-[11.5px] text-ink-3">
              {loading ? (
                <>
                  <Spinner size={12} label="Loading earlier events" /> Loading earlier events…
                </>
              ) : (
                <button type="button" onClick={onLoadOlder} className="border-0 bg-transparent p-0 text-link text-[11.5px] hover:text-link-hover">
                  Load earlier events
                </button>
              )}
            </div>
          )}
          <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
            {items.map((vi) => {
              const row = rows[vi.index]!;
              return (
                <div
                  key={vi.key}
                  data-index={vi.index}
                  ref={virtualizer.measureElement}
                  className="absolute top-0 left-0 w-full pb-3.5"
                  style={{ transform: `translateY(${vi.start}px)` }}
                >
                  <RowView row={row} ctx={ctx} />
                </div>
              );
            })}
          </div>
          {footer}
        </div>
      </div>
      {!atBottom && (
        <button
          type="button"
          onClick={() => {
            stick.current = true;
            setAtBottom(true);
            toBottom();
          }}
          className="absolute bottom-3 left-1/2 -translate-x-1/2 h-7 px-3 flex items-center gap-1.5 rounded-full border border-line-3 bg-card text-ink text-[12px] shadow-dialog hover:bg-raised"
        >
          <Icon name="chevron-down" size={14} />
          Jump to latest
        </button>
      )}
    </div>
  );
}
