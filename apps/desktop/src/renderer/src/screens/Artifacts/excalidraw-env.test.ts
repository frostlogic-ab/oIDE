// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

describe('excalidraw-env', () => {
  it('points Excalidraw at the bundled fonts and strips its CDN font fallback', async () => {
    const calls: string[] = [];
    class FakeFontFace {
      constructor(_family: string, source: string) {
        calls.push(source);
      }
    }
    (window as unknown as { FontFace: unknown }).FontFace = FakeFontFace;
    const env = await import('./excalidraw-env');
    expect(window.EXCALIDRAW_ASSET_PATH).toBe(new URL('excalidraw-assets/', document.baseURI).href);
    const local = `url(${env.EXCALIDRAW_ASSET_PATH}fonts/Virgil/Virgil-Regular.woff2) format('woff2')`;
    const cdn =
      "url(https://esm.sh/@excalidraw/excalidraw@0.18.1/dist/prod/fonts/Virgil/Virgil-Regular.woff2) format('woff2')";
    expect(env.withoutCdnSources(`${local}, ${cdn}`)).toBe(local);
    expect(env.withoutCdnSources(cdn)).toBe('');
    new window.FontFace('Virgil', `${local}, ${cdn}`);
    expect(calls).toEqual([local]);
  });
});
