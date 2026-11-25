import { describe, expect, it } from 'vitest';
import { UserMessage, type MessageAttachment } from '@oide/protocol';
import { buildLaunch } from './args.js';
import { MERGE_CONFLICTS_HEADER, contentBlocks, describeFiles, mergeConflictsText, messageText, toStreamJson } from './messages.js';
import { fakeCli, testSettings } from '../test/helpers.js';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==';
const image: MessageAttachment = { kind: 'image', mediaType: 'image/png', dataBase64: PNG, name: 'shot.png' };
const file: MessageAttachment = { kind: 'file', path: '.oide/attachments/20261125T101500-spec.pdf', name: 'spec.pdf', size: 2_500_000 };

describe('UserMessage with attachments → stream-json content blocks', () => {
  it('puts image blocks first (base64 source), then one text block', () => {
    const msg = toStreamJson({ kind: 'text', text: 'What is wrong here?', attachments: [image] });
    expect(msg).toEqual({
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } },
          { type: 'text', text: 'What is wrong here?' },
        ],
      },
    });
  });

  it('names attached files by their path in the agent folder', () => {
    const msg = toStreamJson({ kind: 'text', text: 'Use the spec', attachments: [file, image] });
    const content = msg.message.content as Array<{ type: string; text?: string }>;
    expect(content.map((b) => b.type)).toEqual(['image', 'text']);
    expect(content[1]!.text).toBe('Use the spec\n\nAttached file (copied into your working folder; read it from there):\n- .oide/attachments/20261125T101500-spec.pdf (spec.pdf, 2.4 MB)');
    expect(describeFiles([image])).toBe('');
  });

  it('artifact messages carry attachments too; plain messages stay one text block', () => {
    const msg = toStreamJson({ kind: 'artifact', artifactId: 'art-1', note: 'Match this', attachments: [image] }, () => ({ id: 'art-1', title: 'Main window' }));
    expect((msg.message.content as Array<{ type: string }>).map((b) => b.type)).toEqual(['image', 'text']);
    expect(toStreamJson({ kind: 'text', text: 'hi' }).message.content).toEqual([{ type: 'text', text: 'hi' }]);
    expect(contentBlocks('', [image])).toEqual([expect.objectContaining({ type: 'image' }), { type: 'text', text: 'See the attached image.' }]);
    expect(messageText(msg)).toContain('Match this');
  });

  it('the first message (Spawn) carries spec.attachments', () => {
    const plan = buildLaunch(
      { projectId: 'p', title: 'T', goal: 'Fix the layout in the screenshot', context: [], workIn: 'worktree-from-main', mode: 'default', strategy: { kind: 'single', lead: { model: 'sonnet' } }, techniques: [], extensions: [], attempts: 1, attachments: [image] },
      { agentId: 'a', sessionId: 's', cwd: '/w', cli: fakeCli, settings: testSettings({}) },
    );
    const content = plan.firstMessage!.message.content as Array<{ type: string; text?: string }>;
    expect(content[0]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } });
    expect(content[1]!.text).toContain('Fix the layout in the screenshot');
  });
});

describe('UserMessage attachment schema', () => {
  it('accepts png/jpeg/gif/webp base64 and rejects other types, bad base64 and more than 10', () => {
    expect(UserMessage.safeParse({ kind: 'text', text: 'x', attachments: [image] }).success).toBe(true);
    expect(UserMessage.safeParse({ kind: 'text', text: 'x', attachments: [{ ...image, mediaType: 'image/svg+xml' }] }).success).toBe(false);
    expect(UserMessage.safeParse({ kind: 'text', text: 'x', attachments: [{ ...image, dataBase64: 'not base64!' }] }).success).toBe(false);
    expect(UserMessage.safeParse({ kind: 'text', text: 'x', attachments: Array(11).fill(image) }).success).toBe(false);
    expect(UserMessage.safeParse({ kind: 'text', text: 'x', attachments: [{ ...file, size: 26 * 1024 * 1024 }] }).success).toBe(false);
    // A base64 string longer than 5 MB decoded is refused by the schema itself.
    expect(UserMessage.safeParse({ kind: 'text', text: 'x', attachments: [{ ...image, dataBase64: 'A'.repeat(7_000_004) }] }).success).toBe(false);
  });
});

describe('merge-conflicts messages (Ask <agent> to resolve)', () => {
  const base = { kind: 'merge-conflicts' as const, target: 'main', targetSha: 'abc1234def5678', mergeRef: 'main', fetchFirst: false, files: ['src/a.ts', 'logo.png', 'vendor/lib'], binary: ['logo.png'], submodules: ['vendor/lib'] };

  it('names the target and commit, the files, the steps and the rules', () => {
    const text = messageText(toStreamJson(base));
    expect(text.split('\n')[0]).toBe(MERGE_CONFLICTS_HEADER);
    expect(text).toContain('`main` @ abc1234');
    expect(text).toContain('- src/a.ts\n- logo.png (binary)\n- vendor/lib (submodule)');
    expect(text).toMatch(/Binary files cannot be merged line by line/);
    expect(text).toMatch(/For a submodule/);
    expect(text).toContain('no fetch is needed: run `git merge main` inside your own worktree');
    expect(text).toMatch(/submit_for_review again/);
    expect(text).toMatch(/Never rebase and never force-push/);
    expect(text).toMatch(/Never touch the main checkout/);
    expect(text).toMatch(/git merge --abort` without saying why/);
  });

  it('a detached HEAD merges the commit; a remote-tracking target fetches first; unknown files are said so', () => {
    const detached = mergeConflictsText({ ...base, target: 'abc1234def5678', mergeRef: 'abc1234def5678', files: [], binary: [], submodules: [] });
    expect(detached).toContain("the main checkout's commit abc1234 (it is on a detached HEAD)");
    expect(detached).toContain('run `git merge abc1234def5678`');
    expect(detached).toMatch(/could not predict which files conflict/);
    const remote = mergeConflictsText({ ...base, target: 'origin/main', mergeRef: 'origin/main', fetchFirst: true });
    expect(remote).toContain('run `git fetch` first, then run `git merge origin/main`');
  });

  it('is a valid UserMessage', () => {
    expect(UserMessage.safeParse(base).success).toBe(true);
    expect(UserMessage.safeParse({ ...base, targetSha: 'not a sha' }).success).toBe(false);
  });
});
