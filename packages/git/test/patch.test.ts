import { describe, expect, it } from 'vitest';
import { parseHunks, parseUnifiedDiff, synthesizeAddedPatch, unquoteGitPath } from '../src/patch.js';

describe('parseUnifiedDiff', () => {
  it('parses modified, added, deleted and renamed files', () => {
    const text = [
      'diff --git a/src/a.ts b/src/a.ts',
      'index 1111111..2222222 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,3 +1,3 @@ function x() {',
      ' one',
      '-two',
      '+TWO',
      ' three',
      'diff --git a/new.txt b/new.txt',
      'new file mode 100644',
      'index 0000000..3333333',
      '--- /dev/null',
      '+++ b/new.txt',
      '@@ -0,0 +1,2 @@',
      '+hello',
      '+world',
      'diff --git a/old.txt b/old.txt',
      'deleted file mode 100644',
      'index 4444444..0000000',
      '--- a/old.txt',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-bye',
      'diff --git a/from.ts b/to.ts',
      'similarity index 90%',
      'rename from from.ts',
      'rename to to.ts',
      'index 5555555..6666666 100644',
      '--- a/from.ts',
      '+++ b/to.ts',
      '@@ -1,2 +1,2 @@',
      ' keep',
      '-x',
      '+y',
      '',
    ].join('\n');
    const files = parseUnifiedDiff(text);
    expect(files.map((f) => [f.path, f.status, f.additions, f.deletions])).toEqual([
      ['src/a.ts', 'modified', 1, 1],
      ['new.txt', 'added', 2, 0],
      ['old.txt', 'deleted', 0, 1],
      ['to.ts', 'renamed', 1, 1],
    ]);
    expect(files[3]!.oldPath).toBe('from.ts');
    expect(files[0]!.patch.startsWith('@@ -1,3 +1,3 @@ function x() {\n')).toBe(true);
    expect(files[2]!.path).toBe('old.txt');
  });

  it('does not mistake content lines that look like headers', () => {
    const text = [
      'diff --git a/x.md b/x.md',
      '--- a/x.md',
      '+++ b/x.md',
      '@@ -1,3 +1,3 @@',
      '--- a/fake',
      '+++ b/fake',
      '-diff --git a/q b/q',
      '+@@ -9 +9 @@',
      ' tail',
      '',
    ].join('\n');
    const [f] = parseUnifiedDiff(text);
    expect(f).toMatchObject({ path: 'x.md', additions: 2, deletions: 2 });
  });

  it('handles binary, mode-only, pure renames and quoted paths', () => {
    const text = [
      'diff --git a/img.png b/img.png',
      'index 1..2 100644',
      'Binary files a/img.png and b/img.png differ',
      'diff --git a/run.sh b/run.sh',
      'old mode 100644',
      'new mode 100755',
      'diff --git a/a b.txt b/c d.txt',
      'similarity index 100%',
      'rename from a b.txt',
      'rename to c d.txt',
      'diff --git "a/caf\\303\\251 \\"q\\".txt" "b/caf\\303\\251 \\"q\\".txt"',
      'new file mode 100644',
      'index 0000000..1',
      'GIT binary patch',
      'literal 3',
      'KcmZ>',
      '',
      'literal 0',
      'HcmV?d00001',
      '',
      'diff --git a/same name.txt b/same name.txt',
      '--- a/same name.txt\t',
      '+++ b/same name.txt\t',
      '@@ -1 +1 @@',
      '-a',
      '\\ No newline at end of file',
      '+b',
      '\\ No newline at end of file',
      '',
    ].join('\n');
    const files = parseUnifiedDiff(text);
    expect(files[0]).toMatchObject({ path: 'img.png', binary: true, status: 'modified' });
    expect(files[1]).toMatchObject({ path: 'run.sh', status: 'modified', additions: 0 });
    expect(files[2]).toMatchObject({ path: 'c d.txt', oldPath: 'a b.txt', status: 'renamed' });
    expect(files[3]).toMatchObject({ path: 'café "q".txt', binary: true, status: 'added' });
    expect(files[4]).toMatchObject({ path: 'same name.txt', additions: 1, deletions: 1 });
    expect(files[4]!.patch).toContain('\\ No newline at end of file');
    expect(files).toHaveLength(5);
  });

  it('treats a truncated hunk gracefully', () => {
    const files = parseUnifiedDiff('diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,5 +1,5 @@\n-a\n+b\ndiff --git a/y b/y\n--- a/y\n+++ b/y\n@@ -1 +1 @@\n-c\n+d\n');
    expect(files.map((f) => f.path)).toEqual(['x', 'y']);
    expect(files[1]).toMatchObject({ additions: 1, deletions: 1 });
  });

  it('parses plain diff -u without a git header', () => {
    const [f] = parseUnifiedDiff('--- a/z.txt\n+++ b/z.txt\n@@ -1 +1,2 @@\n z\n+zz\n');
    expect(f).toMatchObject({ path: 'z.txt', additions: 1, deletions: 0 });
  });

  it('keeps CRLF content but parses headers', () => {
    const [f] = parseUnifiedDiff('diff --git a/w.txt b/w.txt\r\n--- a/w.txt\r\n+++ b/w.txt\r\n@@ -1 +1 @@\r\n-x\r\n+y\r\n');
    expect(f).toMatchObject({ path: 'w.txt', additions: 1, deletions: 1 });
  });
});

describe('parseHunks', () => {
  it('numbers lines', () => {
    const hunks = parseHunks('@@ -10,3 +10,4 @@ fn\n a\n-b\n+B\n+C\n c\n\\ No newline at end of file\n');
    expect(hunks).toHaveLength(1);
    const h = hunks[0]!;
    expect(h).toMatchObject({ oldStart: 10, oldLines: 3, newStart: 10, newLines: 4, section: 'fn' });
    expect(h.lines.map((l) => [l.kind, l.oldLine, l.newLine])).toEqual([
      ['context', 10, 10],
      ['del', 11, undefined],
      ['add', undefined, 11],
      ['add', undefined, 12],
      ['context', 12, 13],
      ['no-newline', undefined, undefined],
    ]);
  });
});

describe('helpers', () => {
  it('unquotes git paths', () => {
    expect(unquoteGitPath('"a\\tb\\\\c\\303\\251"')).toBe('a\tb\\cé');
    expect(unquoteGitPath('plain')).toBe('plain');
  });
  it('synthesizes added patches', () => {
    expect(synthesizeAddedPatch('a\nb\n')).toEqual({ patch: '@@ -0,0 +1,2 @@\n+a\n+b\n', additions: 2 });
    expect(synthesizeAddedPatch('x')).toEqual({ patch: '@@ -0,0 +1 @@\n+x\n\\ No newline at end of file\n', additions: 1 });
    const round = parseUnifiedDiff('diff --git a/n b/n\nnew file mode 100644\n--- /dev/null\n+++ b/n\n' + synthesizeAddedPatch('1\n2\n3\n').patch);
    expect(round[0]).toMatchObject({ status: 'added', additions: 3 });
  });
});
