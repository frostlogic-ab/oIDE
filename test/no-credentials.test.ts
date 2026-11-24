import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Hard rule 3 (CLAUDE.md): no code may touch Claude credentials. This test fails the build if a
 * known credential location appears anywhere in source under apps/, packages/, extensions/ or
 * tools/. Docs (docs/, *.md) may mention them; code may not, not even to "avoid" them: the agent
 * env is built from an allow-list, so no code needs these names.
 */

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const SCAN = ['apps', 'packages', 'extensions', 'tools'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'out', 'build', 'release', '.git', '.turbo', '.vite', 'coverage', 'docs']);
const EXTS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json', '.html', '.css', '.sh', '.ps1', '.cmd', '.bat', '.py', '.yml', '.yaml', '.toml']);
const SELF = fileURLToPath(import.meta.url);
const MAX_BYTES = 4 * 1024 * 1024;

// Built from parts so the patterns themselves never look like a real path in a grep.
const DOT = '\\.';
export const CREDENTIAL_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'CLI credentials file', re: new RegExp(DOT + 'credentials' + DOT + 'json', 'i') },
  { name: 'macOS keychain item for Claude Code', re: new RegExp('Claude Code' + '-credentials', 'i') },
  { name: 'OAuth block inside the credentials file', re: new RegExp('claude' + 'Ai' + 'Oauth', 'i') },
  { name: 'keychain lookup for Claude', re: new RegExp('find-generic-' + 'password[^\\n]*claude', 'i') },
  { name: 'path into the CLI config folder credentials', re: new RegExp('[\\\\/]' + DOT + 'claude[\\\\/][^\\n\'"`]*credential', 'i') },
];

function* walk(dir: string): Generator<string> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) yield* walk(join(dir, e.name));
    } else if (e.isFile() && EXTS.has(extname(e.name).toLowerCase())) {
      yield join(dir, e.name);
    }
  }
}

export function findCredentialReferences(text: string): string[] {
  return CREDENTIAL_PATTERNS.filter((p) => p.re.test(text)).map((p) => p.name);
}

describe('no Claude credentials in source', () => {
  it('detects each known credential location (self-check)', () => {
    const samples = [
      ['~', '.claude', '.credentials' + '.json'].join('/'),
      'security find-generic-' + 'password -s "Claude Code' + '-credentials"',
      '{ "claude' + 'AiOauth": {} }',
    ];
    for (const s of samples) expect(findCredentialReferences(s).length, s).toBeGreaterThan(0);
    expect(findCredentialReferences('const home = os.homedir(); // ~/.claude.json is the CLI config')).toEqual([]);
  });

  it('finds none under apps/, packages/, extensions/ and tools/', () => {
    const hits: string[] = [];
    let scanned = 0;
    for (const top of SCAN) {
      for (const file of walk(join(ROOT, top))) {
        if (file === SELF) continue;
        if (statSync(file).size > MAX_BYTES) continue;
        scanned++;
        const text = readFileSync(file, 'utf8');
        for (const name of findCredentialReferences(text)) hits.push(`${relative(ROOT, file).split(sep).join('/')}: ${name}`);
      }
    }
    expect(scanned).toBeGreaterThan(0);
    expect(hits, `Credential locations found in source (CLAUDE.md hard rule 3):\n${hits.join('\n')}`).toEqual([]);
  });
});
