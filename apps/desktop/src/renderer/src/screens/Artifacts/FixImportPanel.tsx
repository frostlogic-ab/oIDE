/**
 * Shown in place of the preview and editor for a broken import (`meta.brokenImport`): a link-only
 * import made by an older oIDE, whose only version is a notice. oIDE can't download claude.ai
 * artifacts, so the way out is the code itself: paste it (saved as the next version, or as a new
 * artifact when it doesn't fit the old one's kind), or choose or drop the downloaded file (a proper
 * artifact replaces the empty one). Delete removes the empty import.
 */
import { useId, useMemo, useState } from 'react';
import { classifyClaudeLink, type ArtifactMeta } from '@oide/protocol';
import { Badge, Button, TextArea } from '@oide/ui';
import { ipcErrorMessage, oide } from '../../lib/bridge';
import { toast } from '../../stores/ui';
import { useFileDrop } from './drop';
import { IMPORT_EXTENSIONS, KIND_LABEL, canOpenClaudeLink, fixImportPlan, importContentError } from './model';

export interface FixImportPanelProps {
  meta: ArtifactMeta;
  /** Focus the paste box (the open view; the detail pane leaves focus where it is). */
  autoFocus?: boolean;
  /** The pasted code was saved as the next version of this artifact. */
  onSaved: (meta: ArtifactMeta, content: string) => void;
  /** A new artifact replaced the empty import (which has been deleted). */
  onReplaced: (meta: ArtifactMeta) => void;
  onDelete: () => void;
}

export function FixImportPanel({ meta, autoFocus, onSaved, onReplaced, onDelete }: FixImportPanelProps) {
  const [content, setContent] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hintId = useId();
  const errorId = useId();
  const titleId = useId();

  const hasContent = content.trim().length > 0;
  const plan = useMemo(() => (hasContent ? fixImportPlan(meta.kind, content) : null), [hasContent, meta.kind, content]);
  // The paste is checked as the kind it will be stored as.
  const contentError = useMemo(() => (hasContent && plan ? importContentError(plan.mode === 'save' ? meta.kind : plan.kind, content) : undefined), [hasContent, plan, meta.kind, content]);
  const claude = canOpenClaudeLink(meta.importedFrom) ? meta.importedFrom : undefined;
  // Older versions accepted any claude.ai link (a chat or share page); the import now refuses those, so
  // such a link is not carried over to the replacement (it would block the fix).
  const keepLink = meta.importedFrom && classifyClaudeLink(meta.importedFrom).ok ? meta.importedFrom : undefined;

  /** A new artifact from `source` replaces this one: import first, delete the empty one after it worked. */
  const replaceWith = async (source: { content: string } | { filePath: string }) => {
    setBusy(true);
    setError(null);
    try {
      const next = await oide.invoke('artifacts.import', {
        ...source,
        ...(keepLink ? { url: keepLink } : {}),
        title: meta.title,
        projectId: meta.projectId,
        location: meta.location,
      });
      try {
        // Only while it is still the empty import this panel showed: an agent may have written the
        // real content into it meanwhile (artifacts_write), and that must not be deleted.
        const now = await oide.invoke('artifacts.get', { id: meta.id });
        if (now.meta.brokenImport && now.meta.version === meta.version) {
          await oide.invoke('artifacts.delete', { id: meta.id });
          toast(`Imported ${next.title}`, 'success');
        } else toast(`Imported ${next.title}. Kept ${meta.title}: it changed while you were importing.`, 'info');
      } catch (err) {
        toast(`Imported ${next.title}, but couldn't delete the empty import: ${ipcErrorMessage(err)}`, 'error');
      }
      onReplaced(next);
    } catch (err) {
      setError(ipcErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!plan || contentError || busy) return;
    if (plan.mode === 'replace') return replaceWith({ content });
    setBusy(true);
    setError(null);
    try {
      const next = await oide.invoke('artifacts.save', { id: meta.id, content, note: 'Imported from claude.ai', baseVersion: meta.version });
      toast(`Saved ${meta.title} as v${next.version}`, 'success');
      onSaved(next, content);
    } catch (err) {
      setError(ipcErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const importFile = (path: string) => void replaceWith({ filePath: path });

  const choose = async () => {
    setError(null);
    try {
      const path = await oide.invoke('dialog.pickFile', { title: 'Import an artifact', filters: [{ name: 'Artifacts', extensions: [...IMPORT_EXTENSIONS] }] });
      if (path) importFile(path);
    } catch (err) {
      setError(ipcErrorMessage(err));
    }
  };

  const { dragging, dropProps } = useFileDrop((f) => {
    if ('error' in f) setError(f.error);
    else importFile(f.path);
  }, busy);

  return (
    <section aria-labelledby={titleId} {...dropProps} className="relative flex flex-col gap-3 rounded-xl border border-bad-line bg-bad-bg px-4 py-3.5 box-border">
      {dragging && (
        <div aria-hidden="true" className="absolute inset-0 z-10 rounded-xl border-2 border-dashed border-accent bg-panel/90 flex items-center justify-center text-[13px] text-ink pointer-events-none">
          Drop the file to replace this import
        </div>
      )}
      <div className="flex flex-col gap-1">
        <h3 id={titleId} className="m-0 text-[14px] font-semibold text-ink">
          This import has no content
        </h3>
        <p className="m-0 text-[12.5px] text-ink-2 leading-[1.5]">oIDE can&apos;t download claude.ai artifacts, so the link came in without the design.</p>
      </div>
      {claude && (
        <div>
          <Button size={28} icon="external-link" onClick={() => void oide.invoke('shell.openExternal', { url: claude }).catch((err) => toast(ipcErrorMessage(err), 'error'))}>
            Open on claude.ai
          </Button>
        </div>
      )}
      <div className="flex flex-col gap-1.5">
        <TextArea
          label="Paste the artifact's code"
          mono
          rows={6}
          value={content}
          autoFocus={autoFocus}
          onChange={(e) => {
            setContent(e.target.value);
            setError(null);
          }}
          placeholder="<!doctype html>… or import React from 'react'…"
          aria-invalid={contentError ? true : undefined}
          aria-describedby={contentError ? `${hintId} ${errorId}` : hintId}
          className="max-h-[260px] resize-y aria-[invalid=true]:border-bad-line"
        />
        <span id={hintId} className="text-[12px] text-ink-3 leading-[1.45]">
          On claude.ai, use Copy (or Download) on the artifact, then paste the code here.
          {plan?.mode === 'replace' && ` This looks like a ${KIND_LABEL[plan.kind].toLowerCase()}, so Save replaces this import with a new one.`}
        </span>
        {contentError && (
          <span id={errorId} role="alert" className="text-[12px] text-bad">
            {contentError}
          </span>
        )}
        {error && (
          <span role="alert" className="text-[12px] text-bad">
            {error}
          </span>
        )}
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <Button size={32} variant="primary" onClick={() => void save()} disabled={busy || !hasContent || Boolean(contentError)}>
          {busy ? 'Saving…' : 'Save'}
        </Button>
        <Button size={32} onClick={() => void choose()} disabled={busy}>
          Choose downloaded file…
        </Button>
        <span className="flex-1" />
        <Button size={32} variant="danger" icon="trash" onClick={onDelete} disabled={busy}>
          Delete
        </Button>
      </div>
      <span className="text-[12px] text-ink-3 leading-[1.45]">Or drop the downloaded file here. Replaces this empty import with the file.</span>
    </section>
  );
}

/** The grid card's badge: text and an icon, not colour alone. */
export function BrokenImportBadge() {
  return (
    <Badge tone="bad" icon="alert-circle">
      Import has no content
    </Badge>
  );
}
