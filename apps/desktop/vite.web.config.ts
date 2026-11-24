/**
 * Renderer-only dev server (`pnpm --filter @oide/desktop dev:web`). Runs the React shell in a plain
 * browser with the in-memory mock bridge (src/renderer/src/lib/mock), for visual checks without
 * Electron. Never used for packaged builds.
 */
import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { buildCsp } from './src/main/security/csp';

const root = import.meta.dirname;

export default defineConfig({
  root: resolve(root, 'src/renderer'),
  plugins: [
    react(),
    tailwindcss(),
    { name: 'oide:csp', transformIndexHtml: (html) => html.replace('%OIDE_CSP%', buildCsp({ dev: true })) },
  ],
  server: { port: 5174, strictPort: false },
});
