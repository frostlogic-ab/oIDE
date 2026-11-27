import { describe, expect, it } from 'vitest';
import { tabLabels } from './tabLabels';

const tab = (path: string, context = 'oide') => ({ id: `${context}::${path}`, path, context });
const labels = (...tabs: ReturnType<typeof tab>[]) => tabs.map((t) => tabLabels(tabs).get(t.id));

describe('tabLabels', () => {
  it('shows only the file name when names are unique', () => {
    expect(labels(tab('src/a.ts'), tab('src/b.ts'))).toEqual([{ name: 'a.ts' }, { name: 'b.ts' }]);
  });

  it('adds the shortest differing folder when names clash', () => {
    expect(labels(tab('apps/web/src/index.ts'), tab('apps/api/src/index.ts'), tab('lib/x.ts'))).toEqual([
      { name: 'index.ts', hint: '…/web/src' },
      { name: 'index.ts', hint: '…/api/src' },
      { name: 'x.ts' },
    ]);
    expect(labels(tab('a/index.ts'), tab('b/index.ts'))).toEqual([
      { name: 'index.ts', hint: 'a' },
      { name: 'index.ts', hint: 'b' },
    ]);
  });

  it('handles a folder that is the end of another and files at the root', () => {
    expect(labels(tab('x/README.md'), tab('a/x/README.md'), tab('README.md'))).toEqual([
      { name: 'README.md', hint: 'x' },
      { name: 'README.md', hint: 'a/x' },
      { name: 'README.md', hint: '/' },
    ]);
  });

  it('adds the project or checkout when the same path is open in two places', () => {
    expect(labels(tab('src/a.ts', 'oide'), tab('src/a.ts', 'oide·fix-tabs'))).toEqual([
      { name: 'a.ts', hint: 'oide' },
      { name: 'a.ts', hint: 'oide·fix-tabs' },
    ]);
    expect(labels(tab('src/a.ts', 'oide'), tab('lib/a.ts', 'billing'))).toEqual([
      { name: 'a.ts', hint: 'oide › src' },
      { name: 'a.ts', hint: 'billing › lib' },
    ]);
  });
});
