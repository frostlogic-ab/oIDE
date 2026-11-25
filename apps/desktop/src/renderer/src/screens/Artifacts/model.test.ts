import { describe, expect, it } from 'vitest';
import { ArtifactMeta, ArtifactUse, type AgentSummary } from '@oide/protocol';
import {
  agentsUsing,
  authorLabel,
  canOpenClaudeLink,
  contentForDiff,
  filterArtifacts,
  fixImportPlan,
  importContentError,
  importLinkError,
  isClaudeLink,
  kindFromFileName,
  liveDecision,
  sourceLanguage,
  stripFrontMatter,
  usageLine,
  validateContent,
  validateTitle,
  versionLabel,
} from './model';

const REACT_APP = "import React from 'react';\nexport default function App() {\n  return <div>Hi</div>;\n}\n";

const now = 1_800_000_000_000;
const meta = (id: string, kind: ArtifactMeta['kind'], projectId?: string) =>
  ArtifactMeta.parse({ id, slug: id, title: `T ${id}`, kind, projectId, location: 'app-data', version: 1, entry: 'x', createdAt: now, updatedAt: now });
const use = (agentId: string, op: ArtifactUse['op'], minsAgo: number) => ArtifactUse.parse({ artifactId: 'a', agentId, op, ts: now - minsAgo * 60_000 });
const agent = (id: string, status: AgentSummary['status']) =>
  ({ id, status, title: `Agent ${id}` }) as unknown as AgentSummary;

describe('artifacts model', () => {
  it('filters by kind, project and query', () => {
    const list = [meta('one', 'design', 'p1'), meta('two', 'doc', 'p2'), meta('three', 'doc', 'p1')];
    expect(filterArtifacts(list, { kind: 'doc', project: 'all', query: '' }).map((a) => a.id)).toEqual(['two', 'three']);
    expect(filterArtifacts(list, { kind: 'all', project: 'p1', query: '' }).map((a) => a.id)).toEqual(['one', 'three']);
    expect(filterArtifacts(list, { kind: 'all', project: 'all', query: 'T TWO' }).map((a) => a.id)).toEqual(['two']);
    expect(filterArtifacts(list, { kind: 'all', project: 'all', query: 'p2' }, (id) => id ?? '').map((a) => a.id)).toEqual(['two']);
  });

  it('summarises agent use like the design', () => {
    expect(usageLine([], {}, now)).toEqual({ text: 'Not used by agents', live: false });
    expect(usageLine([use('x', 'read', 5), use('y', 'read', 3), use('x', 'read', 1)], {}, now).text).toBe('Read by 2 agents');
    expect(usageLine([use('x', 'write', 2)], { x: agent('x', 'running') }, now)).toEqual({ text: 'Being written by an agent', live: true });
    expect(usageLine([use('x', 'write', 60)], { x: agent('x', 'running') }, now).text).toBe('Written by an agent · 1h ago');
    expect(usageLine([use('x', 'write', 2)], { x: agent('x', 'done') }, now).live).toBe(false);
  });

  it('groups agents using an artifact into reads / writes', () => {
    expect(agentsUsing([use('x', 'read', 9), use('x', 'write', 5), use('y', 'read', 1), use('z', 'list', 1)])).toEqual([
      { agentId: 'y', op: 'reads', ts: now - 60_000 },
      { agentId: 'x', op: 'writes', ts: now - 5 * 60_000 },
    ]);
  });

  it('labels versions', () => {
    const t = (id: string) => (id === 'a1' ? 'Window shell layout' : undefined);
    expect(versionLabel({ version: 4, ts: now, author: 'user', note: 'Edited by you' }, t, now)).toMatch(/^v4 · edited by you · \d\d:\d\d$/);
    expect(versionLabel({ version: 3, ts: now, author: 'agent:a1', note: 'Added a focus view' }, t, now)).toMatch(/^v3 · Window shell layout agent · added a focus view · /);
  });

  it('only treats https claude.ai links as claude.ai', () => {
    expect(isClaudeLink('https://claude.ai/public/artifacts/1')).toBe(true);
    expect(isClaudeLink('https://x.claude.site/a')).toBe(true);
    expect(isClaudeLink('http://claude.ai/a')).toBe(false);
    expect(isClaudeLink('https://claude.ai.evil.example/a')).toBe(false);
    expect(isClaudeLink(undefined)).toBe(false);
  });

  it('opens only claude.ai links, whatever shape they have', () => {
    expect(canOpenClaudeLink('https://claude.ai/public/artifacts/0b6c-main-window-v2')).toBe(true);
    expect(canOpenClaudeLink('https://claude.site/artifacts/x')).toBe(false);
  });

  it('explains why a link cannot be imported', () => {
    expect(importLinkError('https://claude.ai/artifact/MyEmjmATV3mpUv6SZmFj4T')).toBeUndefined();
    expect(importLinkError('https://claude.ai/chat/0b6c3f2a-1111-4222-8333-444455556666')).toMatch(/chat link/);
    expect(importLinkError('https://example.com/a')).toBe('Only https links on claude.ai can be imported.');
    expect(importLinkError('nope')).toBe('Not a valid link.');
  });

  it('checks pasted content like main: stub, design = HTML or React, whiteboard = JSON', () => {
    expect(importContentError('design', '<!doctype html><p>x</p>')).toBeUndefined();
    expect(importContentError('design', REACT_APP)).toBeUndefined();
    expect(importContentError('design', 'just words')).toMatch(/HTML page or a React component/);
    expect(importContentError('doc', '# Notes\n\noIDE cannot fetch claude.ai artifacts. Paste.')).toMatch(/placeholder/);
    expect(importContentError('whiteboard', 'not json')).toMatch(/JSON/);
    expect(importContentError('whiteboard', '\uFEFF{"type":"excalidraw","elements":[]}')).toBeUndefined();
  });

  it('plans a fix: save in place when the paste fits the kind, else replace with the content kind', () => {
    expect(fixImportPlan('design', '<!doctype html><p>x</p>')).toEqual({ mode: 'save' });
    expect(fixImportPlan('design', REACT_APP)).toEqual({ mode: 'save' });
    expect(fixImportPlan('doc', '# Notes')).toEqual({ mode: 'save' });
    expect(fixImportPlan('doc', REACT_APP)).toEqual({ mode: 'replace', kind: 'design' });
    expect(fixImportPlan('design', '# Notes\n\nText')).toEqual({ mode: 'replace', kind: 'doc' });
  });

  it('takes React and SVG files as designs', () => {
    for (const f of ['a.jsx', 'a.tsx', 'a.svg', 'a.html']) expect(kindFromFileName(f)).toBe('design');
    expect(kindFromFileName('a.md')).toBe('doc');
    expect(kindFromFileName('a.excalidraw')).toBe('whiteboard');
  });

  it('strips front matter and validates whiteboards', () => {
    expect(stripFrontMatter('---\ntitle: x\n---\n# Hi')).toBe('# Hi');
    expect(validateContent('whiteboard', '{"elements":[]}')).toBeNull();
    expect(validateContent('whiteboard', '[1]')).toMatch(/JSON object/);
    expect(validateContent('whiteboard', '{')).toMatch(/Not valid JSON/);
    expect(validateContent('doc', '{')).toBeNull();
  });
});

describe('artifact editors model', () => {
  it('decides what an open editor does with a newer version', () => {
    const own = new Set([3]);
    expect(liveDecision({ baseVersion: 2, incomingVersion: 2, ownVersions: own, dirty: true })).toBe('none');
    expect(liveDecision({ baseVersion: 4, incomingVersion: 3, ownVersions: own, dirty: false })).toBe('none');
    expect(liveDecision({ baseVersion: 2, incomingVersion: 3, ownVersions: own, dirty: true })).toBe('own');
    expect(liveDecision({ baseVersion: 2, incomingVersion: 4, ownVersions: own, dirty: false })).toBe('reload');
    expect(liveDecision({ baseVersion: 2, incomingVersion: 4, ownVersions: own, dirty: true })).toBe('conflict');
  });

  it('names authors, languages and diff text', () => {
    const title = (id: string) => (id === 'a1' ? 'Retry policy' : undefined);
    expect(authorLabel('user', title)).toBe('you');
    expect(authorLabel(undefined, title)).toBe('you');
    expect(authorLabel('agent:a1', title)).toBe('Retry policy agent');
    expect(authorLabel('agent:zz', title)).toBe('zz agent');
    expect(sourceLanguage('doc')).toBe('markdown');
    expect(sourceLanguage('design')).toBe('html');
    expect(sourceLanguage('design', 'index.html')).toBe('html');
    expect(sourceLanguage('design', 'App.jsx')).toBe('javascript');
    expect(sourceLanguage('whiteboard')).toBe('json');
    expect(contentForDiff('whiteboard', '{"a":1,"b":[2]}')).toBe('{\n  "a": 1,\n  "b": [\n    2\n  ]\n}\n');
    expect(contentForDiff('whiteboard', 'not json')).toBe('not json');
    expect(contentForDiff('doc', '{"a":1}')).toBe('{"a":1}');
  });

  it('validates rename titles', () => {
    expect(validateTitle('  Main   window ')).toEqual({ title: 'Main window' });
    expect(validateTitle('   ')).toEqual({ error: 'Give it a title.' });
    expect(validateTitle('x'.repeat(201))).toEqual({ error: 'Use at most 200 characters.' });
  });
});
