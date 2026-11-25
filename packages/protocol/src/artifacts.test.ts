import { describe, expect, it } from 'vitest';
import {
  classifyClaudeLink,
  designEntryFor,
  inferKindFromContent,
  isDesignContent,
  isEmptyOideBoard,
  isImportStubContent,
  isSafeArtifactPath,
  looksLikeHtml,
  looksLikeReact,
  titleFromContent,
} from './artifacts.js';
import { Commands } from './ipc.js';

describe('artifact import helpers', () => {
  it('recognises HTML pages and fragments, not React source or prose', () => {
    expect(looksLikeHtml('<!DOCTYPE html><html></html>')).toBe(true);
    expect(looksLikeHtml('﻿  <html lang="en"><body></body></html>')).toBe(true);
    expect(looksLikeHtml('<!-- exported -->\n<!doctype html>')).toBe(true);
    expect(looksLikeHtml('<div class="card"><p>Hi</p></div>')).toBe(true);
    expect(looksLikeHtml('<svg viewBox="0 0 10 10"><rect/></svg>')).toBe(true);
    expect(looksLikeHtml('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"></svg>')).toBe(true);
    // Inkscape / Illustrator exports: a comment (and a doctype) after the XML header.
    expect(looksLikeHtml('<?xml version="1.0" encoding="UTF-8"?>\n<!-- Created with Inkscape (http://www.inkscape.org/) -->\n<svg width="10"></svg>')).toBe(true);
    expect(looksLikeHtml('<?xml version="1.0"?>\n<!-- Generator: Adobe Illustrator -->\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x.dtd">\n<svg></svg>')).toBe(true);
    expect(looksLikeHtml('<?xml version="1.0"?>\n<!-- c -->\n<notsvg/>')).toBe(false);
    expect(looksLikeHtml('<?xml version="1.0"?>' + '<!---->'.repeat(2000) + '<svg>')).toBe(false);
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
    expect(titleFromContent('doc', '```\n```js\n# still code\n```\n# After\n')).toBe('After');
    expect(titleFromContent('doc', '---\ntitle: ""\n---\n\n# Heading\n')).toBe('Heading');
    expect(titleFromContent('doc', '---\ntitle: "Say \\"hi\\""\n---\n')).toBe('Say "hi"');
    expect(titleFromContent('doc', "---\ntitle: 'It''s'\n---\n")).toBe("It's");
    expect(titleFromContent('doc', 'No heading')).toBeUndefined();
    expect(titleFromContent('whiteboard', '# x')).toBeUndefined();
    expect(titleFromContent('doc', `# ${'a'.repeat(300)}`)?.length).toBe(200);
  });

  it('recognises React component source (claude.ai designs), not HTML or prose', () => {
    const app = "import React, { useState } from 'react';\nimport { Camera } from 'lucide-react';\n\nexport default function App() {\n  return (\n    <div className=\"p-4\">Hi</div>\n  );\n}\n";
    expect(looksLikeReact(app)).toBe(true);
    expect(looksLikeReact("import { useState } from \"react\";\nconst A = () => <p/>;\n")).toBe(true);
    expect(looksLikeReact('export default function App() {\n  return <main/>;\n}')).toBe(true);
    expect(looksLikeReact('export default () => (\n  <Card/>\n);')).toBe(true);
    expect(looksLikeReact('<!doctype html><script>export default 1; return <b></script>')).toBe(false);
    expect(looksLikeReact('<div>export default function x() { return <p/> }</div>')).toBe(false);
    expect(looksLikeReact('# Notes\n\nexport default is how you export.')).toBe(false);
    expect(looksLikeReact("import x from 'react';")).toBe(false);
    expect(looksLikeReact('')).toBe(false);
    // Markdown with a React example in a fence stays a doc.
    const md = "# Title\n\n```jsx\nimport React from 'react';\nexport default function App() { return <div/>; }\n```\n";
    expect(looksLikeReact(md)).toBe(false);
    expect(inferKindFromContent(md)).toBe('doc');
    expect(looksLikeReact("Intro text\nimport React from 'react';\nexport default () => <p/>;")).toBe(false);
    // Leading comments and directives, multi-line imports.
    expect(looksLikeReact("import React from 'react';\nfunction App({ ok }) {\n  return ok ? (<Card/>) : null;\n}\nexport { App as default };\n")).toBe(true);
    // TypeScript generics are not JSX.
    expect(looksLikeReact('export default function first<T>(xs: T[]): T | undefined {\n  return xs[0];\n}\n')).toBe(false);
    expect(looksLikeReact('const m = new Map<string, Item>();\nexport default m;\n')).toBe(false);
    expect(looksLikeReact("// Pricing page\n/* v2 */\n'use client';\nimport {\n  useState,\n  useEffect,\n} from 'react';\nexport default function P() { return <p/>; }")).toBe(true);
    expect(inferKindFromContent(app)).toBe('design');
    expect(designEntryFor(app)).toBe('App.jsx');
    expect(designEntryFor('<p>x</p>')).toBe('index.html');
    expect(isDesignContent(app) && isDesignContent('<p>x</p>')).toBe(true);
    expect(isDesignContent('plain words')).toBe(false);
  });

  it('looksLikeReact stays fast on hostile input', () => {
    const t0 = performance.now();
    expect(looksLikeReact('import '.repeat(500_000))).toBe(false);
    expect(looksLikeReact('return ('.repeat(400_000))).toBe(false);
    expect(looksLikeReact('export default '.repeat(300_000) + 'x')).toBe(false);
    expect(looksLikeReact(' \t'.repeat(1_000_000) + 'x')).toBe(false);
    expect(performance.now() - t0).toBeLessThan(2000);
  });

  it('knows the placeholder older versions stored for link-only imports', () => {
    expect(isImportStubContent('<p>Imported from https://claude.ai/artifact/x. oIDE cannot fetch claude.ai artifacts: open the link…</p>')).toBe(true);
    expect(isImportStubContent('<h1>Real page</h1>')).toBe(false);
    // The first wording (2026-11-24), as a doc and as an HTML-escaped design page.
    const first = 'Imported from https://claude.ai/artifact/MyEmjmATV3mpUv6SZmFj4T. oIDE cannot fetch claude.ai artifacts; paste or drop the exported content here to keep a local copy.';
    expect(isImportStubContent(first + '\n')).toBe(true);
    expect(isImportStubContent(`<!doctype html>\n<html lang="en">\n<head><meta charset="utf-8"><title>Site</title></head>\n<body>\n<p>${first}</p>\n</body>\n</html>\n`)).toBe(true);
    // A real artifact that only mentions the phrase, or a big one, is not the placeholder.
    expect(isImportStubContent('# Changelog\n\nRemoved "oIDE cannot fetch claude.ai artifacts: open the link".')).toBe(false);
    expect(isImportStubContent('Imported from x. oIDE cannot fetch claude.ai artifacts: open the link' + 'x'.repeat(9000))).toBe(false);
    expect(isEmptyOideBoard(JSON.stringify({ type: 'excalidraw', version: 2, source: 'oide', elements: [], appState: {}, files: {} }))).toBe(true);
    expect(isEmptyOideBoard(JSON.stringify({ type: 'excalidraw', source: 'https://excalidraw.com', elements: [] }))).toBe(false);
    expect(isEmptyOideBoard(JSON.stringify({ type: 'excalidraw', source: 'oide', elements: [{ id: 'a' }] }))).toBe(false);
    expect(isEmptyOideBoard('{ not json')).toBe(false);
  });

  it('classifies claude.ai links before anything is imported', () => {
    expect(classifyClaudeLink('https://claude.ai/artifact/NFaggV4JC9X6prTgKhobKm#page-dcb81aee8d83')).toEqual({ ok: true, type: 'artifact', url: 'https://claude.ai/artifact/NFaggV4JC9X6prTgKhobKm#page-dcb81aee8d83' });
    expect(classifyClaudeLink(' https://claude.ai/artifact/oIDE-website-MyEmjmATV3mpUv6SZmFj4T ')).toMatchObject({ ok: true, type: 'artifact' });
    expect(classifyClaudeLink('https://claude.ai/code/artifact/0f8fad5b-d9cb-469f-a165-70867728950e')).toMatchObject({ ok: true, type: 'artifact' });
    expect(classifyClaudeLink('https://preview.claude.ai/artifact/MyEmjmATV3mpUv6SZmFj4T?x=1')).toMatchObject({ ok: true, type: 'artifact' });
    expect(classifyClaudeLink('https://claude.ai/public/artifacts/0f8fad5b-d9cb-469f-a165-70867728950e')).toMatchObject({ ok: true, type: 'public-artifact' });
    expect(classifyClaudeLink('https://claude.site/artifacts/0f8fad5b-d9cb-469f-a165-70867728950e')).toMatchObject({ ok: true, type: 'claude-site' });
    expect(classifyClaudeLink('https://claude.ai/design/p/0f8fad5b-d9cb-469f-a165-70867728950e')).toMatchObject({ ok: true, type: 'design' });
    const no = (raw: string) => {
      const r = classifyClaudeLink(raw);
      return r.ok ? '' : r.reason;
    };
    expect(no('https://claude.ai/chat/0f8fad5b-d9cb-469f-a165-70867728950e')).toMatch(/chat link/);
    expect(no('https://claude.ai/')).toMatch(/isn't a claude.ai artifact link/);
    expect(no('https://claude.ai/artifact/short')).toMatch(/isn't a claude.ai artifact link/);
    expect(no('https://claude.ai/artifact/MyEmjmATV3mpUv6SZmFj4T/extra')).toMatch(/isn't a claude.ai artifact link/);
    expect(no('https://claude.site/other')).toMatch(/claude.site/);
    expect(no('http://claude.ai/artifact/MyEmjmATV3mpUv6SZmFj4T')).toMatch(/https/);
    expect(no('https://claude.ai.evil.example/artifact/MyEmjmATV3mpUv6SZmFj4T')).toMatch(/claude.ai/);
    expect(no('https://evilclaude.ai/artifact/MyEmjmATV3mpUv6SZmFj4T')).toMatch(/claude.ai/);
    expect(no('https://u:p@claude.ai/artifact/MyEmjmATV3mpUv6SZmFj4T')).toMatch(/user name or password/);
    expect(no('not a link')).toMatch(/Not a valid link/);
    expect(no('https://claude.ai/artifact/' + 'a-'.repeat(2000))).toMatch(/too long|isn't/);
    const t0 = performance.now();
    expect(no('https://claude.ai/artifact/' + '-'.repeat(1900) + 'x')).toBeTruthy();
    expect(performance.now() - t0).toBeLessThan(500);
  });

  it('artifacts.import refuses a link alone at the IPC boundary', () => {
    const input = Commands['artifacts.import'].input;
    expect(input.safeParse({ url: 'https://claude.ai/artifact/MyEmjmATV3mpUv6SZmFj4T' }).success).toBe(false);
    expect(input.safeParse({ url: 'https://claude.ai/artifact/MyEmjmATV3mpUv6SZmFj4T', content: '  ' }).success).toBe(false);
    expect(input.safeParse({}).success).toBe(false);
    expect(input.safeParse({ url: 'https://claude.ai/artifact/MyEmjmATV3mpUv6SZmFj4T', content: '<p>x</p>' }).success).toBe(true);
    expect(input.safeParse({ filePath: 'C:\\x\\a.html' }).success).toBe(true);
    // Pasted content without a link (replacing an old import whose link is no longer accepted).
    expect(input.safeParse({ content: '<p>x</p>' }).success).toBe(true);
    const refused = input.safeParse({ url: 'https://claude.ai/artifact/MyEmjmATV3mpUv6SZmFj4T' });
    expect(refused.success ? '' : refused.error.issues[0]?.message).toMatch(/Paste the artifact's code/);
  });
});

describe('isSafeArtifactPath (ADR 0014)', () => {
  it('accepts relative forward-slash paths', () => {
    for (const p of ['index.html', 'shots/home.png', 'project/Main.html', '.well-known/x.json', 'a b/c-d_e.css', 'site~a.css']) expect(isSafeArtifactPath(p), p).toBe(true);
  });
  it('refuses escapes, absolute paths, backslashes, devices, reserved names and 8.3 short names', () => {
    for (const p of [
      '', '../x', 'a/../x', './x', 'a//b', '/abs', 'C:/x', 'C:x', 'a\b', 'x\u0000', 'dots.', 'space ',
      'CON', 'nul.txt', 'com1', 'artifact.json', 'ARTIFACT.JSON', '.versions/1/index.html', '.Staging', '__OIDE/x',
      // Windows 8.3 aliases of reserved names, and any other short name
      'ARTIFA~1.JSO', 'VERSIO~1', 'VERSIO~1/1/index.html', 'shots/SCREEN~1.PNG',
      'x'.repeat(261), Array.from({ length: 17 }, () => 'a').join('/'),
    ]) expect(isSafeArtifactPath(p), p).toBe(false);
  });
});
