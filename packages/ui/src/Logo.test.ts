import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Logo } from './Logo.js';
import { LOGO_SHAPES } from './logoGeometry.js';

const html = (props: Parameters<typeof Logo>[0]) => renderToStaticMarkup(createElement(Logo, props));

describe('Logo', () => {
  it('draws the small geometry at 32 px and below, the full one above', () => {
    expect(html({ size: 20 })).toContain(LOGO_SHAPES.small.ring);
    expect(html({ size: 64 })).toContain(LOGO_SHAPES.full.ring);
  });

  it('uses fixed brand colours, not the accent variable', () => {
    const out = html({ size: 20 });
    expect(out).toContain('#7AA2F7');
    expect(out).not.toContain('--color-accent');
  });

  it('is decorative unless titled, and the wordmark carries the name as text', () => {
    expect(html({})).toContain('aria-hidden="true"');
    expect(html({ title: 'oIDE' })).toContain('aria-label="oIDE"');
    expect(html({ variant: 'wordmark' })).toMatch(/<span>oIDE<\/span>/);
  });

  it('mono draws in currentColor', () => {
    expect(html({ tone: 'mono' })).toContain('fill="currentColor"');
  });

  it('never names Claude (CLAUDE.md rule 5)', () => {
    expect(html({ variant: 'wordmark', title: 'oIDE' }).toLowerCase()).not.toContain('claude');
  });
});
