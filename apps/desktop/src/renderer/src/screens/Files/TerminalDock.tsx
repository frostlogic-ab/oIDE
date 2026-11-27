import { useEffect, useRef, type KeyboardEvent, type PointerEvent } from 'react';
import { TerminalTabs } from '../../components/terminal/TerminalTabs';
import { useTerminals } from '../../stores/terminals';

/** The Files terminal group (stores/terminals.ts). */
export const FILES_TERMINALS = 'files';

const MIN_H = 120;
const DEFAULT_H = 260;
const maxHeight = () => Math.max(MIN_H, Math.round((typeof window !== 'undefined' ? window.innerHeight : 800) * 0.7));
const clamp = (h: number) => Math.round(Math.min(maxHeight(), Math.max(MIN_H, h)));

/**
 * Show or hide the Files terminal panel (header button, Ctrl+`). Showing it with no terminal open
 * opens a shell in `cwd`, as VS Code does.
 */
export function toggleFilesTerminal(cwd: string | undefined, context: string | undefined): void {
  const st = useTerminals.getState();
  const g = st.groups[FILES_TERMINALS];
  if (g?.open) st.setPanelOpen(FILES_TERMINALS, false);
  else if (!g?.order.length && cwd) st.openShell(FILES_TERMINALS, cwd, context ? { context } : undefined);
  else st.setPanelOpen(FILES_TERMINALS, true);
}

/**
 * Files › Terminal panel, under the editor: several terminals (shells, and scripts started from
 * Files › Run) with a drag handle on its top edge. Hiding it keeps the terminals running; closing
 * the last tab hides it.
 */
export function TerminalDock({ newCwd, newContext }: { newCwd?: string; newContext?: string }) {
  const g = useTerminals((s) => s.groups[FILES_TERMINALS]);
  const setPanelOpen = useTerminals((s) => s.setPanelOpen);
  const setHeight = useTerminals((s) => s.setHeight);
  const count = g?.order.length ?? 0;
  const prevCount = useRef(count);
  const drag = useRef<{ y: number; h: number } | null>(null);

  useEffect(() => {
    if (prevCount.current > 0 && count === 0) setPanelOpen(FILES_TERMINALS, false);
    prevCount.current = count;
  }, [count, setPanelOpen]);

  if (!g?.open) return null;
  const height = clamp(g.height ?? DEFAULT_H);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drag.current = { y: e.clientY, h: height };
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    setHeight(FILES_TERMINALS, clamp(drag.current.h - (e.clientY - drag.current.y)));
  };
  const onPointerUp = () => {
    drag.current = null;
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 64 : 16;
    const next = e.key === 'ArrowUp' ? height + step : e.key === 'ArrowDown' ? height - step : e.key === 'Home' ? maxHeight() : e.key === 'End' ? MIN_H : null;
    if (next === null) return;
    e.preventDefault();
    setHeight(FILES_TERMINALS, clamp(next));
  };

  return (
    <div className="relative shrink-0 flex flex-col border-t border-line bg-chrome" style={{ height }}>
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize the terminal panel"
        aria-valuenow={height}
        aria-valuemin={MIN_H}
        aria-valuemax={maxHeight()}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={onKeyDown}
        className="absolute -top-[3px] left-0 right-0 h-[6px] z-10 cursor-row-resize outline-none hover:bg-accent/40 focus-visible:bg-accent/60"
      />
      <TerminalTabs group={FILES_TERMINALS} label="Terminals" newCwd={newCwd} newContext={newContext} visible onHide={() => setPanelOpen(FILES_TERMINALS, false)} />
    </div>
  );
}
