import * as React from 'react';
import * as JsxRuntime from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { asCommonJs, compileDesign, makeRequire, pickComponent, UnsupportedImportError, wrapForScript } from './compile.js';

/** Runs compiled code the way the runtime's inline <script> does (tests only use Function). */
function run(code: string, modules: Record<string, Record<string, unknown>>): Record<string, unknown> {
  const module: { exports: Record<string, unknown> } = { exports: {} };
  new Function('require', 'module', 'exports', code)(makeRequire(modules), module, module.exports);
  return module.exports;
}

const Camera = (props: { size?: number }) => React.createElement('svg', { 'data-icon': 'camera', width: props.size ?? 24 });
const MODULES = {
  react: asCommonJs(React as unknown as Record<string, unknown>),
  'react/jsx-runtime': asCommonJs(JsxRuntime as unknown as Record<string, unknown>),
  'lucide-react': asCommonJs({ Camera }),
};

const CLAUDE_STYLE = `import React, { useState } from 'react';
import { Camera } from 'lucide-react';

type Props = { start?: number };

export default function Counter({ start = 2 }: Props) {
  const [n, setN] = useState<number>(start);
  return (
    <div className="p-4 bg-slate-900 text-white">
      <Camera size={16} />
      <h1 className="text-xl">Count {n}</h1>
      <button onClick={() => setN(n + 1)}>Add</button>
    </div>
  );
}
`;

describe('React design runtime: compile', () => {
  it('compiles a claude.ai-style component (TS, hooks, lucide icon, Tailwind classes) and renders it', () => {
    const exports = run(compileDesign(CLAUDE_STYLE), MODULES);
    const C = pickComponent(exports) as React.ComponentType;
    const html = renderToStaticMarkup(React.createElement(C));
    expect(html).toContain('Count 2');
    expect(html).toContain('class="p-4 bg-slate-900 text-white"');
    expect(html).toContain('data-icon="camera"');
  });

  it('works without importing React (automatic JSX runtime)', () => {
    const exports = run(compileDesign(`export default () => <p>Hi</p>;`), MODULES);
    expect(renderToStaticMarkup(React.createElement(pickComponent(exports) as React.ComponentType))).toBe('<p>Hi</p>');
  });

  it('refuses modules the runtime does not bundle, by name', () => {
    const code = compileDesign(`import { Button } from '@/components/ui/button';\nexport default () => <Button />;`);
    expect(() => run(code, MODULES)).toThrow(UnsupportedImportError);
    expect(() => run(code, MODULES)).toThrow(/@\/components\/ui\/button/);
    expect(() => makeRequire(MODULES)('__proto__')).toThrow(UnsupportedImportError);
    expect(() => makeRequire(MODULES)('constructor')).toThrow(UnsupportedImportError);
  });

  it('throws on a syntax error instead of running anything', () => {
    expect(() => compileDesign('export default function () { return <div> }')).toThrow();
  });

  it('picks the default export, else the only exported function', () => {
    const f = () => null;
    expect(pickComponent({ default: f })).toBe(f);
    expect(pickComponent({ __esModule: true, App: f })).toBe(f);
    expect(pickComponent({ A: f, B: () => null })).toBeUndefined();
    expect(pickComponent({})).toBeUndefined();
  });

  it('wraps code for an inline script that calls the define hook', () => {
    const s = wrapForScript('exports.x = 1;', '__oideDefine');
    expect(s.startsWith('window["__oideDefine"](function (require, module, exports) {')).toBe(true);
    expect(s).toContain('exports.x = 1;');
  });
});
