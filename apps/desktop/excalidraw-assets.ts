/**
 * Bundles Excalidraw's fonts with the renderer, so the whiteboard editor never reaches a CDN
 * (Excalidraw's default is esm.sh, which the CSP blocks anyway).
 *
 * - `build`: copies `@excalidraw/excalidraw/dist/prod/fonts/**` to `<outDir>/excalidraw-assets/fonts/`.
 * - `serve` (electron-vite dev, dev:web): serves the same files at `/excalidraw-assets/fonts/`.
 *
 * The renderer sets `window.EXCALIDRAW_ASSET_PATH` to `./excalidraw-assets/` (resolved against
 * the page URL) before Excalidraw loads; see screens/Artifacts/excalidraw-env.ts.
 *
 * All families are copied, Xiaolai (the CJK fallback, 13 MB in 209 subset files) included: when a
 * board opens, Excalidraw and Chromium load every registered face, and a missing one falls back to
 * esm.sh (a CSP violation per file). The rest is about 0.5 MB. Fonts load only when a board opens.
 */
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { Plugin } from 'vite';

export const EXCALIDRAW_ASSET_DIR = 'excalidraw-assets';

function fontsDir(): string {
  // The package's export map only exposes "." and "./index.css", so resolve the entry and walk up.
  const entry = createRequire(import.meta.url).resolve('@excalidraw/excalidraw');
  return join(dirname(entry), 'fonts');
}

function listFonts(dir: string): string[] {
  const out: string[] = [];
  for (const family of readdirSync(dir)) {
    const fdir = join(dir, family);
    if (!statSync(fdir).isDirectory()) continue;
    for (const f of readdirSync(fdir)) if (f.endsWith('.woff2')) out.push(join(fdir, f));
  }
  return out;
}

export function excalidrawAssets(): Plugin {
  const dir = fontsDir();
  return {
    name: 'oide:excalidraw-assets',
    configureServer(server) {
      server.middlewares.use(`/${EXCALIDRAW_ASSET_DIR}/fonts/`, (req, res, next) => {
        const rel = decodeURIComponent((req.url ?? '').split('?')[0] ?? '').replace(/^\/+/, '');
        const file = resolve(dir, rel);
        const inside = file.startsWith(dir + sep) && !relative(dir, file).startsWith('..');
        if (!inside || !file.endsWith('.woff2') || !existsSync(file)) return next();
        res.setHeader('Content-Type', 'font/woff2');
        res.setHeader('Cache-Control', 'max-age=31536000, immutable');
        createReadStream(file).pipe(res);
      });
    },
    generateBundle() {
      for (const file of listFonts(dir)) {
        const rel = relative(dir, file).split(sep).join('/');
        this.emitFile({
          type: 'asset',
          fileName: `${EXCALIDRAW_ASSET_DIR}/fonts/${rel}`,
          source: readFileSync(file),
        });
      }
    },
  };
}
