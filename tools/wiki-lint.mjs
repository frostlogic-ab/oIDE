#!/usr/bin/env node
// Wiki lint: broken relative links, pages missing from index.md, orphan pages.
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';

const root = resolve(dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '..', 'docs', 'wiki');
const pagesDir = join(root, 'pages');
const files = [join(root, 'index.md'), join(root, 'log.md'), ...readdirSync(pagesDir).filter((f) => f.endsWith('.md')).map((f) => join(pagesDir, f))];
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
if (problems.length) { console.log(problems.join('\n')); console.log(`\n${problems.length} wiki problem(s).`); process.exit(1); }
console.log('wiki: ok');
