import { describe, expect, it } from 'vitest';
import { inferKindFromContent, looksLikeHtml, titleFromContent } from './artifacts.js';

describe('artifact import helpers', () => {
  it('recognises HTML pages and fragments, not React source or prose', () => {
    expect(looksLikeHtml('<!DOCTYPE html><html></html>')).toBe(true);
    expect(looksLikeHtml('﻿  <html lang="en"><body></body></html>')).toBe(true);
    expect(looksLikeHtml('<!-- exported -->\n<!doctype html>')).toBe(true);
    expect(looksLikeHtml('<div class="card"><p>Hi</p></div>')).toBe(true);
    expect(looksLikeHtml('<svg viewBox="0 0 10 10"><rect/></svg>')).toBe(true);
    expect(looksLikeHtml('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"></svg>')).toBe(true);
    expect(looksLikeHtml("import React from 'react';\nexport default () => <div/>;")).toBe(false);
    expect(looksLikeHtml('# Heading\n\n<b>bold</b>')).toBe(false);
    expect(looksLikeHtml('a < b')).toBe(false);
    expect(looksLikeHtml('<notclosed')).toBe(false);
    expect(looksLikeHtml('<!-- a --> <!-- b -->\n<div>x</div>')).toBe(true);
    expect(looksLikeHtml('<!-- never closed <html>')).toBe(false);
    expect(looksLikeHtml('<!-- ' + 'x'.repeat(10_000) + ' -->\n<!doctype html>')).toBe(true);
  });

  it('stays fast on hostile input (many comments, huge tags)', () => {
    const t0 = performance.now();
    expect(looksLikeHtml('<!---->'.repeat(600) + 'x')).toBe(false);
    expect(looksLikeHtml('<!--' + '-->'.repeat(2000))).toBe(false);
    expect(looksLikeHtml('</' + 'a'.repeat(2_000_000))).toBe(false);
    expect(inferKindFromContent('<' + 'a'.repeat(2_000_000))).toBe('doc');
    expect(titleFromContent('design', '<title'.repeat(400_000))).toBeUndefined();
    expect(titleFromContent('doc', '# ' + ' '.repeat(200_000) + 'x'.repeat(500))).toBe('x'.repeat(200));
    expect(titleFromContent('doc', '---\ntitle:' + ' '.repeat(200_000) + '\n---\n')).toBeUndefined();
    expect(titleFromContent('doc', '---\n' + 'a\n'.repeat(500_000))).toBeUndefined();
    expect(performance.now() - t0).toBeLessThan(2000);
  });

  it('infers the kind of pasted content', () => {
    expect(inferKindFromContent('<!doctype html><p>x</p>')).toBe('design');
    expect(inferKindFromContent(JSON.stringify({ type: 'excalidraw', elements: [] }))).toBe('whiteboard');
    expect(inferKindFromContent('{"type":"other"}')).toBe('doc');
    expect(inferKindFromContent('{ not json')).toBe('doc');
    expect(inferKindFromContent('# Plan')).toBe('doc');
    // A README that opens with an HTML banner stays a doc; a full page with a # in a script is a design.
    expect(inferKindFromContent('<div align="center"><img src="x.png"/></div>\n\n# Project\n')).toBe('doc');
    expect(inferKindFromContent('<!doctype html><script>\n# not markdown\n</script>')).toBe('design');
    expect(inferKindFromContent('<?xml version="1.0"?>\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x.dtd">\n<svg></svg>')).toBe('design');
    expect(inferKindFromContent('﻿' + JSON.stringify({ type: 'excalidraw' }))).toBe('whiteboard');
  });

  it('takes a title from <title>, <h1> or a Markdown heading', () => {
    expect(titleFromContent('design', '<title> Pricing &amp; plans </title>')).toBe('Pricing & plans');
    expect(titleFromContent('design', '<body><h1 class="x">Checkout</h1></body>')).toBe('Checkout');
    expect(titleFromContent('design', '<body></body>')).toBeUndefined();
    expect(titleFromContent('doc', '---\nkind: doc\n---\n\n# Launch   plan ##\n')).toBe('Launch plan');
    expect(titleFromContent('doc', '---\ntitle: "From front matter"\n---\n\n# Heading\n')).toBe('From front matter');
    expect(titleFromContent('doc', '---\nno close\n# Real\n')).toBe('Real');
    expect(titleFromContent('doc', '```sh\n# a shell comment\n```\n\n# Setup\n')).toBe('Setup');
    expect(titleFromContent('doc', 'No heading')).toBeUndefined();
    expect(titleFromContent('whiteboard', '# x')).toBeUndefined();
    expect(titleFromContent('doc', `# ${'a'.repeat(300)}`)?.length).toBe(200);
  });
});
