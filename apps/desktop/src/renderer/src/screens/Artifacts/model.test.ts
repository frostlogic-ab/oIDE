import { describe, expect, it } from 'vitest';
import { ArtifactMeta, ArtifactUse, type AgentSummary } from '@oide/protocol';
import { agentsUsing, filterArtifacts, isClaudeLink, stripFrontMatter, usageLine, validateContent, versionLabel } from './model';

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

  it('strips front matter and validates whiteboards', () => {
    expect(stripFrontMatter('---\ntitle: x\n---\n# Hi')).toBe('# Hi');
    expect(validateContent('whiteboard', '{"elements":[]}')).toBeNull();
    expect(validateContent('whiteboard', '[1]')).toMatch(/JSON object/);
    expect(validateContent('whiteboard', '{')).toMatch(/Not valid JSON/);
    expect(validateContent('doc', '{')).toBeNull();
  });
});
