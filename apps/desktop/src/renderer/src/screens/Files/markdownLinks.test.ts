import { describe, expect, it } from 'vitest';
import { headingSlug, isMarkdownPath, resolveMarkdownLink } from './markdownLinks';

describe('isMarkdownPath', () => {
  it('matches Markdown extensions in any case, not MDX or other files', () => {
    expect(isMarkdownPath('README.md')).toBe(true);
    expect(isMarkdownPath('docs/Guide.MARKDOWN')).toBe(true);
    expect(isMarkdownPath('notes.mkd')).toBe(true);
    expect(isMarkdownPath('page.mdx')).toBe(false);
    expect(isMarkdownPath('src/md.ts')).toBe(false);
    expect(isMarkdownPath('md')).toBe(false);
  });
});

describe('resolveMarkdownLink', () => {
  it('opens https in the browser and refuses other schemes', () => {
    expect(resolveMarkdownLink('a.md', 'https://example.com/x')).toEqual({ kind: 'external', url: 'https://example.com/x' });
    for (const href of ['http://example.com', 'mailto:a@b.c', 'javascript:alert(1)', 'file:///etc/passwd', '//cdn.example.com/x', '', '#']) {
      expect(resolveMarkdownLink('a.md', href)).toBeNull();
    }
  });

  it('resolves headings on the page', () => {
    expect(resolveMarkdownLink('docs/a.md', '#install-it')).toEqual({ kind: 'anchor', id: 'install-it' });
    expect(resolveMarkdownLink('docs/a.md', '?x=1#top')).toEqual({ kind: 'anchor', id: 'top' });
  });

  it('resolves files against the folder of the page, or the checkout root for /', () => {
    expect(resolveMarkdownLink('docs/wiki/index.md', 'pages/screen-files.md')).toEqual({ kind: 'file', path: 'docs/wiki/pages/screen-files.md' });
    expect(resolveMarkdownLink('docs/wiki/index.md', './pages/a.md#layout')).toEqual({ kind: 'file', path: 'docs/wiki/pages/a.md', anchor: 'layout' });
    expect(resolveMarkdownLink('docs/wiki/pages/a.md', '../../adr/0001%20store.md')).toEqual({ kind: 'file', path: 'docs/adr/0001 store.md' });
    expect(resolveMarkdownLink('docs/a.md', '/CLAUDE.md')).toEqual({ kind: 'file', path: 'CLAUDE.md' });
    expect(resolveMarkdownLink('README.md', 'src\\index.ts?raw')).toEqual({ kind: 'file', path: 'src/index.ts' });
  });

  it('never leaves the checkout', () => {
    expect(resolveMarkdownLink('README.md', '../secret.md')).toBeNull();
    expect(resolveMarkdownLink('docs/a.md', '../../x.md')).toBeNull();
    expect(resolveMarkdownLink('docs/a.md', '..')).toBeNull();
  });
});

describe('headingSlug', () => {
  it('follows the GitHub style', () => {
    expect(headingSlug('Install it!')).toBe('install-it');
    expect(headingSlug(' Files: the `tree` ')).toBe('files-the-tree');
    expect(headingSlug('Ünïcode 2 go')).toBe('ünïcode-2-go');
  });
});
