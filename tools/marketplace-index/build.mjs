#!/usr/bin/env node
// Packs oIDE's built-in extensions and writes the bundled marketplace index (the app's offline
// fallback). Only built-ins are listed; their integrity comes from the locally packed tarballs.
//
//   node tools/marketplace-index/build.mjs [--out bundled/index.json] [--tarballs dist/tarballs]
import './register-ts.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const here = path.dirname(fileURLToPath(import.meta.url));
const { values } = parseArgs({
  options: {
    out: { type: 'string', default: path.join(here, 'bundled', 'index.json') },
    tarballs: { type: 'string', default: path.join(here, 'dist', 'tarballs') },
    extensions: { type: 'string', default: path.resolve(here, '..', '..', 'extensions') },
  },
});

const { buildBundledIndex, validateAll, writeJson } = await import('./lib.mjs');
const { index, tarballs } = buildBundledIndex({ extensionsDir: values.extensions, tarballDir: values.tarballs });
const errors = await validateAll(index, { local: tarballs });
if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
writeJson(values.out, index);
console.log(`Wrote ${path.relative(process.cwd(), values.out)} with ${index.extensions.length} built-in extensions`);
