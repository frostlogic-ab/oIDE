// Resolve hook so scripts can run the workspace's TypeScript sources with Node's built-in type
// stripping: internal packages import `./x.js`, which is `./x.ts` on disk (ADR 0002).
// Registered by ./register-ts.mjs (`node --import ./scripts/register-ts.mjs …`).
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export async function resolve(specifier, context, next) {
  if (specifier.endsWith('.js') && context.parentURL?.startsWith('file:') && (specifier.startsWith('.') || specifier.startsWith('/'))) {
    const tsUrl = new URL(specifier.slice(0, -3) + '.ts', context.parentURL);
    if (existsSync(fileURLToPath(tsUrl))) return next(tsUrl.href, context);
  }
  return next(specifier, context);
}
