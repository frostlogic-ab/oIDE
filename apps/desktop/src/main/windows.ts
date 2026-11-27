import type { Rectangle } from 'electron';

/**
 * Several oIDE windows, one main process (docs/wiki/pages/windows.md). Every window is a full view
 * on the same profile: the same database, projects, agents, settings and extension host, all owned
 * by main. Main → renderer events go to every window; dialogs, OS-notification clicks and
 * extension panels go to the window the user used last.
 */

/** The parts of a BrowserWindow the registry needs (a plain object in tests). */
export interface RegistryWindow {
  isDestroyed(): boolean;
}

/** Open windows, ordered by when the user last focused them (most recent last). */
export class WindowRegistry<W extends RegistryWindow> {
  private order: W[] = [];

  add(win: W): void {
    if (!this.order.includes(win)) this.order.push(win);
  }

  remove(win: W): void {
    this.order = this.order.filter((w) => w !== win);
  }

  /** The user focused `win`: it becomes the active window. */
  focused(win: W): void {
    if (!this.order.includes(win)) return;
    this.order = [...this.order.filter((w) => w !== win), win];
  }

  /** The window the user used last that is still open, or null when none is. */
  active(): W | null {
    for (let i = this.order.length - 1; i >= 0; i--) {
      const w = this.order[i]!;
      if (!w.isDestroyed()) return w;
    }
    return null;
  }

  /** Every open window, least recently focused first. */
  all(): W[] {
    return this.order.filter((w) => !w.isDestroyed());
  }

  get size(): number {
    return this.all().length;
  }
}

/** How far each new window steps down and right from the one it opens from. */
export const CASCADE_STEP = 28;

/**
 * Where a new window goes: one step down and right from `from` (the active window's normal bounds),
 * back to the top-left of the work area when that would push it off the display `from` is on.
 */
export function cascadePosition(from: Rectangle, size: { width: number; height: number }, workAreas: Rectangle[]): { x: number; y: number } {
  const area =
    workAreas.find((d) => from.x + from.width / 2 >= d.x && from.x + from.width / 2 < d.x + d.width && from.y >= d.y && from.y < d.y + d.height) ??
    workAreas[0] ?? { x: 0, y: 0, width: Number.MAX_SAFE_INTEGER, height: Number.MAX_SAFE_INTEGER };
  let x = from.x + CASCADE_STEP;
  let y = from.y + CASCADE_STEP;
  const fits = (px: number, py: number) => px + Math.min(size.width, area.width) <= area.x + area.width && py + Math.min(size.height, area.height) <= area.y + area.height;
  if (!fits(x, y)) {
    x = area.x + CASCADE_STEP;
    y = area.y + CASCADE_STEP;
    if (!fits(x, y)) {
      x = area.x;
      y = area.y;
    }
  }
  return { x, y };
}

/** Command-line flag of the Windows taskbar "New window" task (jump list). */
export const NEW_WINDOW_ARG = '--oide-new-window';
