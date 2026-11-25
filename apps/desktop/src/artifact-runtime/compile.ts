import { transform } from 'sucrase';

/**
 * Compiling a React design for the offline preview (ADR 0013). Sucrase turns JSX / TypeScript and
 * ES imports into CommonJS; `require` resolves only the libraries bundled into the runtime. Nothing
 * here touches the network or uses eval: the caller runs the code through an inline <script>.
 */

/** A module the runtime does not bundle (shadcn's `@/components/ui/*`, a CDN URL, a local file). */
export class UnsupportedImportError extends Error {
  constructor(readonly specifier: string) {
    super(`This artifact imports ${specifier}, which oIDE's offline preview doesn't include.`);
    this.name = 'UnsupportedImportError';
  }
}

/** Source → CommonJS that expects `require`, `module` and `exports`. Throws on a syntax error. */
export function compileDesign(source: string): string {
  return transform(source, {
    transforms: ['jsx', 'typescript', 'imports'],
    jsxRuntime: 'automatic',
    production: true,
    filePath: 'App.tsx',
  }).code;
}

/** An ES namespace object as CommonJS interop expects it (`default` = the module itself if none). */
export function asCommonJs(ns: Record<string, unknown>): Record<string, unknown> {
  return { ...ns, __esModule: true, default: 'default' in ns && ns.default !== undefined ? ns.default : ns };
}

/** `require` for the bundled libraries only. */
export function makeRequire(modules: Record<string, Record<string, unknown>>): (specifier: string) => unknown {
  return (specifier: string) => {
    const m = Object.prototype.hasOwnProperty.call(modules, specifier) ? modules[specifier] : undefined;
    if (!m) throw new UnsupportedImportError(specifier);
    return m;
  };
}

/** The component a design exports: `export default`, else its only exported function. */
export function pickComponent(exports: Record<string, unknown>): unknown {
  if (typeof exports.default === 'function' || (exports.default && typeof exports.default === 'object')) return exports.default;
  const fns = Object.entries(exports).filter(([k, v]) => k !== '__esModule' && typeof v === 'function');
  return fns.length === 1 ? fns[0]![1] : undefined;
}

/** Wraps compiled code so an inline script hands it to the runtime's `define` hook. */
export function wrapForScript(code: string, hook: string): string {
  return `window[${JSON.stringify(hook)}](function (require, module, exports) {"use strict";\n${code}\n});`;
}
