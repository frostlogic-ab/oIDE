import type { ContextChip, MessageAttachment, UserMessage } from '@oide/protocol';

export type StreamJsonTextBlock = { type: 'text'; text: string };
/** Verified on CLI 2.1.325: accepted on stdin, kept in the session as image content (see cli-integration.md). */
export type StreamJsonImageBlock = { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };
export type StreamJsonContentBlock = StreamJsonTextBlock | StreamJsonImageBlock;

/** The stream-json user message the CLI reads on stdin (verified on CLI 2.1.325). */
export interface StreamJsonUserMessage {
  type: 'user';
  message: { role: 'user'; content: string | StreamJsonContentBlock[] };
}

/** The text parts of a stream-json user message (for the transcript's `user-text`). */
export function messageText(msg: StreamJsonUserMessage): string {
  const c = msg.message.content;
  return typeof c === 'string' ? c : c.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n');
}

export interface ArtifactRef {
  id: string;
  title?: string;
  /** Absolute path of the artifact's entry file, when it lives on disk. */
  path?: string;
}

export type ArtifactResolver = (id: string) => ArtifactRef | undefined;

export function textMessage(text: string, attachments?: readonly MessageAttachment[]): StreamJsonUserMessage {
  return { type: 'user', message: { role: 'user', content: contentBlocks(text, attachments) } };
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Files attached to a message, named for the agent. By the time a message reaches the driver, main has
 * copied each file into the agent's folder and `path` is that copy's path relative to it.
 */
export function describeFiles(attachments: readonly MessageAttachment[] | undefined): string {
  const files = (attachments ?? []).filter((a) => a.kind === 'file');
  if (!files.length) return '';
  const lines = files.map((f) => `- ${f.path} (${f.name}, ${formatBytes(f.size)})`);
  return `Attached ${files.length === 1 ? 'file' : 'files'} (copied into your working folder; read ${files.length === 1 ? 'it' : 'them'} from there):\n${lines.join('\n')}`;
}

/**
 * Content blocks for a user message: images first (the shape verified with the real CLI: the model
 * named the image's colour), then one text block with the text and the attached files' paths.
 */
export function contentBlocks(text: string, attachments?: readonly MessageAttachment[]): StreamJsonContentBlock[] {
  const images: StreamJsonImageBlock[] = (attachments ?? []).flatMap((a) =>
    a.kind === 'image' ? [{ type: 'image' as const, source: { type: 'base64' as const, media_type: a.mediaType, data: a.dataBase64 } }] : [],
  );
  const files = describeFiles(attachments);
  const body = [text, files].filter(Boolean).join('\n\n');
  return [...images, { type: 'text', text: body || (images.length ? 'See the attached image.' : '') }];
}

/**
 * Slash commands go as a plain string content (`"/compact"`): verified that the CLI runs them as local
 * commands and answers with `system/status compacting`, `system/compact_boundary` and a `result`.
 */
export function commandMessage(command: string): StreamJsonUserMessage {
  return { type: 'user', message: { role: 'user', content: command } };
}

export function describeArtifact(ref: ArtifactRef): string {
  const title = ref.title ? `"${ref.title}" ` : '';
  const where = ref.path ? ` It is stored at ${ref.path}.` : '';
  return `oIDE artifact ${title}(id ${ref.id}): read it with the mcp__oide__artifacts_read tool using {"id":"${ref.id}"} and update it with mcp__oide__artifacts_write.${where}`;
}

export function describeContext(chips: ContextChip[], resolve?: ArtifactResolver): string {
  if (!chips.length) return '';
  const lines = chips.map((c) => {
    if (c.kind === 'artifact') return `- ${describeArtifact({ title: c.title, ...resolve?.(c.id), id: c.id })}`;
    if (c.kind === 'file') return `- File: ${c.path}${c.title ? ` (${c.title})` : ''}`;
    return `- URL: ${c.url}${c.title ? ` (${c.title})` : ''}`;
  });
  return `Context for this task:\n${lines.join('\n')}`;
}

/** Turn a UserMessage from the UI into the stream-json line content. */
export function toStreamJson(msg: UserMessage, resolve?: ArtifactResolver): StreamJsonUserMessage {
  switch (msg.kind) {
    case 'text':
      return textMessage(msg.text, msg.attachments);
    case 'command':
      return commandMessage(msg.command);
    case 'review-feedback': {
      // A comment on a removed line names the old-side line: that line no longer exists in the file.
      const ref = (c: (typeof msg.comments)[number]) => (c.line === undefined ? c.path : c.side === 'old' ? `${c.path} (removed line ${c.line})` : `${c.path}:${c.line}`);
      const lines = msg.comments.map((c) => `- ${ref(c)}: ${c.body}`);
      const parts = ['Review feedback on your changes. Address each comment below.'];
      if (lines.length) parts.push(lines.join('\n'));
      if (msg.note) parts.push(`Overall note: ${msg.note}`);
      parts.push('When you are done, commit and call mcp__oide__submit_for_review again with an updated summary and checks.');
      return textMessage(parts.join('\n\n'));
    }
    case 'artifact': {
      const ref = resolve?.(msg.artifactId) ?? { id: msg.artifactId };
      const parts = [`Use this ${describeArtifact(ref)}`];
      if (msg.note) parts.push(msg.note);
      return textMessage(parts.join('\n\n'), msg.attachments);
    }
  }
}
