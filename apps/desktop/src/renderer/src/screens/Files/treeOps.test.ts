import { describe, expect, it } from 'vitest';
import { baseName, isUnder, parentDir, remapPath, stemLength, validateName } from './treeOps';

describe('treeOps', () => {
  it('path helpers', () => {
    expect(parentDir('src/a/b.ts')).toBe('src/a');
    expect(parentDir('b.ts')).toBe('');
    expect(baseName('src/a/b.ts')).toBe('b.ts');
    expect(isUnder('src/a/b.ts', 'src/a')).toBe(true);
    expect(isUnder('src/ab.ts', 'src/a')).toBe(false);
    expect(remapPath('src/a/b.ts', 'src/a', 'lib')).toBe('lib/b.ts');
    expect(remapPath('src/ab.ts', 'src/a', 'lib')).toBe('src/ab.ts');
  });

  it('selects the stem of a file name and all of a folder name', () => {
    expect(stemLength('index.test.ts', 'file')).toBe(10);
    expect(stemLength('.env', 'file')).toBe(4);
    expect(stemLength('Makefile', 'file')).toBe(8);
    expect(stemLength('v1.2', 'dir')).toBe(4);
  });

  it('validates new names', () => {
    const siblings = ['index.ts', 'README.md'];
    expect(validateName('util.ts', siblings)).toBeUndefined();
    expect(validateName('utils/helpers.ts', siblings)).toBeUndefined();
    expect(validateName('utils\\helpers.ts', siblings)).toBeUndefined();
    expect(validateName('', siblings)).toMatch(/must be provided/);
    expect(validateName('  ', siblings)).toMatch(/must be provided/);
    expect(validateName(' a.ts', siblings)).toMatch(/whitespace/);
    expect(validateName('/a.ts', siblings)).toMatch(/slash/);
    expect(validateName('a//b.ts', siblings)).toMatch(/empty folder/);
    expect(validateName('a/', siblings)).toMatch(/must be provided/);
    expect(validateName('../a.ts', siblings)).toMatch(/not valid/);
    expect(validateName('.git', siblings)).toMatch(/managed by git/);
    expect(validateName('a:b.ts', siblings)).toMatch(/not allowed/);
    expect(validateName('con.txt', siblings)).toMatch(/reserved/);
    expect(validateName('a.', siblings)).toMatch(/end with a dot/);
    expect(validateName('readme.md', siblings)).toMatch(/readme\.md already exists/);
    expect(validateName('index.ts/x.ts', siblings)).toMatch(/already exists/);
  });

  it('a rename may keep its own name in another case', () => {
    expect(validateName('Readme.md', ['index.ts', 'README.md'], 'README.md')).toBeUndefined();
    expect(validateName('index.ts', ['index.ts', 'README.md'], 'README.md')).toMatch(/already exists/);
  });
});
