import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import type { Plugin } from 'vite';
import { buildCsp } from './src/main/security/csp';

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

export default defineConfig({
  main: {
    build: {
      outDir: 'out/main',
      externalizeDeps: { include: runtimeDeps, exclude: [] },
      rolldownOptions: {
        input: { index: resolve(root, 'src/main/index.ts') },
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
    plugins: [react(), tailwindcss(), cspPlugin()],
    build: {
      outDir: resolve(root, 'out/renderer'),
      rolldownOptions: {
        input: { index: resolve(root, 'src/renderer/index.html') },
      },
    },
  },
});
