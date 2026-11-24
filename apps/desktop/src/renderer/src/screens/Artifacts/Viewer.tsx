/**
 * "Open": the artifact full size, with a source editor (textarea) for every kind. Docs show a live
 * Markdown preview beside the editor; designs and whiteboards preview the unsaved source inline.
 * Save writes a new numbered version (`artifacts.save`).
 */
import { useEffect, useRef, useState } from 'react';
import type { ArtifactMeta } from '@oide/protocol';
import { Badge, Button, Dialog, Tabs, tabPanelProps } from '@oide/ui';
import { ipcErrorMessage, oide } from '../../lib/bridge';
import { useKeymapScope } from '../../lib/useKeymap';
import { toast } from '../../stores/ui';
import { ArtifactPreview } from './Preview';
import { KIND_LABEL, validateContent } from './model';

type Mode = 'preview' | 'edit';

export interface ViewerProps {
  meta: ArtifactMeta;
  content: string;
  projectName: string;
  onClose: () => void;
  onSaved: (meta: ArtifactMeta, content: string) => void;
}

export function Viewer({ meta, content, projectName, onClose, onSaved }: ViewerProps) {
  const [mode, setMode] = useState<Mode>(meta.kind === 'doc' ? 'edit' : 'preview');
  const [draft, setDraft] = useState(content);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const dirty = draft !== content;

  useEffect(() => setDraft(content), [content]);
  useEffect(() => headingRef.current?.focus(), []);

  const requestClose = () => (dirty ? setConfirmClose(true) : onClose());
  useKeymapScope('artifact-viewer', { 'view.back': () => requestClose() });

  const save = async () => {
    const invalid = validateContent(meta.kind, draft);
    if (invalid) {
      setError(invalid);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const next = await oide.invoke('artifacts.save', { id: meta.id, content: draft, note: 'Edited by you' });
      onSaved(next, draft);
      toast(`Saved ${meta.title} as v${next.version}`, 'success');
    } catch (err) {
      setError(ipcErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const editor = (
    <label className="flex flex-col min-h-0 flex-1 gap-1.5">
      <span className="sr-only">Source of {meta.title}</span>
      <textarea
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          setError(null);
        }}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
            e.preventDefault();
            void save();
          }
        }}
        spellCheck={meta.kind === 'doc'}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? 'viewer-error' : undefined}
        className="flex-1 min-h-0 resize-none p-3 rounded-lg border border-line-3 bg-chrome text-ink font-mono text-[12.5px] leading-[1.6] outline-none focus:border-accent"
      />
    </label>
  );

  return (
    <section aria-label={`${meta.title} (open)`} className="flex-1 min-w-0 flex flex-col">
      <div className="flex items-center gap-3 px-5 py-3 border-b border-line bg-panel flex-wrap">
        <Button size={32} icon="chevron-left" onClick={requestClose}>
          Artifacts
        </Button>
        <div className="flex flex-col gap-0.5 min-w-0">
          <h2 ref={headingRef} tabIndex={-1} className="m-0 text-[16px] font-semibold outline-none truncate">
            {meta.title}
          </h2>
          <span className="text-[12px] text-ink-3">
            {KIND_LABEL[meta.kind]} · {projectName || 'Personal'} · v{meta.version}
          </span>
        </div>
        {dirty && <Badge tone="warn">Unsaved changes</Badge>}
        <div className="flex-1" />
        <Tabs
          label="View"
          idPrefix="viewer"
          variant="pill"
          tabs={[
            { id: 'preview', label: 'Preview' },
            { id: 'edit', label: meta.kind === 'doc' ? 'Edit' : 'Edit source' },
          ]}
          value={mode}
          onChange={setMode}
        />
        <Button size={32} variant="primary" onClick={() => void save()} disabled={!dirty || saving}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>
      {error && (
        <div id="viewer-error" role="alert" className="px-5 py-2 text-[12.5px] text-bad bg-bad-bg border-b border-bad-line">
          {error}
        </div>
      )}
      <div {...tabPanelProps('viewer', mode)} className="flex-1 min-h-0 flex gap-4 p-4 outline-none">
        {mode === 'edit' && editor}
        {(mode === 'preview' || meta.kind === 'doc') && (
          <div className="flex-1 min-w-0 min-h-0 rounded-xl border border-line-2 bg-raised overflow-hidden">
            <ArtifactPreview artifactId={meta.id} title={meta.title} kind={meta.kind} content={draft} forceInline={dirty} version={meta.version} />
          </div>
        )}
      </div>
      <Dialog
        open={confirmClose}
        onClose={() => setConfirmClose(false)}
        title="Discard your changes?"
        description={`Your edits to ${meta.title} are not saved.`}
        footer={
          <>
            <Button size={32} onClick={() => setConfirmClose(false)}>
              Keep editing
            </Button>
            <Button size={32} variant="danger" onClick={onClose}>
              Discard
            </Button>
          </>
        }
      />
    </section>
  );
}
