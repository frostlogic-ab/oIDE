import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pathKey } from '@oide/git';
import type { MessageAttachment } from '@oide/protocol';
import { copyAttachments, readPickedFiles, safeFileName, sniffImage, validateAttachments } from './attachments';

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==';
const PNG = Buffer.from(PNG_B64, 'base64');
const image = (patch: Partial<Extract<MessageAttachment, { kind: 'image' }>> = {}): MessageAttachment => ({ kind: 'image', mediaType: 'image/png', dataBase64: PNG_B64, name: 'shot.png', ...patch });

let base: string;
let worktree: string;
let outside: string;

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'oide-attach-'));
  worktree = join(base, 'repo');
  outside = join(base, 'elsewhere');
  mkdirSync(worktree, { recursive: true });
  mkdirSync(outside, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: worktree });
  writeFileSync(join(worktree, 'inside.txt'), 'inside');
  writeFileSync(join(outside, 'notes.txt'), 'hello');
  writeFileSync(join(outside, 'secret.txt'), 'not picked');
  writeFileSync(join(outside, 'shot.png'), PNG);
  writeFileSync(join(outside, 'fake.png'), 'not really a png');
  writeFileSync(join(outside, 'big.bin'), Buffer.alloc(25 * 1024 * 1024 + 1));
});

afterAll(() => rmSync(base, { recursive: true, force: true }));

describe('validateAttachments (main)', () => {
  it('accepts picked files and files inside the worktree, with the real size', async () => {
    const picked = new Set([pathKey(join(outside, 'notes.txt'))]);
    const out = await validateAttachments(
      [
        { kind: 'file', path: join(outside, 'notes.txt'), name: 'notes.txt', size: 999 },
        { kind: 'file', path: join(worktree, 'inside.txt'), name: 'inside.txt', size: 1 },
      ],
      { picked, roots: [worktree] },
    );
    expect(out.map((a) => a.kind === 'file' && a.size)).toEqual([5, 6]);
  });

  it('refuses renderer-sent paths that were never picked or dropped', async () => {
    await expect(validateAttachments([{ kind: 'file', path: join(outside, 'secret.txt'), name: 'secret.txt', size: 1 }], { picked: new Set(), roots: [worktree] })).rejects.toThrow(/other paths are refused/);
    await expect(validateAttachments([{ kind: 'file', path: join(worktree, '..', 'elsewhere', 'secret.txt'), name: 'secret.txt', size: 1 }], { picked: new Set(), roots: [worktree] })).rejects.toThrow(/refused/);
    await expect(validateAttachments([{ kind: 'file', path: 'relative.txt', name: 'relative.txt', size: 1 }], { picked: new Set(), roots: [worktree] })).rejects.toThrow(/not a file oIDE can attach/);
  });

  it('checks image bytes against the declared type and the size limits', async () => {
    await expect(validateAttachments([image()], { picked: new Set(), roots: [] })).resolves.toHaveLength(1);
    await expect(validateAttachments([image({ mediaType: 'image/jpeg' })], { picked: new Set(), roots: [] })).rejects.toThrow('the image data is image/png, not image/jpeg');
    await expect(validateAttachments([image({ dataBase64: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64') })], { picked: new Set(), roots: [] })).rejects.toThrow(/only PNG, JPEG, GIF and WebP/);
    const huge = Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)]).toString('base64');
    await expect(validateAttachments([image({ dataBase64: huge })], { picked: new Set(), roots: [] })).rejects.toThrow(/images can be at most 5.0 MB/);
    const four = Buffer.concat([PNG, Buffer.alloc(4.5 * 1024 * 1024)]).toString('base64');
    await expect(validateAttachments(Array.from({ length: 5 }, () => image({ dataBase64: four })), { picked: new Set(), roots: [] })).rejects.toThrow(/total at most 20.0 MB/);
    await expect(validateAttachments(Array.from({ length: 11 }, () => image()), { picked: new Set(), roots: [] })).rejects.toThrow(/At most 10/);
  });

  it('refuses files over 25 MB even when picked', async () => {
    const p = join(outside, 'big.bin');
    await expect(validateAttachments([{ kind: 'file', path: p, name: 'big.bin', size: 1 }], { picked: new Set([pathKey(p)]), roots: [] })).rejects.toThrow(/files can be at most 25.0 MB/);
  });
});

describe('readPickedFiles (dialog.pickFiles and drops)', () => {
  it('reads real images inline, other files by path, registers them, and explains refusals', async () => {
    const picked = new Set<string>();
    const r = await readPickedFiles([join(outside, 'shot.png'), join(outside, 'notes.txt'), join(outside, 'fake.png'), join(outside, 'big.bin'), outside, 'not/absolute'], picked);
    expect(r.attachments).toEqual([
      { kind: 'image', mediaType: 'image/png', dataBase64: PNG_B64, name: 'shot.png' },
      { kind: 'file', path: join(outside, 'notes.txt'), name: 'notes.txt', size: 5 },
      { kind: 'file', path: join(outside, 'fake.png'), name: 'fake.png', size: 16 },
    ]);
    expect(r.rejected.map((x) => x.name)).toEqual(['big.bin', 'elsewhere', 'absolute']);
    expect(r.rejected[0]!.reason).toMatch(/at most 25.0 MB/);
    expect(picked.has(pathKey(join(outside, 'notes.txt')))).toBe(true);
    expect(picked.has(pathKey(join(outside, 'big.bin')))).toBe(false);
  });
});

describe('copyAttachments', () => {
  it('copies files under .oide/attachments/<timestamp>-<name>, excludes the folder in info/exclude, keeps images', async () => {
    const now = Date.UTC(2026, 10, 25, 14, 30, 12);
    const out = await copyAttachments(worktree, [image(), { kind: 'file', path: join(outside, 'notes.txt'), name: 'notes.txt', size: 5 }, { kind: 'file', path: join(outside, 'notes.txt'), name: 'notes.txt', size: 5 }], pickedNotes(), now);
    expect(out[0]).toEqual(image());
    expect(out.slice(1).map((a) => a.kind === 'file' && a.path)).toEqual(['.oide/attachments/20261125T143012-notes.txt', '.oide/attachments/20261125T143012-notes-2.txt']);
    expect(readFileSync(join(worktree, '.oide/attachments/20261125T143012-notes.txt'), 'utf8')).toBe('hello');
    const exclude = readFileSync(join(worktree, '.git/info/exclude'), 'utf8');
    expect(exclude).toContain('/.oide/attachments/');
    await copyAttachments(worktree, [{ kind: 'file', path: join(outside, 'notes.txt'), name: 'notes.txt', size: 5 }], pickedNotes(), now + 1000);
    expect(readFileSync(join(worktree, '.git/info/exclude'), 'utf8').split('/.oide/attachments/').length).toBe(2);
    // git sees nothing to commit in the attachments folder.
    expect(execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: worktree, encoding: 'utf8' })).not.toContain('.oide/attachments');
  });

  it('makes names safe on every platform', () => {
    expect(safeFileName('../../etc/passwd')).toBe('passwd');
    expect(safeFileName('a:b*c?.txt')).toBe('a_b_c_.txt');
    expect(safeFileName('...hidden')).toBe('hidden');
    expect(safeFileName('')).toBe('file');
  });

  it('sniffs image types from bytes', () => {
    expect(sniffImage(PNG)).toBe('image/png');
    expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffImage(Buffer.from('GIF89a'))).toBe('image/gif');
    expect(sniffImage(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
    expect(sniffImage(Buffer.from('hello'))).toBeUndefined();
  });
});

describe('attachments refuse links planted in the agent folder', () => {
  it('does not copy through a .oide junction that points outside the worktree', async () => {
    const wt = join(base, 'linked-wt');
    const target = join(base, 'link-target');
    mkdirSync(wt, { recursive: true });
    mkdirSync(target, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: wt });
    // A junction needs no privileges on Windows; elsewhere it is a plain directory symlink.
    symlinkSync(target, join(wt, '.oide'), 'junction');
    const picked = new Set([pathKey(join(outside, 'notes.txt'))]);
    const files = await validateAttachments([{ kind: 'file', path: join(outside, 'notes.txt'), name: 'notes.txt', size: 5 }], { picked, roots: [wt] });
    await expect(copyAttachments(wt, files, picked)).rejects.toThrow(/link or not a folder/);
    expect(readdirSync(target)).toEqual([]);
  });

  it('refuses a link in the worktree instead of following it', async (ctx) => {
    const link = join(worktree, 'looks-inside.txt');
    try {
      symlinkSync(join(outside, 'secret.txt'), link, 'file');
    } catch {
      ctx.skip(); // file symlinks need Developer Mode or admin on Windows
    }
    await expect(validateAttachments([{ kind: 'file', path: link, name: 'looks-inside.txt', size: 1 }], { picked: new Set(), roots: [worktree] })).rejects.toThrow(/other paths are refused|links cannot be attached/);
  });
});

describe('copyAttachments never reads the agent folder', () => {
  it('passes files already inside the worktree by relative path without copying them', async () => {
    const out = await copyAttachments(worktree, [{ kind: 'file', path: join(worktree, 'inside.txt'), name: 'inside.txt', size: 6 }], new Set());
    expect(out).toEqual([{ kind: 'file', path: 'inside.txt', name: 'inside.txt', size: 6 }]);
  });
});

const pickedNotes = (): Set<string> => new Set([pathKey(join(outside, 'notes.txt'))]);

describe('copyAttachments reads only what the user picked', () => {
  it('refuses a file outside the agent folder that was validated against another root but never picked', async () => {
    const projectFile = join(outside, 'secret.txt'); // e.g. in the project folder Spawn validated against
    await expect(copyAttachments(worktree, [{ kind: 'file', path: projectFile, name: 'secret.txt', size: 10 }], new Set())).rejects.toThrow(/only files you attach/);
  });
});
