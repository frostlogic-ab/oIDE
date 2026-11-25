import { copyFile, mkdir, open, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, posix, relative, resolve } from 'node:path';
import { Git, pathKey } from '@oide/git';
import {
  ATTACHMENT_LIMITS,
  base64Bytes,
  type FileAttachment,
  type ImageMediaType,
  type MessageAttachment,
  type PickedAttachments,
} from '@oide/protocol';
import { IpcError } from '../ipc/router.js';
import { isInside } from '../security/paths.js';

/**
 * Attachments on user messages (Focus composer, Wall reply, Spawn goal).
 *
 * - Picked (`dialog.pickFiles`) and dropped (preload's drop channel) paths are registered in
 *   `Services.picked`, then read: images (≤ 5 MB, content sniffed) come back inline as base64,
 *   other files (≤ 25 MB) by absolute path.
 * - `validateAttachments` runs on every `agents.send` / `agents.spawn`: an image's bytes must match
 *   its declared type and the size limits; a file path must be one picked or dropped this session,
 *   or sit inside the agent's own folder. Renderer-sent sizes are never trusted (stat again).
 * - `copyAttachments` copies files into `<agent folder>/.oide/attachments/<timestamp>-<name>` and
 *   adds `/.oide/attachments/` to the repository's `info/exclude` (never the user's .gitignore).
 *   Images never touch disk here: they go to the CLI as content blocks.
 */

export const ATTACHMENTS_DIR = '.oide/attachments';
const EXCLUDE_LINE = '/.oide/attachments/';

const MB = 1024 * 1024;
export function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < MB) return `${Math.round(n / 1024)} KB`;
  return `${(n / MB).toFixed(1)} MB`;
}

const IMAGE_EXT: Record<string, ImageMediaType> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };

/** Image type from the file's first bytes (PNG, JPEG, GIF, WebP), or undefined. */
export function sniffImage(b: Uint8Array): ImageMediaType | undefined {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61) return 'image/gif';
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  return undefined;
}

const isUnc = (p: string) => /^[\\/]{2}/.test(p);

function refuse(message: string): never {
  throw new IpcError(message, 'invalid_input');
}

/**
 * Read picked or dropped paths as attachments and remember them as user-picked for this session.
 * Called only with paths from the native dialog or from preload's `webUtils.getPathForFile`.
 */
export async function readPickedFiles(paths: readonly string[], picked: Set<string>): Promise<PickedAttachments> {
  const out: PickedAttachments = { attachments: [], rejected: [] };
  for (const raw of paths) {
    const name = basename(raw) || raw;
    if (typeof raw !== 'string' || !raw || raw.includes('\0') || !isAbsolute(raw)) {
      out.rejected.push({ name, reason: 'Not a file path.' });
      continue;
    }
    // SEC-39: stat on a UNC path is an SMB connection; never make one for an attachment.
    if (process.platform === 'win32' && isUnc(raw)) {
      out.rejected.push({ name, reason: 'Files on a network share cannot be attached. Copy the file to this computer first.' });
      continue;
    }
    const abs = resolve(raw);
    let size: number;
    try {
      const st = await stat(abs);
      if (!st.isFile()) {
        out.rejected.push({ name, reason: 'Folders cannot be attached. Attach the files inside it.' });
        continue;
      }
      size = st.size;
    } catch {
      out.rejected.push({ name, reason: 'The file could not be read.' });
      continue;
    }
    const byExt = IMAGE_EXT[extname(abs).toLowerCase()];
    if (byExt) {
      if (size > ATTACHMENT_LIMITS.imageBytes) {
        out.rejected.push({ name, reason: `Images can be at most ${formatSize(ATTACHMENT_LIMITS.imageBytes)} (this one is ${formatSize(size)}).` });
        continue;
      }
      const data = await readFile(abs);
      const sniffed = sniffImage(data);
      if (sniffed) {
        picked.add(pathKey(abs));
        out.attachments.push({ kind: 'image', mediaType: sniffed, dataBase64: data.toString('base64'), name });
        continue;
      }
      // Named like an image but is not one: attach it as a plain file.
    }
    if (size > ATTACHMENT_LIMITS.fileBytes) {
      out.rejected.push({ name, reason: `Files can be at most ${formatSize(ATTACHMENT_LIMITS.fileBytes)} (this one is ${formatSize(size)}).` });
      continue;
    }
    picked.add(pathKey(abs));
    out.attachments.push({ kind: 'file', path: abs, name, size });
  }
  return out;
}

export interface ValidateOptions {
  /** Paths picked in a native dialog or dropped this session (`Services.picked`, `pathKey`ed). */
  picked: ReadonlySet<string>;
  /** Folders whose files may be attached without a pick (the agent's own worktree). */
  roots: readonly string[];
}

/**
 * Main's check of attachments from the renderer (on top of the IPC schema's shape and limits).
 * Returns file attachments with their real size and absolute path; throws `invalid_input` with a
 * message the composer shows as is.
 */
export async function validateAttachments(attachments: readonly MessageAttachment[] | undefined, opts: ValidateOptions): Promise<MessageAttachment[]> {
  if (!attachments?.length) return [];
  if (attachments.length > ATTACHMENT_LIMITS.count) refuse(`At most ${ATTACHMENT_LIMITS.count} attachments per message.`);
  let imageTotal = 0;
  const out: MessageAttachment[] = [];
  for (const a of attachments) {
    if (a.kind === 'image') {
      const label = a.name ?? 'Pasted image';
      const bytes = base64Bytes(a.dataBase64);
      if (bytes > ATTACHMENT_LIMITS.imageBytes) refuse(`${label}: images can be at most ${formatSize(ATTACHMENT_LIMITS.imageBytes)} (this one is ${formatSize(bytes)}).`);
      imageTotal += bytes;
      const head = Buffer.from(a.dataBase64.slice(0, 32), 'base64');
      const sniffed = sniffImage(head);
      if (!sniffed) refuse(`${label}: only PNG, JPEG, GIF and WebP images can be attached.`);
      if (sniffed !== a.mediaType) refuse(`${label}: the image data is ${sniffed}, not ${a.mediaType}.`);
      out.push(a);
      continue;
    }
    const path = a.path;
    if (!isAbsolute(path) || path.includes('\0') || (process.platform === 'win32' && isUnc(path))) refuse(`${a.name}: not a file oIDE can attach.`);
    const abs = resolve(path);
    const allowed = opts.picked.has(pathKey(abs)) || opts.roots.some((r) => isInside(r, abs));
    if (!allowed) refuse(`${a.name}: attach files with Attach file or by dropping them; other paths are refused.`);
    let size: number;
    try {
      const st = await stat(abs);
      if (!st.isFile()) refuse(`${a.name}: folders cannot be attached.`);
      size = st.size;
    } catch (err) {
      if (err instanceof IpcError) throw err;
      refuse(`${a.name}: the file is gone or cannot be read.`);
    }
    if (size > ATTACHMENT_LIMITS.fileBytes) refuse(`${a.name}: files can be at most ${formatSize(ATTACHMENT_LIMITS.fileBytes)} (this one is ${formatSize(size)}).`);
    out.push({ kind: 'file', path: abs, name: a.name, size });
  }
  if (imageTotal > ATTACHMENT_LIMITS.imagesTotalBytes) refuse(`Images in one message can total at most ${formatSize(ATTACHMENT_LIMITS.imagesTotalBytes)}.`);
  return out;
}

/** `20261125T143012` (UTC), the copies' name prefix. */
function stamp(now: number): string {
  return new Date(now).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '');
}

/** A file name safe on every platform: no separators, reserved characters, leading dots or trailing spaces. */
export function safeFileName(name: string): string {
  const cleaned = posix
    .basename(name.replace(/\\/g, '/'))
    .split('')
    .map((ch) => (ch.charCodeAt(0) < 0x20 || '<>:"/\\|?*'.includes(ch) ? '_' : ch))
    .join('')
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '');
  const ext = extname(cleaned).slice(0, 16);
  const stem = cleaned.slice(0, cleaned.length - ext.length).slice(0, 80);
  return `${stem || 'file'}${ext}`;
}

/** Add `/.oide/attachments/` to the repository's `info/exclude` (the common one for linked worktrees). */
export async function excludeAttachments(cwd: string): Promise<void> {
  let excludePath: string;
  try {
    const rel = (await new Git({ cwd }).out(['rev-parse', '--git-path', 'info/exclude'])).trim();
    if (!rel) return;
    excludePath = isAbsolute(rel) ? rel : resolve(cwd, rel);
  } catch {
    return; // not a git folder: nothing to keep out of commits
  }
  let cur = '';
  try {
    cur = await readFile(excludePath, 'utf8');
  } catch {
    /* no exclude file yet */
  }
  if (cur.split(/\r?\n/).some((l) => l.trim() === EXCLUDE_LINE)) return;
  await mkdir(join(excludePath, '..'), { recursive: true });
  const sep = cur && !cur.endsWith('\n') ? '\n' : '';
  await writeFile(excludePath, `${cur}${sep}# oIDE: files attached to agent messages\n${EXCLUDE_LINE}\n`);
}

/**
 * Copy file attachments into `<cwd>/.oide/attachments/` and return them with paths relative to `cwd`
 * (forward slashes). Images pass through untouched. Files already inside that folder are not copied again.
 */
export async function copyAttachments(cwd: string, attachments: readonly MessageAttachment[], now = Date.now()): Promise<MessageAttachment[]> {
  const files = attachments.filter((a): a is FileAttachment => a.kind === 'file');
  if (!files.length) return [...attachments];
  const dir = join(cwd, ATTACHMENTS_DIR);
  await mkdir(dir, { recursive: true });
  await excludeAttachments(cwd);
  const used = new Set<string>();
  const out: MessageAttachment[] = [];
  for (const a of attachments) {
    if (a.kind === 'image') {
      out.push(a);
      continue;
    }
    const src = resolve(isAbsolute(a.path) ? a.path : join(cwd, a.path));
    if (isInside(dir, src)) {
      out.push({ ...a, path: relative(cwd, src).split('\\').join('/') });
      continue;
    }
    const base = `${stamp(now)}-${safeFileName(a.name)}`;
    let target = base;
    for (let i = 2; used.has(target.toLowerCase()) || (await exists(join(dir, target))); i++) {
      const ext = extname(base);
      target = `${base.slice(0, base.length - ext.length)}-${i}${ext}`;
    }
    used.add(target.toLowerCase());
    await copyFile(src, join(dir, target));
    out.push({ kind: 'file', path: `${ATTACHMENTS_DIR}/${target}`, name: a.name, size: a.size });
  }
  return out;
}

async function exists(p: string): Promise<boolean> {
  try {
    const h = await open(p, 'r');
    await h.close();
    return true;
  } catch {
    return false;
  }
}
