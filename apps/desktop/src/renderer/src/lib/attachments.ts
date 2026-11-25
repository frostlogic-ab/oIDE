import { ATTACHMENT_LIMITS, base64Bytes, IMAGE_MEDIA_TYPES, type ImageAttachment, type ImageMediaType, type MessageAttachment, type PickedAttachments } from '@oide/protocol';

/**
 * Attachments on prompt inputs (Focus composer, Wall reply, Spawn goal): pasted or dropped images
 * are read here (base64, never written to disk); other dropped files go through preload's
 * `attachDropped` (main registers their paths); Attach file uses `dialog.pickFiles`. Main checks
 * everything again on send. Limits: `ATTACHMENT_LIMITS` (images 5 MB, files 25 MB, 10 per message).
 */

export function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function attachmentName(a: MessageAttachment): string {
  return a.kind === 'image' ? (a.name ?? 'Pasted image') : a.name;
}

export function attachmentBytes(a: MessageAttachment): number {
  return a.kind === 'image' ? base64Bytes(a.dataBase64) : a.size;
}

export function imageSrc(a: ImageAttachment): string {
  return `data:${a.mediaType};base64,${a.dataBase64}`;
}

export function isImageType(type: string): type is ImageMediaType {
  return (IMAGE_MEDIA_TYPES as readonly string[]).includes(type);
}

/** Base64 of a Blob without the data-URL prefix. */
function blobBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const s = typeof r.result === 'string' ? r.result : '';
      resolve(s.slice(s.indexOf(',') + 1));
    };
    r.onerror = () => reject(new Error('The image could not be read.'));
    r.readAsDataURL(blob);
  });
}

let pasteCount = 0;

/** A pasted or dropped image as an attachment. Throws with a message for the user. */
export async function readImage(file: Blob & { name?: string }): Promise<ImageAttachment> {
  const mediaType = file.type;
  if (!isImageType(mediaType)) throw new Error(`${file.name || 'That image'}: only PNG, JPEG, GIF and WebP images can be attached.`);
  if (file.size > ATTACHMENT_LIMITS.imageBytes) throw new Error(`${file.name || 'Pasted image'}: images can be at most ${formatSize(ATTACHMENT_LIMITS.imageBytes)} (this one is ${formatSize(file.size)}).`);
  const dataBase64 = await blobBase64(file);
  // Screenshots paste as "image.png"; give them a name the chips and transcript can tell apart.
  const name = !file.name || /^image\.(png|jpe?g|gif|webp)$/i.test(file.name) ? `Pasted image ${++pasteCount}.${mediaType.split('/')[1]!.replace('jpeg', 'jpg')}` : file.name;
  return { kind: 'image', mediaType, dataBase64, name };
}

/**
 * Add `incoming` to `current` within the limits. Returns what fits and one message per refusal.
 * Duplicates (same file path, or same image data) are skipped silently.
 */
export function withinLimits(current: readonly MessageAttachment[], incoming: readonly MessageAttachment[]): { added: MessageAttachment[]; errors: string[] } {
  const added: MessageAttachment[] = [];
  const errors: string[] = [];
  let images = current.reduce((n, a) => n + (a.kind === 'image' ? base64Bytes(a.dataBase64) : 0), 0);
  const same = (a: MessageAttachment, b: MessageAttachment) => (a.kind === 'file' && b.kind === 'file' ? a.path === b.path : a.kind === 'image' && b.kind === 'image' ? a.dataBase64 === b.dataBase64 : false);
  for (const a of incoming) {
    if ([...current, ...added].some((c) => same(c, a))) continue;
    if (current.length + added.length >= ATTACHMENT_LIMITS.count) {
      errors.push(`At most ${ATTACHMENT_LIMITS.count} attachments per message.`);
      break;
    }
    if (a.kind === 'image') {
      const bytes = base64Bytes(a.dataBase64);
      if (images + bytes > ATTACHMENT_LIMITS.imagesTotalBytes) {
        errors.push(`${attachmentName(a)}: images in one message can total at most ${formatSize(ATTACHMENT_LIMITS.imagesTotalBytes)}.`);
        continue;
      }
      images += bytes;
    } else if (a.size > ATTACHMENT_LIMITS.fileBytes) {
      errors.push(`${a.name}: files can be at most ${formatSize(ATTACHMENT_LIMITS.fileBytes)} (this one is ${formatSize(a.size)}).`);
      continue;
    }
    added.push(a);
  }
  return { added, errors };
}

export function rejectedMessages(r: PickedAttachments['rejected']): string[] {
  return r.map((x) => `${x.name}: ${x.reason}`);
}

/** The message text when only attachments were given (UserMessage text cannot be empty). */
export function attachmentOnlyText(atts: readonly MessageAttachment[]): string {
  const images = atts.filter((a) => a.kind === 'image').length;
  const files = atts.length - images;
  if (images && !files) return images === 1 ? 'See the attached image.' : 'See the attached images.';
  if (files && !images) return files === 1 ? 'See the attached file.' : 'See the attached files.';
  return 'See the attached images and files.';
}
