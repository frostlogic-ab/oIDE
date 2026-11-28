/**
 * A small, read-only picture of a board (grid thumbnails and the detail pane's preview): its columns
 * with their colours and counts, and the first cards of each. Decorative where the caller says so.
 */
import { useMemo } from 'react';
import { parseBoard, type KanbanBoard } from '@oide/protocol';
import { cn } from '@oide/ui';
import { cardsByColumn, cardStyle, chipStyle, laneStyle } from './boardModel';

export function BoardMini({ json, title, className, decorative }: { json: string; title: string; className?: string; decorative?: boolean }) {
  const parsed = useMemo((): { board: KanbanBoard } | { error: string } => {
    try {
      return { board: parseBoard(json) };
    } catch (err) {
      return { error: (err as Error).message };
    }
  }, [json]);
  if ('error' in parsed) {
    return <div className={cn('flex items-center justify-center p-4 text-[12px] text-bad', className)}>Can't read this board: {parsed.error}</div>;
  }
  const { board } = parsed;
  const by = cardsByColumn(board);
  return (
    <div
      className={cn('flex gap-1.5 p-2 overflow-hidden bg-ground', className)}
      {...(decorative ? { 'aria-hidden': true } : { role: 'img', 'aria-label': `Board: ${title}, ${board.columns.length} columns, ${board.cards.length} cards` })}
    >
      {board.columns.slice(0, 8).map((col) => {
        const cards = by.get(col.id) ?? [];
        return (
          <div key={col.id} className="flex-1 min-w-0 rounded-md p-1 flex flex-col gap-1" style={laneStyle(col.color)}>
            <span className="self-start max-w-full truncate rounded-[4px] border px-1 text-[9px] leading-[14px] font-semibold" style={chipStyle(col.color)}>
              {col.name} {cards.length}
            </span>
            {cards.slice(0, 5).map((c) => (
              <span key={c.id} className="block rounded-[4px] border border-line-2 px-1 py-[3px] text-[8.5px] leading-[11px] text-ink-2 line-clamp-2" style={cardStyle(col.color)}>
                {c.title}
              </span>
            ))}
          </div>
        );
      })}
    </div>
  );
}
