// Lets the plain-Node CLI scripts import the workspace's TypeScript sources (ADR 0002):
// `./x.js` falls back to `./x.ts`, and `.ts` files are transformed with Node's built-in
// stripTypeScriptTypes (mode "transform", so parameter properties work too).
import { readFileSync } from 'node:fs';
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { fileURLToPath } from 'node:url';

registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (e) {
      if (specifier.startsWith('.') && specifier.endsWith('.js')) return next(specifier.slice(0, -3) + '.ts', context);
      throw e;
    }
  },
  load(url, context, next) {
    if (url.startsWith('file:') && url.endsWith('.ts')) {
      const source = readFileSync(fileURLToPath(url), 'utf8');
      return { format: 'module', source: stripTypeScriptTypes(source, /** @type {any} */ ({ mode: 'transform', sourceUrl: url })), shortCircuit: true };
    }
    return next(url, context);
  },
});
