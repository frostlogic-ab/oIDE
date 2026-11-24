/**
 * Content Security Policy for every oIDE window.
 *
 * Production: no remote scripts, no eval, no inline scripts. Styles allow 'unsafe-inline' because
 * Monaco and xterm inject <style> tags at runtime. Fonts and images may come from data:/blob:
 * (Vite inlines small assets; Monaco uses blob: workers).
 *
 * Dev (electron-vite dev server): additionally allows the Vite client's inline React-refresh
 * preamble and the HMR websocket on localhost. Never used in packaged builds.
 *
 * Pure module: imported by electron.vite.config.ts (to inject the <meta> tag) and by main
 * (to set the response header). Keep it free of Electron imports.
 */
export interface CspOptions {
  dev?: boolean;
  /** Extra frame sources, e.g. a custom protocol for sandboxed artifact/extension iframes. */
  frameSrc?: string[];
}

/**
 * Frames the app window may embed, all sandboxed iframes: artifact previews
 * (`oide-artifact://<id>/…`) and extension panels and artifact viewers (`oide-ext://<origin>/…`).
 */
export const APP_FRAME_SRC = ['oide-artifact:', 'oide-ext:'];

export function buildCsp({ dev = false, frameSrc = APP_FRAME_SRC }: CspOptions = {}): string {
  const directives: Record<string, string[]> = {
    'default-src': ["'self'"],
    'script-src': dev ? ["'self'", "'unsafe-inline'"] : ["'self'"],
    'style-src': ["'self'", "'unsafe-inline'"],
    'img-src': ["'self'", 'data:', 'blob:'],
    'font-src': ["'self'", 'data:'],
    'connect-src': dev ? ["'self'", 'ws://localhost:*', 'http://localhost:*'] : ["'self'"],
    'worker-src': ["'self'", 'blob:'],
    'frame-src': frameSrc.length ? frameSrc : ["'none'"],
    'object-src': ["'none'"],
    'base-uri': ["'none'"],
    'form-action': ["'none'"],
  };
  return Object.entries(directives)
    .map(([k, v]) => `${k} ${v.join(' ')}`)
    .join('; ');
}
