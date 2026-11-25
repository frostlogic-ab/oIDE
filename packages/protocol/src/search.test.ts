import { describe, expect, it } from 'vitest';
import {
  applyReplacements,
  buildSearchRegExp,
  expandReplacement,
  findMatches,
  globToRegExp,
  parseQuickOpenQuery,
  pathFilter,
  scorePath,
  splitLines,
  SearchContentInput,
} from './search.js';

const rank = (query: string, paths: string[]) =>
  paths
    .map((p) => ({ p, s: scorePath(query, p) }))
    .filter((x) => x.s)
    .sort((a, b) => b.s!.score - a.s!.score)
    .map((x) => x.p);

describe('quick open fuzzy ranking', () => {
  it('ranks by file name: exact > stem > prefix > substring > subsequence > folders only', () => {
    const paths = [
      'src/status/bar/helpers.ts', // only matches across folders
      'src/shell/SessionStatusBar.tsx', // substring in the name
      'src/shell/StatusBar.tsx', // stem match
      'docs/statusbar', // exact name
      'src/shell/StatusBarItem.tsx', // prefix
      'src/s/t/a/t/u/s/b/a/r.ts', // path subsequence
      'src/shell/SBar.tsx', // no match
    ];
    expect(rank('statusbar', paths)).toEqual([
      'docs/statusbar',
      'src/shell/StatusBar.tsx',
      'src/shell/StatusBarItem.tsx',
      'src/shell/SessionStatusBar.tsx',
      'src/status/bar/helpers.ts',
      'src/s/t/a/t/u/s/b/a/r.ts',
    ]);
  });

  it('prefers the file name over folder hits and shorter paths on ties', () => {
    expect(rank('store', ['src/store/index.ts', 'src/screens/Files/filesStore.ts'])[0]).toBe('src/screens/Files/filesStore.ts');
    expect(rank('index', ['a/b/c/d/index.ts', 'a/index.ts'])).toEqual(['a/index.ts', 'a/b/c/d/index.ts']);
    // camelCase / word starts in the name: "fs" → filesStore before a random subsequence
    expect(rank('flst', ['src/fileList.ts', 'src/a/f/l/s/t.ts'])[0]).toBe('src/fileList.ts');
  });

  it('matches every space-separated term, case-insensitively, with highlight positions', () => {
    const s = scorePath('files store', 'src/screens/Files/filesStore.ts')!;
    expect(s).not.toBeNull();
    expect(scorePath('files nope', 'src/screens/Files/filesStore.ts')).toBeNull();
    const t = scorePath('bar', 'src/shell/StatusBar.tsx')!;
    expect(t.positions.map((i) => 'src/shell/StatusBar.tsx'[i]).join('')).toBe('Bar');
    // the end of the query lands in the file name
    const u = scorePath('shst', 'src/shell/StatusBar.tsx')!;
    expect(u.positions.every((i) => i >= 0 && i < 23)).toBe(true);
  });

  it('parses "name:line" and "name:line:col"', () => {
    expect(parseQuickOpenQuery('retry.ts:42')).toEqual({ query: 'retry.ts', line: 42 });
    expect(parseQuickOpenQuery('retry.ts:42:7')).toEqual({ query: 'retry.ts', line: 42, column: 7 });
    expect(parseQuickOpenQuery('retry.ts')).toEqual({ query: 'retry.ts' });
    expect(parseQuickOpenQuery(':42')).toEqual({ query: ':42' });
  });
});

describe('search regex', () => {
  it('escapes literal text and applies case and whole word', () => {
    expect(findMatches('a.c abc A.C', buildSearchRegExp({ query: 'a.c', isRegex: false, matchCase: false, wholeWord: false })).map((m) => m.text)).toEqual(['a.c', 'A.C']);
    expect(findMatches('a.c abc', buildSearchRegExp({ query: 'a.c', isRegex: true, matchCase: true, wholeWord: false })).map((m) => m.text)).toEqual(['a.c', 'abc']);
    expect(findMatches('retry retryAll pre_retry', buildSearchRegExp({ query: 'retry', isRegex: false, matchCase: true, wholeWord: true })).map((m) => m.column)).toEqual([0]);
    // a query that starts with punctuation still matches as a whole word
    expect(findMatches('x --force y', buildSearchRegExp({ query: '--force', isRegex: false, matchCase: true, wholeWord: true }))).toHaveLength(1);
    expect(() => buildSearchRegExp({ query: '(', isRegex: true, matchCase: false, wholeWord: false })).toThrow(SyntaxError);
  });

  it('reports 1-based lines and 0-based columns without line terminators, skipping empty matches', () => {
    const ms = findMatches('one\r\ntwo two\n\nthree', buildSearchRegExp({ query: 'two|^', isRegex: true, matchCase: false, wholeWord: false }));
    expect(ms.map((m) => [m.line, m.column, m.text])).toEqual([
      [2, 0, 'two'],
      [2, 4, 'two'],
    ]);
    expect(splitLines('a\r\nb\n').map((l) => l.text)).toEqual(['a', 'b']);
  });

  it('cuts long-line previews around the match', () => {
    const line = `${'x'.repeat(500)}NEEDLE${'y'.repeat(500)}`;
    const [m] = findMatches(line, buildSearchRegExp({ query: 'needle', isRegex: false, matchCase: false, wholeWord: false }));
    expect(m!.preview.length).toBeLessThan(300);
    expect(m!.preview.slice(m!.column - m!.previewStart, m!.column - m!.previewStart + 6)).toBe('NEEDLE');
  });

  it('rejects multi-line and empty queries at the IPC boundary', () => {
    const base = { searchId: 's1', roots: ['/r'] };
    expect(SearchContentInput.safeParse({ ...base, query: 'a\nb' }).success).toBe(false);
    expect(SearchContentInput.safeParse({ ...base, query: '' }).success).toBe(false);
    expect(SearchContentInput.safeParse({ ...base, query: '-e' }).success).toBe(true);
  });
});

describe('replace', () => {
  const opts = (query: string, isRegex = false) => ({ query, isRegex, matchCase: true, wholeWord: false });

  it('replaces exactly the given matches and keeps CRLF', () => {
    const text = 'foo foo\r\nbar foo\r\n';
    const all = findMatches(text, buildSearchRegExp(opts('foo')));
    const r = applyReplacements(text, opts('foo'), 'baz', [all[1]!, all[2]!]);
    expect(r).toEqual({ content: 'foo baz\r\nbar baz\r\n', replaced: 2, missing: 0 });
  });

  it('expands $1, $<name>, $& and $$ for regexes', () => {
    const o = opts('(?<k>\\w+)=(\\d+)', true);
    const text = 'a=1 b=22';
    const ms = findMatches(text, buildSearchRegExp(o));
    expect(applyReplacements(text, o, '$2:$<k> [$&] $$', ms).content).toBe('1:a [a=1] $ 22:b [b=22] $');
    const m = /(x)(y)/.exec('xy')!;
    expect(expandReplacement('$1$2$3$10', m)).toBe('xy$3x0');
  });

  it('counts matches that moved and leaves them alone', () => {
    const r = applyReplacements('hello world', opts('world'), 'there', [{ line: 1, column: 0, length: 5, text: 'world' }]);
    expect(r).toEqual({ content: 'hello world', replaced: 0, missing: 1 });
  });
});

describe('include / exclude globs', () => {
  it('matches names at any depth and anchored paths, folders cover their contents', () => {
    expect(globToRegExp('*.ts').test('src/a/b.ts')).toBe(true);
    expect(globToRegExp('*.ts').test('src/a/b.tsx')).toBe(false);
    expect(globToRegExp('node_modules').test('a/node_modules/x/y.js')).toBe(true);
    expect(globToRegExp('src/**').test('src/a/b.ts')).toBe(true);
    expect(globToRegExp('src/**').test('lib/src/a.ts')).toBe(false);
    expect(globToRegExp('./docs').test('docs/x.md')).toBe(true);
    expect(globToRegExp('**/*.{ts,tsx}').test('a/b.tsx')).toBe(true);
    expect(globToRegExp('[!a]*.md').test('b.md')).toBe(true);
    const keep = pathFilter('src/**, *.md', 'dist, **/*.test.ts');
    expect(['src/a.ts', 'README.md', 'src/a.test.ts', 'src/dist/x.ts', 'lib/x.ts'].filter(keep)).toEqual(['src/a.ts', 'README.md']);
    expect(pathFilter('', '')('anything')).toBe(true);
  });
});
