import '@fontsource/inter/latin-400.css';
import '@fontsource/inter/latin-500.css';
import '@fontsource/inter/latin-600.css';
import '@fontsource/inter/latin-700.css';
import '@fontsource/jetbrains-mono/latin-400.css';
import '@fontsource/jetbrains-mono/latin-500.css';
import './styles/app.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { installFallbackBridge, oide } from './lib/bridge';
import { keymap } from './lib/keymap';

async function boot() {
  // Dev only: a plain browser (no preload) gets the in-memory mock bridge. Dead code in builds.
  if (import.meta.env.DEV && !window.oide) {
    const { createMockBridge } = await import('./lib/mock');
    installFallbackBridge(createMockBridge());
    console.info('[oide] running with the mock bridge (no Electron preload found)');
  }
  keymap.setPlatform(oide.platform === 'darwin');
  keymap.attach(window);

  const root = document.getElementById('root');
  if (!root) throw new Error('#root missing');
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void boot();
