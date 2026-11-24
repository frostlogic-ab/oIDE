/** Accent colours offered in Settings › Appearance (the canvas's accent prop options). */
export const ACCENT_OPTIONS = [
  { id: 'blue', label: 'Blue', value: '#7AA2F7' },
  { id: 'green', label: 'Green', value: '#7FC8A9' },
  { id: 'violet', label: 'Violet', value: '#C4A7E7' },
  { id: 'amber', label: 'Amber', value: '#F2C078' },
] as const;

export const DEFAULT_ACCENT = '#7AA2F7';

const HEX = /^#[0-9a-f]{6}$/i;

/** Switch the accent at runtime. Every `*-accent` utility reads `--color-accent`. */
export function setAccent(color: string, root: HTMLElement = document.documentElement): void {
  root.style.setProperty('--color-accent', HEX.test(color) ? color : DEFAULT_ACCENT);
}
