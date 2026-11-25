import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import type { Plugin } from 'vite';
import { excalidrawAssets } from './excalidraw-assets';
import { buildCsp } from './src/main/security/csp';
import { OFFICIAL_UMAMI_HOST, OFFICIAL_UMAMI_WEBSITE_ID } from '../../packages/protocol/src/distribution';

const root = import.meta.dirname;
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
  dependencies?: Record<string, string>;
};

/**
 * Main/preload externalize only real runtime deps (natives + electron-updater), which are the only
 * entries in `dependencies`. Workspace packages (`@oide/*`) export TypeScript source (ADR 0002)
 * and live in devDependencies, so they are bundled. `node:*` builtins are always external.
 */
const runtimeDeps = Object.keys(pkg.dependencies ?? {});

/** Injects the CSP <meta> tag into index.html (dev policy for `serve`, strict policy for `build`). */
function cspPlugin(): Plugin {
  let dev = false;
  return {
    name: 'oide:csp',
    configResolved(c) {
      dev = c.command === 'serve';
    },
    transformIndexHtml(html) {
      return html.replace('%OIDE_CSP%', buildCsp({ dev }));
    },
  };
}

/**
 * The release feed the updater may use (apps/desktop/src/main/services/updater.ts). Empty unless the
 * build env sets both (the release workflow passes repository variables); then the updater stays off.
 */
const publishDefines = {
  __OIDE_PUBLISH_OWNER__: JSON.stringify(process.env.OIDE_PUBLISH_OWNER ?? ''),
  __OIDE_PUBLISH_REPO__: JSON.stringify(process.env.OIDE_PUBLISH_REPO ?? ''),
};

/**
 * Opt-in telemetry endpoint (ADR 0011, packages/protocol/src/distribution.ts). Official builds use the
 * defaults; forks set `OIDE_UMAMI_HOST` / `OIDE_UMAMI_WEBSITE_ID` to their own Umami, or either to an
 * empty string to compile telemetry out (no question, no network).
 */
const telemetryDefines = {
  __OIDE_UMAMI_HOST__: JSON.stringify(process.env.OIDE_UMAMI_HOST ?? OFFICIAL_UMAMI_HOST),
  __OIDE_UMAMI_WEBSITE_ID__: JSON.stringify(process.env.OIDE_UMAMI_WEBSITE_ID ?? OFFICIAL_UMAMI_WEBSITE_ID),
};

export default defineConfig({
  main: {
    define: { ...publishDefines, ...telemetryDefines },
    build: {
      outDir: 'out/main',
      externalizeDeps: { include: runtimeDeps, exclude: [] },
      rolldownOptions: {
        input: {
          index: resolve(root, 'src/main/index.ts'),
          // Extension host code runs in its own utility process per extension (out/main/host-process.js).
          'host-process': resolve(root, '../../packages/extension-host/src/host-process.ts'),
        },
      },
    },
  },
  preload: {
    build: {
      outDir: 'out/preload',
      // Sandboxed preloads must be a single CommonJS file with no node_modules requires.
      externalizeDeps: false,
      rolldownOptions: {
        input: { index: resolve(root, 'src/preload/index.ts') },
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    root: resolve(root, 'src/renderer'),
    plugins: [react(), tailwindcss(), cspPlugin(), excalidrawAssets()],
    build: {
      outDir: resolve(root, 'out/renderer'),
      rolldownOptions: {
        input: { index: resolve(root, 'src/renderer/index.html') },
      },
    },
  },
});
