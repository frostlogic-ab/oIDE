#!/usr/bin/env node
// Copies the bundled language servers and everything they need at run time from the workspace's
// installed node_modules (pinned by pnpm-lock.yaml; no network) to <out>/node_modules, keeping the
// same nesting so Node resolves each package exactly as it does here. electron-builder ships
// <out> as <resources>/language-servers (apps/desktop/electron-builder.yml, ADR 0020).
// Usage: node packages/language-servers/stage.mjs <out>
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(process.argv[2] ?? join(here, '..', '..', 'apps', 'desktop', 'release', 'language-servers'));
const pkg = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'));

/** The folder Node would load `name` from, starting at `fromDir` (a package folder). */
function locate(name, fromDir) {
  for (let dir = fromDir; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return candidate;
    if (dirname(dir) === dir) return undefined;
  }
}

const root = resolve(here, '..', '..');
const seen = new Set();
const queue = Object.keys(pkg.dependencies).map((name) => ({ name, from: here, optional: false }));
while (queue.length) {
  const { name, from, optional } = queue.shift();
  const dir = locate(name, from);
  if (!dir) {
    if (optional) continue;
    throw new Error(`stage: ${name} (needed from ${relative(root, from) || '.'}) is not installed; run pnpm install`);
  }
  if (seen.has(dir)) continue;
  seen.add(dir);
  const p = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  for (const d of Object.keys(p.dependencies ?? {})) queue.push({ name: d, from: dir, optional: false });
  for (const d of Object.keys(p.optionalDependencies ?? {})) queue.push({ name: d, from: dir, optional: true });
}

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'node_modules'), { recursive: true });
for (const dir of seen) {
  const rel = relative(root, dir);
  if (rel.startsWith('..')) throw new Error(`stage: ${dir} is outside the workspace`);
  // Nested node_modules are copied only for the packages actually reached (they are in `seen`).
  cpSync(dir, join(out, rel), { recursive: true, dereference: true, filter: (src) => !relative(dir, src).split(sep).includes('node_modules') });
}
// ------------------------------------------------------------------ prune what never loads
// typescript-language-server runs the TypeScript it resolves (tsserver.js); the HTML server's own
// older TypeScript only serves <script> blocks through typescript.js. Neither needs tsc, the
// server library builds, or the translated messages. yaml-language-server formats with
// prettier/standalone and its estree and yaml plugins only.
const LOCALES = new Set(['cs', 'de', 'es', 'fr', 'it', 'ja', 'ko', 'pl', 'pt-br', 'ru', 'tr', 'zh-cn', 'zh-tw']);
const tsForServer = locate('typescript', locate('typescript-language-server', here));
const drop = (p) => rmSync(p, { recursive: true, force: true });
function walk(dir, fn) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, fn);
    else fn(p, name);
  }
}
for (const src of seen) {
  const dir = join(out, relative(root, src));
  const name = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name;
  if (name === 'typescript') {
    const lib = join(dir, 'lib');
    for (const f of readdirSync(lib)) {
      if (LOCALES.has(f) || /^(_?tsc|tsserverlibrary|typescriptServices)\.(js|d\.ts)$/.test(f)) drop(join(lib, f));
      else if (src !== tsForServer && /^(_?tsserver|_?typingsInstaller|cancellationToken|watchGuard)\.js$/.test(f)) drop(join(lib, f));
    }
    drop(join(dir, 'bin'));
  }
  if (name === 'prettier') {
    for (const f of readdirSync(dir)) if (!/^(package\.json|LICENSE|THIRD-PARTY-NOTICES\.md|standalone\.(js|mjs)|plugins)$/.test(f)) drop(join(dir, f));
    for (const f of readdirSync(join(dir, 'plugins'))) if (!/^(estree|yaml)\.(js|mjs)$/.test(f)) drop(join(dir, 'plugins', f));
  }
  walk(dir, (p, f) => {
    if (name === 'typescript' && /^lib\..*\.d\.ts$/.test(f)) return; // the standard library declarations
    if (/\.(map|d\.ts|d\.mts|d\.cts|tsbuildinfo)$/.test(f) || /^(CHANGELOG|CONTRIBUTING|README)(\.md)?$/i.test(f) || f === 'Dockerfile') drop(p);
  });
  if (basename(dir) === 'yaml-language-server') for (const f of ['scripts', 'lib']) drop(join(dir, f));
}

console.log(`stage: ${seen.size} packages -> ${relative(process.cwd(), out) || out}`);
