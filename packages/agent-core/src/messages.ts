import type { ContextChip, UserMessage } from '@oide/protocol';

/** The stream-json user message the CLI reads on stdin (verified on CLI 2.1.325). */
export interface StreamJsonUserMessage {
  type: 'user';
  message: { role: 'user'; content: string | Array<{ type: 'text'; text: string }> };
}

export interface ArtifactRef {
  id: string;
  title?: string;
  /** Absolute path of the artifact's entry file, when it lives on disk. */
  path?: string;
}

export type ArtifactResolver = (id: string) => ArtifactRef | undefined;

export function textMessage(text: string): StreamJsonUserMessage {
  return { type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } };
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
      return textMessage(msg.text);
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
      return textMessage(parts.join('\n\n'));
    }
  }
}
