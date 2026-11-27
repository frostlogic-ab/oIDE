import { describe, expect, it } from 'vitest';
import { CASCADE_STEP, cascadePosition, WindowRegistry } from './windows.js';

const fake = () => {
  const w = { destroyed: false, isDestroyed: () => w.destroyed };
  return w;
};

describe('WindowRegistry', () => {
  it('tracks the window the user focused last', () => {
    const r = new WindowRegistry<ReturnType<typeof fake>>();
    const a = fake();
    const b = fake();
    expect(r.active()).toBeNull();
    r.add(a);
    r.add(b);
    expect(r.active()).toBe(b);
    r.focused(a);
    expect(r.active()).toBe(a);
    expect(r.all()).toEqual([b, a]);
    expect(r.size).toBe(2);
  });

  it('falls back to the previous window when the active one closes or is destroyed', () => {
    const r = new WindowRegistry<ReturnType<typeof fake>>();
    const a = fake();
    const b = fake();
    r.add(a);
    r.add(b);
    b.destroyed = true;
    expect(r.active()).toBe(a);
    expect(r.all()).toEqual([a]);
    r.remove(a);
    expect(r.active()).toBeNull();
    expect(r.size).toBe(0);
  });

  it('ignores focus of a window it does not know and double adds', () => {
    const r = new WindowRegistry<ReturnType<typeof fake>>();
    const a = fake();
    r.add(a);
    r.add(a);
    r.focused(fake());
    expect(r.all()).toEqual([a]);
  });
});

describe('cascadePosition', () => {
  const area = { x: 0, y: 0, width: 1920, height: 1040 };
  const size = { width: 1440, height: 900 };

  it('steps down and right from the active window', () => {
    expect(cascadePosition({ x: 100, y: 50, ...size }, size, [area])).toEqual({ x: 100 + CASCADE_STEP, y: 50 + CASCADE_STEP });
  });

  it('wraps to the top-left of the work area when the step would leave the display', () => {
    expect(cascadePosition({ x: 470, y: 130, ...size }, size, [area])).toEqual({ x: CASCADE_STEP, y: CASCADE_STEP });
  });

  it('stays on the display the active window is on', () => {
    const right = { x: 1920, y: 0, width: 2560, height: 1400 };
    expect(cascadePosition({ x: 2000, y: 40, ...size }, size, [area, right])).toEqual({ x: 2000 + CASCADE_STEP, y: 40 + CASCADE_STEP });
    expect(cascadePosition({ x: 3000, y: 480, ...size }, size, [area, right])).toEqual({ x: 1920 + CASCADE_STEP, y: CASCADE_STEP });
  });

  it('uses the work-area origin when even one step does not fit (a window as big as the screen)', () => {
    expect(cascadePosition({ x: 0, y: 0, width: 1920, height: 1040 }, { width: 1920, height: 1040 }, [area])).toEqual({ x: 0, y: 0 });
  });
});
