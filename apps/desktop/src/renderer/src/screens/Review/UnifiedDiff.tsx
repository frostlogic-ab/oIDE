import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Button, IconButton } from '@oide/ui';
import type { FileDiff, ReviewComment } from '@oide/protocol';
import { commentLine, displayText, parseHunks, toRows, type DiffLine, type DiffRow } from './diff';

/** Rows above this count are virtualized (only the visible window is in the DOM). */
export const VIRTUALIZE_AFTER = 400;

/** Canvas colours (Review.dc.html): hunk header, context, addition, deletion. */
const ROW_STYLE: Record<DiffLine['kind'] | 'hunk', CSSProperties> = {
  hunk: { color: '#9AA3AE', background: '#131822' },
  context: { color: '#B8BFC9' },
  add: { background: '#12261D', color: '#A8E0C6' },
  del: { background: '#2A1618', color: '#F4B8B8' },
  'no-newline': { color: '#6B7584' },
};

export interface Composer {
  path: string;
  rowKey: string;
  line: number;
  removed: boolean;
}

export interface UnifiedDiffHandle {
  scrollToHunk(index: number): void;
  scrollToLine(line: number): void;
}

export interface UnifiedDiffProps {
  file: FileDiff;
  comments: ReviewComment[];
  composer: Composer | null;
  onOpenComposer(c: Composer): void;
  onCancelComposer(): void;
  onAddComment(body: string): Promise<void> | void;
  onDeleteComment?(id: string): void;
  /** Called with the hunk index nearest the top as the user scrolls. */
  onHunkInView?(index: number): void;
}

/**
 * Custom unified diff from a FileDiff patch: hunk headers, one new-side line-number column (removed
 * lines have none, as on the canvas), add/del colours, click a line to comment on it, existing
 * comment threads inline. Long diffs are virtualized.
 */
export const UnifiedDiff = forwardRef<UnifiedDiffHandle, UnifiedDiffProps>(function UnifiedDiff(
  { file, comments, composer, onOpenComposer, onCancelComposer, onAddComment, onDeleteComment, onHunkInView },
  ref,
) {
  const rows = useMemo(() => toRows(parseHunks(file.patch)), [file.patch]);
  const scroller = useRef<HTMLDivElement>(null);
  const virtual = rows.length > VIRTUALIZE_AFTER;
  const v = useVirtualizer({
    count: virtual ? rows.length : 0,
    getScrollElement: () => scroller.current,
    estimateSize: () => 20,
    overscan: 40,
  });

  const byLine = useMemo(() => {
    const m = new Map<number, ReviewComment[]>();
    for (const c of comments) if (c.line !== undefined) m.set(c.line, [...(m.get(c.line) ?? []), c]);
    return m;
  }, [comments]);
  const fileLevel = comments.filter((c) => c.line === undefined);

  const indexOf = (pred: (r: DiffRow) => boolean) => rows.findIndex(pred);
  const scrollToIndex = (i: number) => {
    if (i < 0) return;
    if (virtual) v.scrollToIndex(i, { align: 'start' });
    else scroller.current?.querySelector<HTMLElement>(`[data-row="${i}"]`)?.scrollIntoView({ block: 'start' });
  };
  useImperativeHandle(ref, () => ({
    scrollToHunk: (h) => scrollToIndex(indexOf((r) => r.type === 'hunk' && r.hunk === h)),
    scrollToLine: (n) => scrollToIndex(indexOf((r) => r.type === 'line' && r.line.newLine === n)),
  }));

  // Report the hunk at the top of the viewport (for hunk navigation).
  useEffect(() => {
    const el = scroller.current;
    if (!el || !onHunkInView) return;
    const onScroll = () => {
      const top = el.getBoundingClientRect().top;
      let current = 0;
      for (const node of el.querySelectorAll<HTMLElement>('[data-hunk-header]')) {
        if (node.getBoundingClientRect().top - top <= 4) current = Number(node.dataset.hunkHeader);
      }
      onHunkInView(current);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [onHunkInView, rows]);

  const renderRow = (row: DiffRow, index: number): ReactNode => {
    if (row.type === 'hunk') {
      return (
        <div className="flex min-h-5" style={ROW_STYLE.hunk} data-hunk-header={row.hunk}>
          <span className="w-11 flex-[0_0_44px]" aria-hidden="true" />
          <span className="flex-1 whitespace-pre pl-2.5">{row.text}</span>
        </div>
      );
    }
    const { line } = row;
    const n = commentLine(line);
    const removed = line.kind === 'del';
    const open = composer?.rowKey === row.key && composer.path === file.path;
    const thread = !removed && line.newLine !== undefined ? byLine.get(line.newLine) : undefined;
    const clickable = n !== undefined && line.kind !== 'no-newline';
    const openComposer = () => clickable && onOpenComposer({ path: file.path, rowKey: row.key, line: n!, removed });
    return (
      <>
        <div
          className={`flex min-h-5 ${clickable ? 'cursor-pointer hover:shadow-[inset_2px_0_0_var(--color-accent)]' : ''}`}
          style={ROW_STYLE[line.kind]}
          data-kind={line.kind}
          onClick={(e) => {
            if (window.getSelection()?.toString()) return; // let people select text
            if ((e.target as HTMLElement).closest('button')) return;
            openComposer();
          }}
        >
          {clickable ? (
            <button
              type="button"
              className="w-11 flex-[0_0_44px] text-right pr-2.5 text-ink-5 select-none bg-transparent border-0 p-0 font-mono text-[12px] leading-5 cursor-pointer focus-visible:outline focus-visible:outline-accent"
              aria-label={removed ? `Comment on removed line ${n}` : `Comment on line ${n}`}
              onClick={openComposer}
            >
              {line.kind === 'del' ? '' : line.newLine}
            </button>
          ) : (
            <span className="w-11 flex-[0_0_44px] text-right pr-2.5 text-ink-5 select-none" />
          )}
          <span className="flex-1 whitespace-pre pl-2.5">{displayText(line)}</span>
        </div>
        {thread?.map((c) => <CommentCard key={c.id} c={c} onDelete={onDeleteComment} />)}
        {open && composer && <CommentComposer key={`${index}:${composer.line}`} composer={composer} onCancel={onCancelComposer} onAdd={onAddComment} />}
      </>
    );
  };

  if (file.binary) return <Notice>Binary file. Open it in the editor to see it.</Notice>;
  if (!rows.length) return <Notice>{file.status === 'renamed' ? `Renamed from ${file.oldPath ?? 'another path'}, no content changes.` : 'No content changes (mode only).'}</Notice>;

  return (
    <div
      ref={scroller}
      className="font-mono flex-1 min-h-0 overflow-auto text-[12px] leading-5 py-2.5"
      role="region"
      aria-label={`Changes in ${file.path}`}
      tabIndex={0}
    >
      {fileLevel.map((c) => (
        <CommentCard key={c.id} c={c} onDelete={onDeleteComment} />
      ))}
      {virtual ? (
        <div style={{ height: v.getTotalSize(), position: 'relative', minWidth: 'max-content', width: '100%' }}>
          {v.getVirtualItems().map((vi) => (
            <div
              key={rows[vi.index]!.key}
              data-index={vi.index}
              data-row={vi.index}
              ref={v.measureElement}
              style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${vi.start}px)` }}
            >
              {renderRow(rows[vi.index]!, vi.index)}
            </div>
          ))}
        </div>
      ) : (
        <div className="min-w-max w-full">
          {rows.map((r, i) => (
            <div key={r.key} data-row={i}>
              {renderRow(r, i)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
});

function Notice({ children }: { children: ReactNode }) {
  return <div className="flex-1 px-5 py-6 text-[12.5px] text-ink-3">{children}</div>;
}

const BOX = 'my-1.5 mr-5 ml-[54px] p-3 border border-line-3 rounded-lg bg-card font-sans text-[13px] flex flex-col gap-2 whitespace-normal';

function CommentComposer({ composer, onCancel, onAdd }: { composer: Composer; onCancel(): void; onAdd(body: string): Promise<void> | void }) {
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const ta = useRef<HTMLTextAreaElement>(null);
  const id = `comment-${composer.rowKey}`;
  useEffect(() => ta.current?.focus(), []);
  const submit = async () => {
    if (!body.trim() || busy) return;
    setBusy(true);
    try {
      await onAdd(body.trim());
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={BOX} onClick={(e) => e.stopPropagation()}>
      <span className="text-[12px] text-ink-3">
        Your comment on {composer.removed ? 'removed line' : 'line'} {composer.line} · goes to the agent
      </span>
      <label htmlFor={id} className="sr-only">
        Comment for the agent
      </label>
      <textarea
        id={id}
        ref={ta}
        rows={2}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            onCancel();
          } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            void submit();
          }
        }}
        className="resize-none px-2.5 py-2 rounded-md border border-line-3 bg-chrome text-ink text-[13px] font-sans leading-normal outline-none focus:border-accent"
      />
      <div className="flex gap-2 justify-end">
        <Button variant="secondary" size={28} onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" size={28} disabled={!body.trim() || busy} onClick={() => void submit()}>
          Add to feedback
        </Button>
      </div>
    </div>
  );
}

function CommentCard({ c, onDelete }: { c: ReviewComment; onDelete?: (id: string) => void }) {
  return (
    <div className={BOX} role="note" aria-label={`Your comment on line ${c.line ?? 'file'}`}>
      <div className="flex items-center gap-2">
        <span className="text-[12px] text-ink-3 flex-1">
          {c.line !== undefined ? `Your comment on line ${c.line}` : 'Your comment on this file'} · {c.sent ? 'sent to the agent' : 'not sent yet'}
        </span>
        {!c.sent && onDelete && <IconButton icon="trash" aria-label="Delete comment" size={28} onClick={() => onDelete(c.id)} />}
      </div>
      <span className="text-ink-2 leading-normal whitespace-pre-wrap">{c.body}</span>
    </div>
  );
}
