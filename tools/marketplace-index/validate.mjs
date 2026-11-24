#!/usr/bin/env node
// Validates a marketplace index.json: the MarketplaceIndex schema, CI rules, and every listed
// tarball (integrity hash, safe extraction, manifest, tools and capabilities match the entry).
//
//   node tools/marketplace-index/validate.mjs [index.json] [--tarball name@version=path ...] [--schema-only]
//   node tools/marketplace-index/validate.mjs --bundled     (re-packs built-ins and checks bundled/index.json)
import './register-ts.mjs';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const here = path.dirname(fileURLToPath(import.meta.url));
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    tarball: { type: 'string', multiple: true, default: [] },
    'schema-only': { type: 'boolean', default: false },
    bundled: { type: 'boolean', default: false },
  },
});

const lib = await import('./lib.mjs');
const file = positionals[0] ?? path.join(here, 'bundled', 'index.json');
let json;
try {
  json = JSON.parse(readFileSync(file, 'utf8'));
} catch (e) {
  console.error(`${file}: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}

/** @type {Record<string, string>} */
const local = {};
for (const t of values.tarball) {
  const i = t.lastIndexOf('=');
  if (i < 1) {
    console.error(`--tarball expects name@version=path, got ${t}`);
    process.exit(1);
  }
  local[t.slice(0, i)] = path.resolve(t.slice(i + 1));
}
if (values.bundled) {
  const { tarballs } = lib.buildBundledIndex({ extensionsDir: path.resolve(here, '..', '..', 'extensions'), tarballDir: path.join(here, 'dist', 'tarballs') });
  Object.assign(local, tarballs);
}

const errors = values['schema-only'] ? lib.validateIndex(json).errors : await lib.validateAll(json, { local });
if (errors.length) {
  console.error(errors.map((e) => `  ${e}`).join('\n'));
  console.error(`${file}: ${errors.length} problem(s)`);
  process.exit(1);
}
console.log(`${file}: OK`);
