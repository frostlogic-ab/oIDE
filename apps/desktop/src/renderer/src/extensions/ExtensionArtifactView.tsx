import { useCallback, useEffect, useRef } from 'react';
import type { ArtifactMeta } from '@oide/protocol';
import { ipcErrorMessage, oide } from '../lib/bridge';
import { toast } from '../stores/ui';
import { ExtensionFrame } from './ExtensionFrame';
import type { ArtifactTypeRef } from './model';
import { postToFrame, type FrameEntry } from './panelBridge';

/** Largest artifact content a viewer may save (characters). */
const MAX_CONTENT = 5 * 1024 * 1024;

/**
 * The viewer and editor of an extension artifact type (`contributes.artifactTypes`): the
 * extension's entry HTML in a sandboxed iframe. The app sends it the artifact as
 * `{ type: 'oide:artifact', artifact: { id, title, kind, type, version, content } }` when it loads
 * or posts `{ type: 'oide:ready' }`; the viewer saves with `{ type: 'oide:artifact.save', content }`,
 * which becomes a new version of this artifact only. Viewers never reach host code or other artifacts.
 */
export function ExtensionArtifactView({
  meta,
  content,
  type,
  onSaved,
}: {
  meta: ArtifactMeta;
  content: string;
  type: ArtifactTypeRef;
  onSaved(meta: ArtifactMeta, content: string): void;
}) {
  const entry = useRef<FrameEntry | null>(null);
  const latest = useRef({ meta, content });
  latest.current = { meta, content };

  const send = useCallback(() => {
    const f = entry.current;
    const { meta: m, content: c } = latest.current;
    if (f)
      postToFrame(f, {
        type: 'oide:artifact',
        artifact: {
          id: m.id,
          title: m.title,
          kind: m.kind,
          type: m.type ?? '',
          version: m.version,
          content: c,
        },
      });
  }, []);

  useEffect(() => send(), [meta.version, content, send]);

  const onAppMessage = async (data: Record<string, unknown> & { type: string }) => {
    if (data.type === 'oide:ready') {
      send();
      return;
    }
    if (data.type !== 'oide:artifact.save') return;
    const next = data.content;
    if (typeof next !== 'string' || next.length > MAX_CONTENT) {
      toast(`${type.label}: the viewer sent content oIDE cannot save`, 'error');
      return;
    }
    if (next === latest.current.content) return;
    try {
      const saved = await oide.invoke('artifacts.save', {
        id: latest.current.meta.id,
        content: next,
        note: `Edited in ${type.label} (${type.displayName})`,
      });
      onSaved(saved, next);
      toast(`Saved ${saved.title} as v${saved.version}`, 'success');
    } catch (err) {
      toast(`Could not save: ${ipcErrorMessage(err)}`, 'error');
    }
  };

  return (
    <ExtensionFrame
      extension={type.extension}
      kind="artifactType"
      id={type.id}
      title={`${meta.title} (${type.label})`}
      context={{ artifactId: meta.id }}
      onAppMessage={(d) => void onAppMessage(d)}
      onEntry={(e) => {
        entry.current = e;
      }}
      onLoad={send}
      className="h-full"
    />
  );
}
