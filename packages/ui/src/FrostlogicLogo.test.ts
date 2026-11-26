import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FROSTLOGIC_BLUE, FrostlogicLogo } from './FrostlogicLogo.js';

const html = (props: Parameters<typeof FrostlogicLogo>[0]) => renderToStaticMarkup(createElement(FrostlogicLogo, props));

describe('FrostlogicLogo', () => {
  it('is announced as "Frostlogic"', () => {
    expect(html({})).toContain('role="img"');
    expect(html({})).toContain('aria-label="Frostlogic"');
  });

  it('keeps the brand blue roof and draws the word in currentColor', () => {
    const out = html({});
    expect(out).toContain(`fill="${FROSTLOGIC_BLUE}"`);
    expect(out).toContain('fill="currentColor"');
  });

  it('scales width with height at the logo aspect ratio', () => {
    const out = html({ height: 10 });
    expect(out).toContain('height="10"');
    expect(out).toMatch(/width="55\.\d+"/);
  });
});
