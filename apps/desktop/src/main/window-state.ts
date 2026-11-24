import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { BrowserWindow, Rectangle } from 'electron';

export interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized: boolean;
}

export const MIN_WIDTH = 1100;
export const MIN_HEIGHT = 700;
const DEFAULT_STATE: WindowState = { width: 1440, height: 900, maximized: false };

export function loadWindowState(userData: string, displays: Rectangle[]): WindowState {
  try {
    const raw = JSON.parse(readFileSync(join(userData, 'window-state.json'), 'utf8')) as Partial<WindowState>;
    const width = Math.max(MIN_WIDTH, Number(raw.width) || DEFAULT_STATE.width);
    const height = Math.max(MIN_HEIGHT, Number(raw.height) || DEFAULT_STATE.height);
    const state: WindowState = { width, height, maximized: raw.maximized === true };
    if (typeof raw.x === 'number' && typeof raw.y === 'number') {
      const x = raw.x;
      const y = raw.y;
      // Only restore the position if the title bar area is on some display.
      const visible = displays.some((d) => x + 100 > d.x && x < d.x + d.width - 100 && y >= d.y && y < d.y + d.height - 40);
      if (visible) Object.assign(state, { x, y });
    }
    return state;
  } catch {
    return { ...DEFAULT_STATE };
  }
}

export function trackWindowState(win: BrowserWindow, userData: string): void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const save = () => {
    if (win.isDestroyed()) return;
    const maximized = win.isMaximized();
    const b = maximized ? win.getNormalBounds() : win.getBounds();
    const state: WindowState = { x: b.x, y: b.y, width: b.width, height: b.height, maximized };
    try {
      const file = join(userData, 'window-state.json');
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify(state));
    } catch {
      /* best effort */
    }
  };
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(save, 400);
  };
  win.on('resize', schedule);
  win.on('move', schedule);
  win.on('close', () => {
    if (timer) clearTimeout(timer);
    save();
  });
}
