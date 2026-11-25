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
  });

  it('infers the kind of pasted content', () => {
    expect(inferKindFromContent('<!doctype html><p>x</p>')).toBe('design');
    expect(inferKindFromContent(JSON.stringify({ type: 'excalidraw', elements: [] }))).toBe('whiteboard');
    expect(inferKindFromContent('{"type":"other"}')).toBe('doc');
    expect(inferKindFromContent('{ not json')).toBe('doc');
    expect(inferKindFromContent('# Plan')).toBe('doc');
  });

  it('takes a title from <title>, <h1> or a Markdown heading', () => {
    expect(titleFromContent('design', '<title> Pricing &amp; plans </title>')).toBe('Pricing & plans');
    expect(titleFromContent('design', '<body><h1 class="x">Checkout</h1></body>')).toBe('Checkout');
    expect(titleFromContent('design', '<body></body>')).toBeUndefined();
    expect(titleFromContent('doc', '---\ntitle: x\n---\n\n# Launch   plan ##\n')).toBe('Launch plan');
    expect(titleFromContent('doc', 'No heading')).toBeUndefined();
    expect(titleFromContent('whiteboard', '# x')).toBeUndefined();
    expect(titleFromContent('doc', `# ${'a'.repeat(300)}`)?.length).toBe(200);
  });
});
