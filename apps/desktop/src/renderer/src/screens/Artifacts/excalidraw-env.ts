/**
 * Points Excalidraw at the fonts bundled with the app (apps/desktop/excalidraw-assets.ts copies them
 * to `excalidraw-assets/fonts/` next to index.html). Must be imported before `@excalidraw/excalidraw`.
 *
 * - The URL is absolute (resolved against the page) because Excalidraw resolves "./" paths against
 *   `location.origin`, which is "null" for the packaged app's file:// page.
 * - Excalidraw always appends an esm.sh copy as a fallback `src` of every FontFace. The CSP blocks
 *   it, but Chromium still reports a violation for each of the ~240 faces when a board opens. The
 *   FontFace wrapper below drops those CDN sources, so a board never even names a remote URL.
 */
declare global {
  interface Window {
    EXCALIDRAW_ASSET_PATH?: string | string[];
  }
}

export const EXCALIDRAW_ASSET_PATH = new URL('excalidraw-assets/', document.baseURI).href;

/** `, url(https://esm.sh/…) format('woff2')` as Excalidraw writes it. */
const CDN_SOURCE = /,?\s*url\(\s*["']?https:\/\/esm\.sh\/[^)]*\)(\s*format\([^)]*\))?/g;

/** Removes Excalidraw's CDN fallback from a FontFace `src` list (other sources are kept as they are). */
export function withoutCdnSources(source: string): string {
  return source.replace(CDN_SOURCE, '').replace(/^\s*,\s*/, '');
}

window.EXCALIDRAW_ASSET_PATH = EXCALIDRAW_ASSET_PATH;

const flagged = window as Window & { __oideLocalFontFace?: true };
if (typeof window.FontFace === 'function' && !flagged.__oideLocalFontFace) {
  const NativeFontFace = window.FontFace;
  window.FontFace = class LocalFontFace extends NativeFontFace {
    constructor(family: string, source: string | BufferSource, descriptors?: FontFaceDescriptors) {
      super(family, typeof source === 'string' ? withoutCdnSources(source) : source, descriptors);
    }
  };
  flagged.__oideLocalFontFace = true;
}
