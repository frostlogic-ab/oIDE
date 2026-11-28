import { describe, expect, it } from 'vitest';
import { bumpOf, compareVersions, findDependencies, hintFor, isPackageJson, parseSpec, parseVersion, upgradeGoal, type Version } from './dependencies';

const v = (s: string): Version => parseVersion(s)!;

describe('isPackageJson', () => {
  it('matches package.json files outside node_modules', () => {
    expect(isPackageJson('package.json')).toBe(true);
    expect(isPackageJson('apps/desktop/package.json')).toBe(true);
    expect(isPackageJson('node_modules/react/package.json')).toBe(false);
    expect(isPackageJson('package.json5')).toBe(false);
    expect(isPackageJson('my-package.json')).toBe(false);
  });
});

describe('findDependencies', () => {
  const text = [
    '{',
    '  "name": "x",',
    '  "version": "1.0.0",',
    '  "scripts": { "build": "tsc" },',
    '  "dependencies": {',
    '    "react": "^18.3.1",',
    '    "@scope/pkg": "~5.9"',
    '  },',
    '  "devDependencies": {',
    '    "typescript": "5.9.2", "vitest": "^3.0.0"',
    '  },',
    '  "pnpm": { "overrides": { "react": "18.0.0" } },',
    '  "nested": { "dependencies": { "no": "1.0.0" } }',
    '}',
  ].join('\n');

  it('lists the entries of the top-level sections with their positions', () => {
    const found = findDependencies(text);
    expect(found.map((d) => [d.section, d.name, d.spec, d.line])).toEqual([
      ['dependencies', 'react', '^18.3.1', 6],
      ['dependencies', '@scope/pkg', '~5.9', 7],
      ['devDependencies', 'typescript', '5.9.2', 10],
      ['devDependencies', 'vitest', '^3.0.0', 10],
    ]);
    const react = found[0]!;
    const line = text.split('\n')[5]!;
    expect(line.slice(react.startColumn - 1, react.endColumn - 1)).toBe('"^18.3.1"');
    const vitest = found[3]!;
    expect(text.split('\n')[9]!.slice(vitest.startColumn - 1, vitest.endColumn - 1)).toBe('"^3.0.0"');
  });

  it('works on a half-edited file (missing comma, comments, unterminated string)', () => {
    const broken = ['{', '  // deps', '  "dependencies": {', '    "a": "^1.0.0"', '    "b": "2.0.0",', '    "c": "^3', '  }', '}'].join('\n');
    expect(findDependencies(broken).map((d) => d.name)).toEqual(['a', 'b']);
  });

  it('decodes escapes and ignores non-string values', () => {
    const t = '{"dependencies": {"\\u0061": "1.0.0", "n": 1, "o": {"x": "1"}, "t": true}}';
    expect(findDependencies(t).map((d) => d.name)).toEqual(['a']);
  });

  it('terminates on odd characters', () => {
    expect(findDependencies('{\f "dependencies": / {"a": "1.0.0"}} ')).toHaveLength(1);
    expect(findDependencies('')).toEqual([]);
  });
});

describe('parseSpec', () => {
  it('reads plain registry versions and ranges', () => {
    expect(parseSpec('a', '^10.0.1')).toMatchObject({ lookup: 'a', prefix: '^', text: '10.0.1' });
    expect(parseSpec('a', '~5.9')).toMatchObject({ prefix: '~', text: '5.9.0' });
    expect(parseSpec('a', '2.0.0-alpha.21')).toMatchObject({ prefix: '', text: '2.0.0-alpha.21' });
    expect(parseSpec('a', '>=18')).toMatchObject({ prefix: '>=', text: '18.0.0' });
    expect(parseSpec('a', '5.x')).toMatchObject({ text: '5.0.0' });
    expect(parseSpec('a', 'v1.2.3')).toMatchObject({ prefix: '', text: '1.2.3' });
  });

  it('follows npm: aliases', () => {
    expect(parseSpec('react-18', 'npm:react@^18.2.0')).toMatchObject({ lookup: 'react', prefix: '^', text: '18.2.0' });
    expect(parseSpec('x', 'npm:@scope/pkg@1.0.0')).toMatchObject({ lookup: '@scope/pkg', text: '1.0.0' });
  });

  it('skips what has no latest to compare with', () => {
    for (const s of ['workspace:*', 'workspace:^1.0.0', 'file:../x', 'link:../x', 'catalog:', 'github:a/b', 'a/b', 'git+https://x/y.git', 'https://x/y.tgz', 'latest', 'next', '*', '', '^1 || ^2', '<2.0.0', '1.0.0 - 2.0.0', '^1.2-beta'])
      expect(parseSpec('a', s), s).toBeNull();
  });
});

describe('compareVersions', () => {
  it('orders by semver precedence', () => {
    const order = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0', '1.0.1', '1.1.0', '2.0.0'];
    for (let i = 0; i < order.length - 1; i++) {
      expect(compareVersions(v(order[i]!), v(order[i + 1]!)), `${order[i]} < ${order[i + 1]}`).toBeLessThan(0);
      expect(compareVersions(v(order[i + 1]!), v(order[i]!))).toBeGreaterThan(0);
    }
    expect(compareVersions(v('1.2.3'), v('1.2.3'))).toBe(0);
  });
});

describe('bumpOf', () => {
  it('names the size of the upgrade (0.x minors count as major)', () => {
    expect(bumpOf(v('1.2.3'), v('2.0.0'))).toBe('major');
    expect(bumpOf(v('1.2.3'), v('1.3.0'))).toBe('minor');
    expect(bumpOf(v('1.2.3'), v('1.2.4'))).toBe('patch');
    expect(bumpOf(v('0.2.3'), v('0.3.0'))).toBe('major');
    expect(bumpOf(v('0.0.3'), v('0.0.4'))).toBe('major');
    expect(bumpOf(v('2.0.0-alpha.1'), v('2.0.0-alpha.5'))).toBe('prerelease');
  });
});

describe('hintFor', () => {
  const tags = (latest: string, more: Record<string, string> = {}) => ({ latest, tags: { latest, ...more } });

  it('offers a newer latest', () => {
    expect(hintFor(parseSpec('a', '^5.3.0')!, tags('5.4.0'))).toEqual({ kind: 'update', version: '5.4.0', bump: 'minor' });
    expect(hintFor(parseSpec('a', '^10.0.1')!, tags('11.0.0'))).toEqual({ kind: 'update', version: '11.0.0', bump: 'major' });
  });

  it('says latest when nothing is newer', () => {
    expect(hintFor(parseSpec('a', '^5.4.0')!, tags('5.4.0'))).toEqual({ kind: 'latest', version: '5.4.0' });
    expect(hintFor(parseSpec('a', '^6.0.0')!, tags('5.4.0'))).toEqual({ kind: 'latest', version: '5.4.0' });
  });

  it('follows a prerelease channel ahead of latest', () => {
    const spec = parseSpec('vitepress', '2.0.0-alpha.21')!;
    expect(hintFor(spec, tags('1.6.4', { next: '2.0.0-alpha.25' }))).toEqual({ kind: 'update', version: '2.0.0-alpha.25', bump: 'prerelease' });
    expect(hintFor(spec, tags('1.6.4', { next: '2.0.0-alpha.21' }))).toEqual({ kind: 'latest', version: '2.0.0-alpha.21' });
    // Once the release is out, latest wins.
    expect(hintFor(spec, tags('2.0.0'))).toEqual({ kind: 'update', version: '2.0.0', bump: 'prerelease' });
  });
});

describe('upgradeGoal', () => {
  it('asks for the changelog, the update and the code changes', () => {
    const goal = upgradeGoal({ path: 'package.json', name: 'eslint', lookup: 'eslint', section: 'devDependencies', spec: '^9.0.0', to: '10.15.0', bump: 'major' });
    expect(goal).toContain('Upgrade the npm package `eslint` in package.json (devDependencies) from `^9.0.0` to 10.15.0.');
    expect(goal).toContain('major upgrade');
    expect(goal).toMatch(/changelog/i);
    expect(goal).toMatch(/typecheck, tests and lint/);
    const alias = upgradeGoal({ path: 'a/package.json', name: 'r18', lookup: 'react', section: 'dependencies', spec: 'npm:react@^18.0.0', to: '19.0.0', bump: 'major' });
    expect(alias).toContain('`r18` (an alias of `react`)');
  });
});
