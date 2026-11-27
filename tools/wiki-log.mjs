#!/usr/bin/env node
// Wiki log helpers. The log is the frozen archive docs/wiki/log.md plus one file per entry in
// docs/wiki/log/ (named YYYY-MM-DD-<slug>.md), so parallel branches add files instead of editing
// one shared file and never conflict.
//
//   pnpm wiki:log                          print the whole log, oldest first
//   pnpm wiki:log new <op> "<title>"       create today's entry file and print its path
import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const wikiRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'wiki');
export const logDir = join(wikiRoot, 'log');
export const OPS = ['ingest', 'build', 'decision', 'review', 'lint', 'query'];
export const ENTRY_FILE = /^(\d{4}-\d{2}-\d{2})-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;
export const ENTRY_HEADING = /^## \[(\d{4}-\d{2}-\d{2})\] ([a-z]+) \| \S.*$/;

/** Entry files in chronological order (the date prefix sorts them; same-day entries by slug). */
export function entryFiles() {
  if (!existsSync(logDir)) return [];
  return readdirSync(logDir)
    .filter((f) => f.endsWith('.md') && f !== 'README.md')
    .sort();
}

/** Problems with one entry file: its name, its single heading, and the op. */
export function checkEntry(name, text) {
  const problems = [];
  const fileMatch = ENTRY_FILE.exec(name);
  if (!fileMatch) problems.push('file name must be YYYY-MM-DD-<lowercase-slug>.md');
  const headings = text.split(/\r?\n/).filter((l) => l.startsWith('## '));
  if (headings.length !== 1) {
    problems.push(`needs exactly one "## [YYYY-MM-DD] <op> | <title>" heading, found ${headings.length}`);
    return problems;
  }
  const first = text.split(/\r?\n/).find((l) => l.trim() !== '');
  if (first !== headings[0]) problems.push('the heading must be the first line');
  const m = ENTRY_HEADING.exec(headings[0]);
  if (!m) return [...problems, 'heading must read "## [YYYY-MM-DD] <op> | <title>"'];
  if (!OPS.includes(m[2])) problems.push(`op "${m[2]}" is not one of ${OPS.join(', ')}`);
  if (fileMatch && fileMatch[1] !== m[1]) problems.push(`heading date ${m[1]} does not match file name date ${fileMatch[1]}`);
  return problems;
}

export function slugify(title) {
  return title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .split('-')
    .slice(0, 8)
    .join('-');
}

function printAll() {
  const parts = [readFileSync(join(wikiRoot, 'log.md'), 'utf8').trimEnd()];
  for (const f of entryFiles()) parts.push(readFileSync(join(logDir, f), 'utf8').trim());
  process.stdout.write(parts.join('\n\n') + '\n');
}

function createEntry(op, title) {
  if (!OPS.includes(op) || !title) {
    console.error(`usage: pnpm wiki:log new <${OPS.join('|')}> "<title>"`);
    process.exit(2);
  }
  const date = new Date().toISOString().slice(0, 10);
  const slug = slugify(title) || op;
  const body = `## [${date}] ${op} | ${title}\n\nTODO: what changed and why. Link the pages it touched as ../pages/<page>.md.\n`;
  // Create exclusively ('wx') and pick the next suffix on EEXIST: no separate exists-check to race.
  for (let n = 1; ; n++) {
    const file = join(logDir, `${date}-${slug}${n === 1 ? '' : `-${n}`}.md`);
    try {
      writeFileSync(file, body, { flag: 'wx' });
      console.log(relative(process.cwd(), file));
      return;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, op, ...rest] = process.argv.slice(2);
  if (!cmd) printAll();
  else if (cmd === 'new') createEntry(op, rest.join(' ').trim());
  else {
    console.error('usage: pnpm wiki:log [new <op> "<title>"]');
    process.exit(2);
  }
}
