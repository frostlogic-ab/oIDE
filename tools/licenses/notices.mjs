#!/usr/bin/env node
// Generates THIRD_PARTY_NOTICES.md for everything that ships in a packaged oIDE build.
//
//   pnpm licenses:notices          write THIRD_PARTY_NOTICES.md
//   pnpm licenses:check            fail if a shipped licence is not MIT-compatible, or the file is stale
//
// What ships (see docs/wiki/pages/packaging.md):
//   1. Runtime modules in the app's node_modules: `dependencies` of apps/desktop and their
//      transitive dependencies (installed optional dependencies included).
//   2. Libraries bundled into out/ by electron-vite. These are found by scanning the bare imports of
//      the shipped sources (apps/desktop/src and every @oide/* workspace package they reach), not
//      from a hand-written list. Test files, mocks and type-only imports are skipped. Each bundled
//      package's own `dependencies` are followed too (conservative: a few may be tree-shaken away).
//   3. Small runtime helpers the build injects into the bundle (Vite's module preload polyfill).
//   4. Electron itself. Chromium's and the other bundled notices ship inside Electron as
//      LICENSES.chromium.html next to the executable.
// The output is deterministic (no dates), so `--check` can compare it byte for byte.

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DESKTOP = join(ROOT, 'apps', 'desktop');
const OUT_FILE = join(ROOT, 'THIRD_PARTY_NOTICES.md');
const CHECK = process.argv.includes('--check');

/** Licences compatible with shipping inside an MIT-licensed app. */
const ALLOWED = new Set([
  'MIT',
  'MIT-0',
  'ISC',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'Apache-2.0',
  '0BSD',
  'BlueOak-1.0.0',
  'CC0-1.0',
  'Unlicense',
  'Python-2.0',
  'CC-BY-4.0', // data only (e.g. caniuse-style tables)
  'OFL-1.1', // fonts
  'Zlib',
]);

/** Injected by the build into the renderer bundle; noticed, but their dependencies do not ship. */
const INJECTED = [{ name: 'vite', why: 'module preload polyfill injected into the renderer bundle' }];

/** Never treated as shipped packages even if a source file names them. */
const IGNORE = new Set(['electron', 'vitest', '@testing-library/react', '@testing-library/dom', '@playwright/test']);

const SOURCE_EXT = /\.(?:[cm]?[jt]sx?|css)$/;
const SKIP_FILE = /(?:\.test\.|\.spec\.|\.d\.ts$|[\\/]testing\.tsx?$)/;
const SKIP_DIR = new Set(['node_modules', 'dist', 'out', 'test', 'tests', '__tests__', 'e2e', 'mock', 'fixtures']);

/* ------------------------------------------------------------------ helpers */

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

function walk(dir, files = []) {
  if (!existsSync(dir)) return files;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIR.has(entry.name)) walk(join(dir, entry.name), files);
    } else if (SOURCE_EXT.test(entry.name) && !SKIP_FILE.test(join(dir, entry.name))) {
      files.push(join(dir, entry.name));
    }
  }
  return files;
}

/** Package name of a bare specifier, or null for relative paths, builtins and virtual modules. */
function packageOf(spec) {
  const clean = spec.split('?')[0];
  if (!clean || clean.startsWith('.') || clean.startsWith('/') || clean.startsWith('node:') || clean.startsWith('virtual:') || clean.startsWith('\0')) return null;
  if (/^[a-z]:/i.test(clean) || clean.includes('\\')) return null;
  const parts = clean.split('/');
  const name = clean.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name)) return null;
  if (BUILTINS.has(name)) return null;
  return name;
}

const BUILTINS = new Set([
  'assert', 'buffer', 'child_process', 'crypto', 'events', 'fs', 'http', 'https', 'net', 'os', 'path',
  'process', 'readline', 'stream', 'string_decoder', 'timers', 'tls', 'url', 'util', 'worker_threads', 'zlib',
]);

/** Bare imports of one source file (value imports only; `import type` is erased by the compiler). */
function importsOf(file) {
  const text = readFileSync(file, 'utf8');
  const found = new Set();
  const patterns = [
    /^\s*import\s+(?!type\s)(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/gm,
    /^\s*export\s+(?!type\s)[^'";]*?\s+from\s+['"]([^'"]+)['"]/gm,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /@import\s+(?:url\()?['"]([^'"]+)['"]/g,
  ];
  for (const re of patterns) for (const m of text.matchAll(re)) found.add(m[1]);
  return [...found];
}

/** Node-style resolution of `name` from `fromDir`: nearest node_modules/<name> walking up to ROOT. */
function resolvePackage(name, fromDir) {
  let dir = fromDir;
  for (;;) {
    const candidate = join(dir, 'node_modules', ...name.split('/'));
    if (existsSync(join(candidate, 'package.json'))) return candidate;
    if (dir === ROOT || dirname(dir) === dir) return null;
    dir = dirname(dir);
  }
}

/** Workspace packages by name → folder. */
function workspacePackages() {
  const map = new Map();
  for (const group of ['packages', 'extensions', 'tools', 'apps']) {
    const base = join(ROOT, group);
    if (!existsSync(base)) continue;
    for (const d of readdirSync(base)) {
      const pj = join(base, d, 'package.json');
      if (existsSync(pj)) map.set(readJson(pj).name, join(base, d));
    }
  }
  return map;
}

function licenseOf(pkg) {
  const l = pkg.license ?? pkg.licenses;
  if (typeof l === 'string') return l;
  if (Array.isArray(l)) return l.map((x) => (typeof x === 'string' ? x : x.type)).join(' OR ');
  if (l && typeof l === 'object' && l.type) return l.type;
  return null;
}

const LICENSE_FILE = /^(?:licen[cs]e|copying|notice|third[-_]party[-_]notices?)(?:[-_.][a-z0-9-]+)*(?:\.(?:md|txt|markdown|rst|html))?$/i;

function licenseFiles(dir) {
  return readdirSync(dir)
    .filter((f) => LICENSE_FILE.test(f) && statSync(join(dir, f)).isFile())
    .sort((a, b) => a.localeCompare(b));
}

/** Guess an SPDX id from a licence text when package.json has none. */
function detectFromText(text) {
  if (/Permission is hereby granted, free of charge/i.test(text)) return 'MIT';
  if (/Permission to use, copy, modify, and\/?or distribute this software/i.test(text)) return 'ISC';
  if (/Apache License[\s\S]{0,40}Version 2\.0/i.test(text)) return 'Apache-2.0';
  if (/Redistribution and use in source and binary forms/i.test(text)) return /Neither the name/i.test(text) ? 'BSD-3-Clause' : 'BSD-2-Clause';
  return null;
}

/** SPDX expression check: OR needs one allowed branch, AND needs every term allowed. */
export function isAllowed(expr) {
  if (!expr) return false;
  const e = expr.replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim();
  return e.split(/ OR /i).some((branch) => branch.split(/ AND /i).every((term) => ALLOWED.has(term.trim().replace(/\+$/, '').replace(/ WITH .*/i, ''))));
}

const repoOf = (pkg) => {
  const r = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
  if (!r) return pkg.homepage ?? '';
  return r.replace(/^git\+/, '').replace(/\.git$/, '').replace(/^git:\/\//, 'https://').replace(/^github:/, 'https://github.com/');
};

/* ------------------------------------------------------------------ collect */

const workspace = workspacePackages();
/** key name@version → record */
const shipped = new Map();

function record(dir, via, { follow = true } = {}) {
  const pkg = readJson(join(dir, 'package.json'));
  const key = `${pkg.name}@${pkg.version}`;
  const existing = shipped.get(key);
  if (existing) {
    existing.via.add(via);
    return;
  }
  const files = licenseFiles(dir);
  const texts = files.map((f) => ({ file: f, text: readFileSync(join(dir, f), 'utf8').replace(/\r\n/g, '\n').trimEnd() }));
  let license = licenseOf(pkg);
  let detected = false;
  if (!license || /^see licen[cs]e in/i.test(license)) {
    const guess = texts.map((t) => detectFromText(t.text)).find(Boolean);
    if (guess) {
      license = guess;
      detected = true;
    }
  }
  const rec = { name: pkg.name, version: pkg.version, license: license ?? 'UNKNOWN', detected, repo: repoOf(pkg), texts, via: new Set([via]), dir };
  shipped.set(key, rec);
  if (!follow) return;
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.optionalDependencies ?? {}) };
  for (const dep of Object.keys(deps).sort()) {
    const optional = Boolean(pkg.optionalDependencies && dep in pkg.optionalDependencies);
    const depDir = resolvePackage(dep, dir);
    // Per-platform prebuilds (`<name>-win32-x64`, …): only the current OS's one is installed, so
    // listing it would make the file differ per OS. Check its licence, list the family instead.
    if (optional && dep.startsWith(`${pkg.name}-`)) {
      const fam = platformFamilies.get(pkg.name) ?? { parent: pkg.name, license: licenseOf(pkg), variants: new Set() };
      fam.variants.add(dep);
      platformFamilies.set(pkg.name, fam);
      if (depDir) {
        const p = readJson(join(depDir, 'package.json'));
        platformChecked.push({ name: p.name, version: p.version, license: licenseOf(p) ?? 'UNKNOWN', via: new Set([via]) });
      }
      continue;
    }
    if (depDir) record(depDir, via);
    else if (!optional) missing.push(`${dep} (needed by ${pkg.name})`);
  }
}
const missing = [];
/** parent name → declared per-platform prebuild packages */
const platformFamilies = new Map();
/** installed prebuilds, licence-checked but not listed */
const platformChecked = [];

// 1. Runtime node_modules of the packaged app.
const desktopPkg = readJson(join(DESKTOP, 'package.json'));
for (const dep of Object.keys(desktopPkg.dependencies ?? {}).sort()) {
  const dir = resolvePackage(dep, DESKTOP);
  if (dir) record(dir, 'runtime');
  else missing.push(`${dep} (apps/desktop dependency)`);
}

// 2. Bundled into out/: bare imports of shipped sources, following workspace packages.
const bundledRoots = new Map(); // name → dir it was imported from
const seenWorkspace = new Set();
const scanQueue = [{ dir: join(DESKTOP, 'src'), base: DESKTOP }];
while (scanQueue.length) {
  const { dir, base } = scanQueue.shift();
  for (const file of walk(dir)) {
    for (const spec of importsOf(file)) {
      const name = packageOf(spec);
      if (!name || IGNORE.has(name)) continue;
      if (workspace.has(name)) {
        if (!seenWorkspace.has(name)) {
          seenWorkspace.add(name);
          const wdir = workspace.get(name);
          scanQueue.push({ dir: join(wdir, 'src'), base: wdir });
        }
        continue;
      }
      if (!bundledRoots.has(name)) bundledRoots.set(name, base);
    }
  }
}
for (const [name, base] of [...bundledRoots].sort(([a], [b]) => a.localeCompare(b))) {
  const dir = resolvePackage(name, base);
  if (!dir) {
    missing.push(`${name} (imported by ${relative(ROOT, base).split(sep).join('/')})`);
    continue;
  }
  // Packages already shipped as runtime modules stay "runtime" (they are externalized, not bundled).
  record(dir, (desktopPkg.dependencies ?? {})[name] ? 'runtime' : 'bundled');
}

// 3. Build-injected helpers.
for (const { name } of INJECTED) {
  const dir = resolvePackage(name, DESKTOP);
  if (dir) record(dir, 'injected', { follow: false });
}

// 4. Electron.
const electronDir = resolvePackage('electron', DESKTOP);
if (electronDir) record(electronDir, 'electron', { follow: false });
else missing.push('electron');

/* ------------------------------------------------------------------ render */

const list = [...shipped.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version, undefined, { numeric: true }));
const VIA = { runtime: 'runtime module', bundled: 'bundled', injected: 'build helper', electron: 'Electron runtime' };
const viaLabel = (r) => [...r.via].sort().map((v) => VIA[v]).join(', ');
const esc = (s) => String(s).replace(/\|/g, '\\|');

let md = '';
md += '# Third-party notices\n\n';
md += 'oIDE is MIT licensed (see [LICENSE](LICENSE)). Packaged builds of oIDE include the third-party software\n';
md += 'listed below. Each is used under the licence shown; the full licence and notice texts follow the table.\n\n';
md += 'Electron ships its own notices for Chromium, Node.js and their dependencies as `LICENSES.chromium.html`\n';
md += 'next to the oIDE executable.\n\n';
md += 'This file is generated by `pnpm licenses:notices` (`tools/licenses/notices.mjs`); do not edit it by hand.\n';
md += '`pnpm licenses:check` fails CI when it is stale or when a shipped licence is not MIT-compatible.\n\n';
md += `${list.length} packages.\n\n`;
if (platformFamilies.size) {
  md += 'Native modules also ship one prebuilt binary package for the target OS and CPU. Those packages are\n';
  md += 'published from the same repository under the same licence as their parent and are not listed one by one:\n\n';
  for (const f of [...platformFamilies.values()].sort((a, b) => a.parent.localeCompare(b.parent))) {
    md += `- \`${f.parent}-<platform>\` (${f.license}): ${[...f.variants].sort().map((v) => `\`${v.slice(f.parent.length + 1)}\``).join(', ')}\n`;
  }
  md += '\n';
}
md += '| Package | Version | Licence | Shipped as |\n| --- | --- | --- | --- |\n';
for (const r of list) {
  const name = r.repo && /^https?:\/\//.test(r.repo) ? `[${esc(r.name)}](${r.repo})` : esc(r.name);
  md += `| ${name} | ${esc(r.version)} | ${esc(r.license)}${r.detected ? ' (from licence file)' : ''} | ${viaLabel(r)} |\n`;
}
md += '\n---\n';
for (const r of list) {
  md += `\n## ${r.name} ${r.version}\n\n`;
  md += `Licence: ${r.license}${r.repo ? ` · ${r.repo}` : ''}\n\n`;
  if (r.texts.length === 0) {
    md += `_No licence file is included in the published package. The package declares the ${r.license} licence._\n`;
    continue;
  }
  for (const t of r.texts) {
    if (r.texts.length > 1) md += `### ${t.file}\n\n`;
    const fence = t.text.includes('```') ? '~~~~' : '```';
    md += `${fence}text\n${t.text}\n${fence}\n\n`;
  }
}
md = md.replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';

/* ------------------------------------------------------------------ output */

const problems = [...list, ...platformChecked].filter((r) => !isAllowed(r.license));
for (const f of platformFamilies.values()) if (!isAllowed(f.license)) problems.push({ name: `${f.parent}-<platform>`, version: '*', license: f.license ?? 'UNKNOWN', via: new Set(['runtime']) });

if (CHECK) {
  let failed = false;
  if (problems.length) {
    failed = true;
    console.error('Shipped packages whose licence is not on the MIT-compatible allow-list:');
    for (const r of problems) console.error(`  ${r.name}@${r.version}: ${r.license} (${viaLabel(r)})`);
  }
  if (missing.length) {
    failed = true;
    console.error('Packages that could not be resolved from node_modules:');
    for (const m of missing) console.error(`  ${m}`);
  }
  const current = existsSync(OUT_FILE) ? readFileSync(OUT_FILE, 'utf8').replace(/\r\n/g, '\n') : '';
  if (current !== md) {
    failed = true;
    console.error('THIRD_PARTY_NOTICES.md is stale. Run `pnpm licenses:notices` and commit the result.');
  }
  if (failed) process.exit(1);
  console.log(`Licences OK: ${list.length} shipped packages, all MIT-compatible; THIRD_PARTY_NOTICES.md is current.`);
} else {
  writeFileSync(OUT_FILE, md);
  console.log(`Wrote THIRD_PARTY_NOTICES.md (${list.length} packages).`);
  for (const r of problems) console.warn(`  not MIT-compatible or unknown: ${r.name}@${r.version}: ${r.license}`);
  for (const m of missing) console.warn(`  unresolved: ${m}`);
}
