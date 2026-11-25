import { resolve } from 'node:path';
import { defineConfig } from 'vite';

/**
 * The offline preview runtime for React designs (ADR 0013): one IIFE with React, ReactDOM, Sucrase,
 * lucide-react, recharts and Tailwind's browser build, written to out/artifact-runtime/. Main serves it
 * at oide-artifact://<id>/__oide/react-runtime.js (services/artifact-preview.ts); electron-builder ships it.
 */
const root = import.meta.dirname;

export default defineConfig({
  root,
  publicDir: false,
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  build: {
    outDir: resolve(root, 'out/artifact-runtime'),
    emptyOutDir: true,
    target: 'chrome130',
    minify: true,
    sourcemap: false,
    reportCompressedSize: false,
    chunkSizeWarningLimit: 8000,
    lib: {
      entry: resolve(root, 'src/artifact-runtime/runtime.ts'),
      formats: ['iife'],
      name: 'OideArtifactRuntime',
      fileName: () => 'react-runtime.js',
    },
  },
});
