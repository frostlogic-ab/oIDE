/**
 * Shown in place of the preview and editor for a broken import (`meta.brokenImport`): a link-only
 * import made by an older oIDE, whose only version is a notice. Two ways out, plus Delete:
 * - Retrieve with an agent (`artifacts.refresh`): an agent reads the link with the user's Claude Code
 *   CLI and hands the files back as the next version (ADR 0014). While it runs, and after it failed,
 *   the retrieval block shows in its place.
 * - Choose files…: the downloaded files become a new artifact (`artifacts.importFiles`, keeping the
 *   link), and the empty import is deleted once that worked.
 */
import { useId, useState } from 'react';
import { classifyClaudeLink, type ArtifactMeta } from '@oide/protocol';
import { Badge, Button } from '@oide/ui';
import { ipcErrorMessage, oide } from '../../lib/bridge';
import { toast } from '../../stores/ui';
import { activeRetrieval } from './model';
import { ProjectPrompt, RetrievalStatus, type RetrievalActions } from './Retrieval';

export interface FixImportPanelProps {
  meta: ArtifactMeta;
  actions: RetrievalActions;
  /** A new artifact replaced the empty import (which has been deleted). */
  onReplaced: (meta: ArtifactMeta) => void;
  onDelete: () => void;
  /** Focus the first action (the open view; the detail pane leaves focus where it is). */
  autoFocus?: boolean;
}

export function FixImportPanel({ meta, actions, onReplaced, onDelete, autoFocus }: FixImportPanelProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();
  // Older versions accepted any claude.ai link (a chat or share page); those can't be retrieved and
  // are not carried over to a replacement.
  const link = meta.importedFrom && classifyClaudeLink(meta.importedFrom).ok ? meta.importedFrom : undefined;

  if (activeRetrieval(meta) === 'retrieving') return <RetrievalStatus meta={meta} actions={actions} onDelete={onDelete} />;
  const failed = activeRetrieval(meta) === 'failed';

  /** The chosen files become a new artifact; the empty import is deleted after that worked. */
  const chooseFiles = async () => {
    setError(null);
    let paths: string[];
    try {
      paths = await oide.invoke('dialog.pickArtifactFiles', { folder: false });
    } catch (err) {
      return setError(ipcErrorMessage(err));
    }
    if (!paths.length) return;
    setBusy(true);
    try {
      const next = await oide.invoke('artifacts.importFiles', {
        filePaths: paths,
        ...(link ? { url: link } : {}),
        title: meta.title,
        ...(meta.projectId ? { projectId: meta.projectId } : {}),
        location: meta.location,
      });
      try {
        // Only while it is still the empty import this panel showed: an agent may have written the
        // real content into it meanwhile, and that must not be deleted.
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

  return (
    <section aria-labelledby={titleId} className="flex flex-col gap-3 rounded-xl border border-bad-line bg-bad-bg px-4 py-3.5 box-border">
      <div className="flex flex-col gap-1">
        <h3 id={titleId} className="m-0 text-[14px] font-semibold text-ink">
          This import has no content
        </h3>
        <p className="m-0 text-[12.5px] text-ink-2 leading-[1.5]">
          An older oIDE saved only the link.{' '}
          {link ? 'An agent can retrieve the files with your Claude Code CLI, or you can choose files you downloaded.' : 'Choose the files you downloaded to replace it.'}
        </p>
        {failed && (
          <p className="m-0 text-[12.5px] text-ink-2 leading-[1.5] break-words">
            <strong className="font-semibold text-ink">The last retrieval failed:</strong> {meta.retrieval?.error ?? 'the agent stopped without handing over the files.'}
          </p>
        )}
      </div>
      {actions.askProject ? (
        <ProjectPrompt actions={actions} label="Retrieve" />
      ) : (
        <div className="flex items-center gap-2 flex-wrap">
          {link && (
            <Button size={32} variant="primary" icon="refresh" autoFocus={autoFocus} onClick={() => void actions.refresh()} disabled={busy || actions.busy !== null}>
              {actions.busy === 'refresh' ? 'Starting…' : failed ? 'Retry with an agent' : 'Retrieve with an agent'}
            </Button>
          )}
          <Button size={32} icon="file" autoFocus={autoFocus && !link} onClick={() => void chooseFiles()} disabled={busy}>
            {busy ? 'Importing…' : 'Choose files…'}
          </Button>
          <span className="flex-1" />
          <Button size={32} variant="danger" icon="trash" onClick={onDelete} disabled={busy}>
            Delete
          </Button>
        </div>
      )}
      {(error || actions.error) && (
        <span role="alert" className="text-[12px] text-bad">
          {error ?? actions.error}
        </span>
      )}
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
