/**
 * oIDE's offline preview runtime for React designs (ADR 0013), bundled into one IIFE
 * (`out/artifact-runtime/react-runtime.js`, vite.runtime.config.ts) and served by main at
 * `oide-artifact://<id>/__oide/react-runtime.js`. It runs inside the sandboxed preview iframe (opaque
 * origin, CSP with no network and no eval): it reads the design's source from the page main
 * generated (`#oide-src`, JSON), compiles it with Sucrase, runs it through an inline <script> and
 * renders its component into `#root`. Tailwind's browser build styles utility classes offline.
 */
import * as React from 'react';
import * as ReactDOM from 'react-dom';
import * as ReactDOMClient from 'react-dom/client';
import * as JsxRuntime from 'react/jsx-runtime';
import * as Lucide from 'lucide-react';
import * as Recharts from 'recharts';
import '@tailwindcss/browser';
import { asCommonJs, compileDesign, makeRequire, pickComponent, UnsupportedImportError, wrapForScript } from './compile.js';

const HOOK = '__oideDefine';

const MODULES: Record<string, Record<string, unknown>> = {
  react: asCommonJs(React as unknown as Record<string, unknown>),
  'react-dom': asCommonJs(ReactDOM as unknown as Record<string, unknown>),
  'react-dom/client': asCommonJs(ReactDOMClient as unknown as Record<string, unknown>),
  'react/jsx-runtime': asCommonJs(JsxRuntime as unknown as Record<string, unknown>),
  'lucide-react': asCommonJs(Lucide as unknown as Record<string, unknown>),
  recharts: asCommonJs(Recharts as unknown as Record<string, unknown>),
};

/** A readable, escaped message in the frame (textContent only), on oIDE's dark tokens. */
function showProblem(title: string, detail?: string): void {
  const root = document.getElementById('root') ?? document.body;
  const box = document.createElement('div');
  box.setAttribute('role', 'alert');
  box.style.cssText =
    'margin:16px;padding:14px 16px;border-radius:10px;background:#15181D;border:1px solid #343A44;color:#E6E8EB;' +
    "font:13px/1.5 Inter,system-ui,-apple-system,'Segoe UI',sans-serif;max-width:720px";
  const h = document.createElement('div');
  h.style.cssText = 'color:#F08A8A;font-weight:600;margin-bottom:6px';
  h.textContent = title;
  box.appendChild(h);
  if (detail) {
    const pre = document.createElement('pre');
    pre.style.cssText = "margin:0;white-space:pre-wrap;color:#C9CED6;font:12px/1.5 'JetBrains Mono',ui-monospace,monospace";
    pre.textContent = detail.slice(0, 4000);
    box.appendChild(pre);
  }
  root.replaceChildren(box);
}

function problemOf(err: unknown): [string, string | undefined] {
  if (err instanceof UnsupportedImportError) return [err.message, 'Ask Claude for a version that only uses React, lucide-react, recharts and Tailwind classes.'];
  const e = err as { name?: unknown; message?: unknown };
  return ['The design failed to run.', `${typeof e?.name === 'string' ? e.name : 'Error'}: ${typeof e?.message === 'string' ? e.message : String(err)}`];
}

class Boundary extends React.Component<{ children?: React.ReactNode }, { error: unknown }> {
  override state: { error: unknown } = { error: undefined };
  static getDerivedStateFromError(error: unknown) {
    return { error };
  }
  override componentDidCatch(error: unknown) {
    queueMicrotask(() => {
      const [t, d] = problemOf(error);
      showProblem(t, d);
    });
  }
  override render() {
    return this.state.error === undefined ? this.props.children : null;
  }
}

function boot(): void {
  const el = document.getElementById('oide-src');
  let source: string;
  try {
    source = JSON.parse(el?.textContent ?? '""') as string;
  } catch {
    showProblem('The design could not be read.');
    return;
  }
  let code: string;
  try {
    code = compileDesign(source);
  } catch (err) {
    showProblem("The design's code has an error.", String((err as Error)?.message ?? err));
    return;
  }
  const module: { exports: Record<string, unknown> } = { exports: {} };
  let failure: unknown;
  let ran = false;
  const w = window as unknown as Record<string, unknown>;
  w[HOOK] = (factory: (require: (s: string) => unknown, module: unknown, exports: unknown) => void) => {
    ran = true;
    try {
      factory(makeRequire(MODULES), module, module.exports);
    } catch (err) {
      failure = err;
    }
  };
  const script = document.createElement('script');
  script.textContent = wrapForScript(code, HOOK);
  document.head.appendChild(script);
  delete w[HOOK];
  if (!ran) {
    showProblem('The design could not be started.', 'The preview blocked its script.');
    return;
  }
  if (failure !== undefined) {
    const [t, d] = problemOf(failure);
    showProblem(t, d);
    return;
  }
  const Component = pickComponent(module.exports);
  if (!Component) {
    showProblem("This design doesn't export a component.", 'Add `export default` to the main component.');
    return;
  }
  const root = document.getElementById('root');
  if (!root) return;
  ReactDOMClient.createRoot(root).render(React.createElement(Boundary, null, React.createElement(Component as React.ComponentType)));
}

window.addEventListener('error', (e) => {
  const [t, d] = problemOf(e.error ?? e.message);
  showProblem(t, d);
});
window.addEventListener('unhandledrejection', (e) => {
  const [t, d] = problemOf(e.reason);
  showProblem(t, d);
});

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
else boot();
