// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderMarkdown } from '../../lib/markdown';
import { MarkdownPreview } from './MarkdownPreview';

const invokeOr = vi.fn((..._args: unknown[]) => Promise.resolve({ ok: true }));
vi.mock('../../lib/bridge', () => ({ invokeOr: (...args: unknown[]) => invokeOr(...args) }));

afterEach(() => {
  cleanup();
  invokeOr.mockClear();
});

const SOURCE = `---
title: hidden
---
# Guide

See [the setup](./setup.md#run), [the site](https://example.com), [up](#guide) and [bad](javascript:alert(1)).

- [x] done
- [ ] todo

<script>alert(1)</script><img src="x" onerror="alert(1)">
`;

describe('renderMarkdown', () => {
  it('drops front matter, scripts and handlers, and draws task boxes', () => {
    const html = renderMarkdown(SOURCE);
    expect(html).not.toContain('title: hidden');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('onerror');
    expect(html).not.toContain('<input');
    expect(html).toContain('class="oide-md-task oide-md-task-done" role="img" aria-label="Done"');
    expect(html).toContain('aria-label="Not done"');
  });
});

describe('MarkdownPreview', () => {
  it('renders the page and routes link clicks without navigating', () => {
    const onOpenFile = vi.fn();
    render(<MarkdownPreview source={SOURCE} path="docs/index.md" onOpenFile={onOpenFile} />);
    const page = screen.getByRole('article', { name: 'Preview of index.md' });
    expect(page.querySelector('h1')?.textContent).toBe('Guide');

    fireEvent.click(screen.getByRole('link', { name: 'the setup' }));
    expect(onOpenFile).toHaveBeenCalledWith('docs/setup.md');

    fireEvent.click(screen.getByRole('link', { name: 'the site' }));
    expect(invokeOr).toHaveBeenCalledWith('shell.openExternal', { url: 'https://example.com' }, { ok: true });

    const scroll = vi.fn();
    (page.querySelector('h1') as HTMLElement).scrollIntoView = scroll;
    fireEvent.click(screen.getByRole('link', { name: 'up' }));
    expect(scroll).toHaveBeenCalled();

    const bad = screen.queryByRole('link', { name: 'bad' });
    if (bad) {
      const ev = fireEvent.click(bad);
      expect(ev).toBe(false); // default prevented
    }
    expect(onOpenFile).toHaveBeenCalledTimes(1);
    expect(invokeOr).toHaveBeenCalledTimes(1);
  });
});
