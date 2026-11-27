#!/usr/bin/env node
// Wiki lint: broken relative links, pages missing from index.md, orphan pages, and log entries
// (one file per entry in log/, nothing appended to the frozen log.md).
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { wikiRoot as root, logDir, entryFiles, checkEntry } from './wiki-log.mjs';

const pagesDir = join(root, 'pages');
const logFiles = existsSync(logDir) ? readdirSync(logDir).filter((f) => f.endsWith('.md')).map((f) => join(logDir, f)) : [];
const files = [join(root, 'index.md'), join(root, 'log.md'), ...logFiles, ...readdirSync(pagesDir).filter((f) => f.endsWith('.md')).map((f) => join(pagesDir, f))];
const problems = [];
const linkedPages = new Set();
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  for (const m of text.matchAll(/\]\(([^)#\s]+)(#[^)]*)?\)/g)) {
    const target = m[1];
    if (/^[a-z]+:/i.test(target)) continue;
    const abs = resolve(dirname(file), decodeURIComponent(target));
    if (!existsSync(abs)) problems.push(`${relative(root, file)}: broken link → ${target}`);
    else if (abs.startsWith(pagesDir) && statSync(abs).isFile() && file !== abs) linkedPages.add(abs);
  }
}
const index = readFileSync(join(root, 'index.md'), 'utf8');
for (const f of readdirSync(pagesDir).filter((f) => f.endsWith('.md'))) {
  if (!index.includes(`pages/${f}`)) problems.push(`index.md: missing entry for pages/${f}`);
  if (!linkedPages.has(join(pagesDir, f))) problems.push(`pages/${f}: orphan (nothing links to it)`);
}
const missing = [...index.matchAll(/\]\((pages\/[^)]+)\)/g)].map((m) => m[1]).filter((p) => !existsSync(join(root, p)));
for (const p of missing) problems.push(`index.md: lists ${p} but the page does not exist yet`);

// log.md is a frozen archive. Its last entry is fixed here rather than marked in the file, so a
// branch that predates log/ and appended to log.md still merges main cleanly; this check then asks
// it to move the entry to its own file (pnpm wiki:log new <op> "<title>").
const LAST_ARCHIVED = '## [2026-11-27] build | Windows: installed oIDE showed a blank taskbar icon';
const archive = readFileSync(join(root, 'log.md'), 'utf8').split(/\r?\n/);
const last = archive.lastIndexOf(LAST_ARCHIVED);
if (last < 0) problems.push(`log.md: the archive's last entry is missing (${LAST_ARCHIVED})`);
for (const line of archive.slice(last + 1).filter((l) => l.startsWith('## ['))) {
  problems.push(`log.md: "${line}" was appended to the frozen archive; move it to its own file in log/ (pnpm wiki:log new <op> "<title>")`);
}
for (const f of entryFiles()) {
  for (const p of checkEntry(f, readFileSync(join(logDir, f), 'utf8'))) problems.push(`log/${f}: ${p}`);
}

if (problems.length) { console.log(problems.join('\n')); console.log(`\n${problems.length} wiki problem(s).`); process.exit(1); }
console.log('wiki: ok');
