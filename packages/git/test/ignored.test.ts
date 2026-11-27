import { afterAll, describe, expect, it } from 'vitest';
import { ignoredPaths } from '../src/ignored.js';
import { cleanup, makeRepo, sh, tempDir, write } from './helpers.js';

afterAll(cleanup);

describe('ignoredPaths', () => {
  it('reports ignored files and folders, their contents, and never tracked files', async () => {
    const repo = makeRepo({
      '.gitignore': 'dist/\n*.log\nbuild\n',
      'kept.log': 'tracked\n',
      'src/a.ts': 'a\n',
    });
    sh(repo, 'add', '-f', 'kept.log');
    sh(repo, 'commit', '-q', '-m', 'track a log');
    write(repo, 'dist/a.js', 'x\n');
    write(repo, 'dist/sub/b.js', 'x\n');
    write(repo, 'build/out.txt', 'x\n');
    write(repo, 'src/debug.log', 'x\n');
    write(repo, 'info.txt', 'x\n');
    sh(repo, 'config', 'core.excludesFile', '');
    write(repo, '.git/info/exclude', 'info.txt\n');

    const got = await ignoredPaths(repo, [
      'dist',
      'dist/sub/b.js',
      'build',
      'src',
      'src/a.ts',
      'src/debug.log',
      'kept.log',
      'info.txt',
      '.gitignore',
    ]);
    expect([...got].sort()).toEqual(['build', 'dist', 'dist/sub/b.js', 'info.txt', 'src/debug.log']);
  });

  it('is empty when nothing matches, for no paths, and outside a git checkout', async () => {
    const repo = makeRepo({ 'README.md': '# r\n' });
    expect((await ignoredPaths(repo, ['README.md'])).size).toBe(0);
    expect((await ignoredPaths(repo, [])).size).toBe(0);
    const plain = tempDir('oide-plain-');
    write(plain, 'a.txt', 'a\n');
    expect((await ignoredPaths(plain, ['a.txt'])).size).toBe(0);
  });

  it('does not crash when git exits before reading a large stdin (EPIPE)', async () => {
    // Outside a checkout git exits at once; a payload larger than the pipe buffer makes the
    // write fail with EPIPE, which used to surface as an uncaught exception.
    const plain = tempDir('oide-plain-');
    const many = Array.from({ length: 50_000 }, (_, i) => `some/fairly/long/path/segment/file-${i}.txt`);
    expect((await ignoredPaths(plain, many)).size).toBe(0);
  });
});
