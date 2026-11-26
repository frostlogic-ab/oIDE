/**
 * "Open": the artifact full size, with an editor per kind (all lazy chunks):
 * - doc: Monaco (Markdown) with the rendered preview live beside it.
 * - design: Monaco (HTML) beside the sandboxed preview, which reloads when you save.
 * - whiteboard: the embedded Excalidraw editor.
 * Plus Preview (docs, designs) and Compare (a side-by-side diff of any two versions, or of a version
 * and your unsaved edits).
 *
 * Save writes a new numbered version (`artifacts.save` with `baseVersion`; `artifacts.writeFiles`
 * for an artifact of several files). When an agent saves while the artifact is open
 * (`artifacts.changed` reloads `detail`), the editor loads it and says "Updated by <agent>"; with
 * unsaved edits it keeps them and shows a conflict banner instead.
 *
 * An artifact of several files (ADR 0014) gets a Files panel: the entry opens in the editors above,
 * any other text file in Monaco (FilesPanel.tsx), an image inline, and a design's other pages offer
 * "Open on this page". With no files yet (version 0, a link being retrieved or a failed retrieval)
 * the retrieval status stands in for the editors.
 */
import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ArtifactFile, ArtifactMeta, CommandOutput } from '@oide/protocol';
import { Badge, Button, Dialog, DiffStat, Icon, Menu, Select, Spinner, Tabs, tabPanelProps } from '@oide/ui';
import { formatSize } from '../../lib/attachments';
import { invokeOr, ipcErrorCode, ipcErrorMessage, oide } from '../../lib/bridge';
import { useKeymapScope } from '../../lib/useKeymap';
import { useAgents } from '../../stores/agents';
import { toast } from '../../stores/ui';
import { ExtensionArtifactView } from '../../extensions/ExtensionArtifactView';
import { artifactTypeOf } from '../../extensions/model';
import { useExtensions } from '../../extensions/store';
import { FilesPanel, useArtifactFile, type ArtifactFileState } from './FilesPanel';
import { useArtifactDrafts } from './draftStore';
import { FixImportPanel } from './FixImportPanel';
import { DesignFrame, MarkdownView } from './Preview';
import { RetrievalStatus, useRetrieval } from './Retrieval';
import {
  KIND_LABEL,
  authorLabel,
  contentForDiff,
  imageDataUrl,
  isImagePath,
  isPagePath,
  languageForPath,
  liveDecision,
  sourceLanguage,
  validateContent,
  versionLabel,
} from './model';

const SourceEditor = lazy(() => import('./SourceEditor'));
const VersionDiff = lazy(() => import('./VersionDiff'));
const WhiteboardEditor = lazy(() => import('./WhiteboardEditor'));

type Detail = CommandOutput<'artifacts.get'>;
export type ViewerMode = 'edit' | 'preview' | 'compare';
/** A side of the comparison: a version number or the unsaved draft. */
export type CompareSide = number | 'draft';

export interface ViewerProps {
  detail: Detail;
  projectName: string;
  initialMode?: ViewerMode;
  /** Versions to compare when opening in Compare. */
  compare?: { from: CompareSide; to: CompareSide };
  onClose: () => void;
  onSaved: (meta: ArtifactMeta, content: string) => void;
  /** New meta from main without new content (a retrieval started or was cancelled, a new entry). */
  onMeta: (meta: ArtifactMeta) => void;
  /** A broken import was replaced by a new artifact (the empty one is deleted). */
  onReplaced: (meta: ArtifactMeta) => void;
  onRename: () => void;
  onDelete: () => void;
}

interface Other {
  version: number;
  content: string;
  author: string | undefined;
}

export function Viewer({
  detail,
  projectName,
  initialMode,
  compare: initialCompare,
  onClose,
  onSaved,
  onMeta,
  onReplaced,
  onRename,
  onDelete,
}: ViewerProps) {
  const { meta } = detail;
  const kind = meta.kind;
  const agents = useAgents((s) => s.byId);
  const agentTitle = (id: string) => agents[id]?.title;

  const installed = useExtensions((s) => s.installed);
  const extType = artifactTypeOf(installed, meta.type);
  // An extension artifact type opens in its own viewer (Preview); everything else in the editor.
  const [mode, setMode] = useState<ViewerMode>(initialMode ?? (meta.type ? 'preview' : 'edit'));
  /** The saved version the editor is based on. */
  // Unsaved edits kept when the screen was left (draftStore.ts): resume them. When the artifact moved
  // on meanwhile, the draft keeps its old base and the conflict banner below takes over.
  const [resumed] = useState(() => {
    const d = useArtifactDrafts.getState().drafts[detail.meta.id];
    // A draft of another entry file (an agent moved the artifact's page) is not this file's text.
    return d && d.entry === detail.meta.entry && d.baseVersion <= detail.meta.version && d.draft !== d.baseline ? d : undefined;
  });
  const [base, setBase] = useState(resumed ? { version: resumed.baseVersion, content: resumed.baseContent } : { version: meta.version, content: detail.content });
  const [draft, setDraft] = useState(resumed ? resumed.draft : detail.content);
  /** What "unchanged" looks like: the base content, or (whiteboards) Excalidraw's serialisation of it. */
  const [baseline, setBaseline] = useState<string | null>(resumed ? resumed.baseline : kind === 'whiteboard' ? null : detail.content);
  const [sceneKey, setSceneKey] = useState(0);
  const [notice, setNotice] = useState<Other | null>(null);
  const [conflict, setConflict] = useState<Other | null>(null);
  const [compare, setCompare] = useState<{ from: CompareSide; to: CompareSide } | null>(
    initialCompare ?? null,
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const own = useRef(new Set<number>());
  const dirty = baseline !== null && draft !== baseline;
  const live = useRef({ base, dirty, entry: meta.entry });
  /** The entry file the editor's text belongs to (`live.entry` moves as soon as an agent changes it). */
  const draftEntry = useRef(meta.entry);
  live.current = { ...live.current, base, dirty };
  // A kept draft of an entry file the artifact no longer opens on (an agent changed its page since):
  // it is not this file's text, so it is dropped (by the effect below) and the user is told.
  const [staleDraft] = useState(() => {
    const d = useArtifactDrafts.getState().drafts[detail.meta.id];
    return Boolean(d && d.entry !== detail.meta.entry);
  });
  const staleToasted = useRef(false);
  useEffect(() => {
    if (!staleDraft || staleToasted.current) return;
    staleToasted.current = true;
    toast(`${meta.title} now opens on another page, so your unsaved edits to the old one were discarded.`, 'warning');
  }, [staleDraft, meta.title]);
  // Keep the unsaved entry edits outside this component so leaving the screen does not lose them.
  // Not cleared on unmount: that is the point. Save, "Use theirs" and Discard make it not dirty or clear it.
  useEffect(() => {
    const drafts = useArtifactDrafts.getState();
    if (dirty && baseline !== null) drafts.set(meta.id, { baseVersion: base.version, baseContent: base.content, baseline, entry: draftEntry.current, draft });
    else drafts.clear(meta.id);
  }, [dirty, baseline, draft, base, meta.id]);
  const retrieval = useRetrieval(meta, onMeta);

  // Several files: the Files panel, and one other file open at a time (null = the entry).
  const multi = (meta.fileCount ?? 1) > 1;
  const [files, setFiles] = useState<ArtifactFile[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [switchTo, setSwitchTo] = useState<string | null>(null);
  const otherPath = multi && selected && selected !== meta.entry ? selected : null;
  const otherInfo = otherPath ? files?.find((f) => f.path === otherPath) : undefined;
  useEffect(() => {
    if (!multi) return setFiles(null);
    let on = true;
    invokeOr('artifacts.files', { id: meta.id }, [])
      .then((list) => on && setFiles(list))
      .catch((err) => on && setError(`Couldn't list the files: ${ipcErrorMessage(err)}`));
    return () => {
      on = false;
    };
  }, [meta.id, meta.version, multi]);

  // A broken import puts the cursor in its paste box instead.
  useEffect(() => {
    if (!meta.brokenImport) headingRef.current?.focus();
    // On open only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const authorOf = (version: number) => detail.versions.find((v) => v.version === version)?.author;
  const file = useArtifactFile({
    id: meta.id,
    path: otherPath && otherInfo?.text !== false ? otherPath : null,
    version: meta.version,
    authorOf,
    own,
    onSaved: (next) => {
      toast(`Saved ${otherPath} as v${next.version}`, 'success');
      onSaved(next, base.content);
    },
  });
  const anyDirty = dirty || file.dirty;

  // An artifacts.changed reload brought a newer version: ours, someone else's, or a conflict.
  useEffect(() => {
    const incoming = {
      version: detail.meta.version,
      content: detail.content,
      author: authorOf(detail.meta.version),
    };
    // The entry moved to another file ("Open on this page", or an agent): the editor starts from it.
    if (detail.meta.entry !== live.current.entry) {
      live.current.entry = detail.meta.entry;
      if (!live.current.dirty) return loadOther(incoming, false);
    }
    const d = liveDecision({
      baseVersion: live.current.base.version,
      incomingVersion: incoming.version,
      ownVersions: own.current,
      dirty: live.current.dirty,
    });
    // A version that left the entry as it was (another file changed): no reload, no conflict.
    if ((d === 'reload' || d === 'conflict') && incoming.content === live.current.base.content) {
      setBase({ version: incoming.version, content: incoming.content });
      return;
    }
    if (d === 'own') setBase({ version: incoming.version, content: incoming.content });
    else if (d === 'reload') loadOther(incoming, true);
    else if (d === 'conflict') setConflict(incoming);
    // Only a new version, content or entry matters here; the rest is read through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail.meta.version, detail.content, detail.meta.entry]);

  /** Replace the editor content with another saved version (an agent's, or "Use theirs"). */
  const loadOther = (o: Other, announce: boolean) => {
    draftEntry.current = detail.meta.entry;
    setBase({ version: o.version, content: o.content });
    setDraft(o.content);
    setBaseline(kind === 'whiteboard' ? null : o.content);
    setSceneKey((k) => k + 1);
    setConflict(null);
    setError(null);
    setNotice(announce ? o : null);
  };

  const requestClose = () => (anyDirty ? setConfirmClose(true) : onClose());
  useKeymapScope('artifact-viewer', {
    'view.back': () => {
      // Esc inside the whiteboard belongs to Excalidraw (deselect, close a menu).
      if (document.activeElement?.closest('.oide-whiteboard')) return;
      requestClose();
    },
  });

  const save = async () => {
    if (!dirty || saving) return;
    const content = draft;
    const invalid = validateContent(kind, content);
    if (invalid) return setError(invalid);
    setSaving(true);
    setError(null);
    // With a conflict open, saving keeps your version on top of theirs (theirs stays in History).
    const over = conflict;
    try {
      const note = over ? `Edited by you over v${over.version}` : 'Edited by you';
      const baseVersion = over ? over.version : base.version;
      // Several files: only the entry changes in the new version, the other files stay as they are.
      const next = multi
        ? await oide.invoke('artifacts.writeFiles', { id: meta.id, files: [{ path: meta.entry, encoding: 'utf8', data: content }], note, baseVersion })
        : await oide.invoke('artifacts.save', { id: meta.id, content, note, baseVersion });
      own.current.add(next.version);
      draftEntry.current = meta.entry;
      setBase({ version: next.version, content });
      setBaseline(content);
      setConflict(null);
      setNotice(null);
      onSaved(next, content);
      toast(`Saved ${meta.title} as v${next.version}`, 'success');
    } catch (err) {
      if (ipcErrorCode(err) === 'conflict') {
        try {
          const fresh = await oide.invoke('artifacts.get', { id: meta.id });
          setConflict({
            version: fresh.meta.version,
            content: fresh.content,
            author: fresh.versions.find((v) => v.version === fresh.meta.version)?.author,
          });
        } catch {
          setError(ipcErrorMessage(err));
        }
      } else setError(ipcErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const tabs: Array<{ id: ViewerMode; label: string }> =
    kind === 'whiteboard'
      ? [
          { id: 'edit', label: 'Board' },
          { id: 'compare', label: 'Compare' },
        ]
      : [
          { id: 'edit', label: 'Edit' },
          { id: 'preview', label: 'Preview' },
          { id: 'compare', label: 'Compare' },
        ];

  const openCompare = (sides: { from: CompareSide; to: CompareSide }) => {
    setCompare(sides);
    setMode('compare');
  };

  /** Files panel: open another file; unsaved edits to the one open (not the entry) need a confirm. */
  const select = (path: string) => {
    const next = path === meta.entry ? null : path;
    if (next === otherPath) return;
    if (file.dirty) return setSwitchTo(path);
    setSelected(next);
    setError(null);
  };

  /** "Open on this page": a new version whose entry is `path` (no file changes). */
  const openOn = async (path: string) => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const next = await oide.invoke('artifacts.writeFiles', { id: meta.id, entry: path, note: `Opens on ${path}`, baseVersion: meta.version });
      own.current.add(next.version);
      setSelected(null);
      onMeta(next);
      toast(`${meta.title} now opens on ${path}`, 'success');
    } catch (err) {
      setError(ipcErrorCode(err) === 'conflict' ? 'Someone saved a newer version meanwhile. Try again.' : ipcErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const noFiles = meta.version === 0;
  const fileMode = otherPath !== null;
  const canSave = fileMode ? file.dirty && !file.saving : dirty && !saving;

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
            {extType ? `${extType.label} (${extType.displayName})` : KIND_LABEL[kind]} · {projectName || 'Personal'} · {noFiles ? 'no files yet' : `v${base.version}`}
            {multi && ` · ${meta.fileCount} files`}
          </span>
        </div>
        {anyDirty && <Badge tone="warn">Unsaved changes</Badge>}
        <div className="flex-1" />
        {!meta.brokenImport && !noFiles && !fileMode && <Tabs label="View" idPrefix="viewer" variant="pill" tabs={tabs} value={mode} onChange={setMode} />}
        {!meta.brokenImport && !noFiles && (
          <Button size={32} variant="primary" onClick={() => void (fileMode ? file.save() : save())} disabled={!canSave}>
            {(fileMode ? file.saving : saving) ? 'Saving…' : 'Save'}
          </Button>
        )}
        <Menu
          label={`More actions for ${meta.title}`}
          align="end"
          trigger={<Icon name="more" size={16} />}
          triggerClassName="h-8 w-8 rounded-md border border-line-3 text-ink-2 hover:bg-raised"
          items={[
            { id: 'rename', label: 'Rename', onSelect: onRename },
            { id: 'delete', label: 'Delete', danger: true, icon: 'trash', onSelect: onDelete },
          ]}
        />
      </div>

      {!fileMode && conflict && (
        <Banner tone="warn" role="alert">
          <span className="flex-1">
            <strong className="font-semibold text-ink">
              {cap(authorLabel(conflict.author, agentTitle))}
            </strong>{' '}
            saved v{conflict.version} while you were editing. Your changes are not saved yet; saving keeps
            yours as a new version on top (v{conflict.version} stays in History).
          </span>
          <Button size={28} onClick={() => openCompare({ from: conflict.version, to: 'draft' })}>
            Compare
          </Button>
          <Button size={28} variant="primary" onClick={() => void save()} disabled={saving}>
            Keep mine
          </Button>
          <Button size={28} variant="ghost" onClick={() => loadOther(conflict, false)}>
            Use theirs
          </Button>
        </Banner>
      )}
      {!fileMode && !conflict && notice && (
        <Banner tone="review" role="status">
          <span className="flex-1">
            Updated by{' '}
            <strong className="font-semibold text-ink">{authorLabel(notice.author, agentTitle)}</strong> · v
            {notice.version}
          </span>
          {notice.version > 1 && (
            <Button size={28} onClick={() => openCompare({ from: notice.version - 1, to: notice.version })}>
              See changes
            </Button>
          )}
          <Button size={28} variant="ghost" onClick={() => setNotice(null)}>
            Dismiss
          </Button>
        </Banner>
      )}
      {error && (
        <div
          id="viewer-error"
          role="alert"
          className="px-5 py-2 text-[12.5px] text-bad bg-bad-bg border-b border-bad-line"
        >
          {error}
        </div>
      )}

      {fileMode && <FileBanners file={file} path={otherPath} agentTitle={agentTitle} />}

      {meta.brokenImport ? (
        <div className="flex-1 min-h-0 overflow-auto p-4">
          <div className="max-w-[720px] mx-auto">
            <FixImportPanel meta={meta} actions={retrieval} autoFocus onReplaced={onReplaced} onDelete={onDelete} />
          </div>
        </div>
      ) : noFiles ? (
        <div className="flex-1 min-h-0 overflow-auto p-4">
          <div className="max-w-[560px] mx-auto">
            {meta.retrieval ? (
              <RetrievalStatus meta={meta} actions={retrieval} onDelete={onDelete} />
            ) : (
              <p className="m-0 text-[12.5px] text-ink-3">This artifact has no files yet.</p>
            )}
          </div>
        </div>
      ) : (
      <div className="flex-1 min-h-0 flex gap-4 p-4">
        {multi && <FilesPanel files={files} entry={meta.entry} selected={otherPath} onSelect={select} />}
        {fileMode ? (
          <OtherFile
            meta={meta}
            path={otherPath}
            info={otherInfo}
            file={file}
            busy={saving}
            entryDirty={dirty}
            onOpenOn={(p) => void openOn(p)}
            preview={kind === 'design' ? <PreviewPane kind={kind} meta={meta} draft={draft} saved={base} dirty={dirty} /> : null}
          />
        ) : (
      <div {...tabPanelProps('viewer', mode)} className="flex-1 min-w-0 min-h-0 flex gap-4 outline-none">
        <Suspense fallback={<Loading />}>
          {mode === 'edit' && kind === 'whiteboard' && (
            <div className="flex-1 min-w-0 min-h-0 rounded-xl border border-line-2 overflow-hidden">
              <WhiteboardEditor
                key={sceneKey}
                content={draft}
                title={meta.title}
                onChange={(json, initial) => {
                  // The first serialisation after loading a version is "unchanged"; a remount that
                  // restores your draft (back from Compare) keeps the earlier baseline.
                  if (initial) setBaseline((b) => b ?? json);
                  setDraft(json);
                  setError(null);
                }}
                onSave={() => void save()}
              />
            </div>
          )}
          {mode === 'edit' && kind !== 'whiteboard' && (
            <>
              <div className="flex-1 min-w-0 min-h-0 flex flex-col">
                <SourceEditor
                  value={draft}
                  language={sourceLanguage(kind, meta.entry)}
                  label={`Source of ${meta.title}`}
                  onChange={(v) => {
                    setDraft(v);
                    setError(null);
                  }}
                  onSave={() => void save()}
                />
              </div>
              <PreviewPane kind={kind} meta={meta} draft={draft} saved={base} dirty={dirty} />
            </>
          )}
          {mode === 'preview' &&
            (extType ? (
              // An extension artifact type: its own viewer and editor (sandboxed iframe).
              <div className="flex-1 min-w-0 min-h-0 rounded-xl border border-line-2 bg-raised overflow-hidden flex flex-col">
                <ExtensionArtifactView meta={meta} content={base.content} type={extType} onSaved={onSaved} />
              </div>
            ) : (
              <PreviewPane kind={kind} meta={meta} draft={draft} saved={base} dirty={dirty} />
            ))}
          {mode === 'compare' && (
            <Compare
              detail={detail}
              draft={dirty ? draft : null}
              sides={compare}
              onSides={setCompare}
              agentTitle={agentTitle}
            />
          )}
        </Suspense>
      </div>
        )}
      </div>
      )}

      <Dialog
        open={switchTo !== null}
        onClose={() => setSwitchTo(null)}
        title="Discard your changes?"
        description={`Your edits to ${otherPath ?? 'this file'} are not saved.`}
        footer={
          <>
            <Button size={32} onClick={() => setSwitchTo(null)}>
              Keep editing
            </Button>
            <Button
              size={32}
              variant="danger"
              onClick={() => {
                const to = switchTo;
                setSwitchTo(null);
                setSelected(to === meta.entry ? null : to);
              }}
            >
              Discard
            </Button>
          </>
        }
      />
      <Dialog
        open={confirmClose}
        onClose={() => setConfirmClose(false)}
        title="Discard your changes?"
        description={
          dirty
            ? `Your edits to ${meta.title} are not saved. Keep them as a draft to come back to from the grid.${file.dirty ? ` Edits to ${otherPath} are not kept.` : ''}`
            : `Your edits to ${otherPath ?? meta.title} are not saved.`
        }
        footer={
          <>
            <Button size={32} onClick={() => setConfirmClose(false)}>
              Keep editing
            </Button>
            {dirty && (
              <Button
                size={32}
                onClick={() => {
                  // The draft stays in the store (the grid card shows Unsaved); only the editor closes.
                  setConfirmClose(false);
                  onClose();
                }}
              >
                Keep as draft
              </Button>
            )}
            <Button
              size={32}
              variant="danger"
              onClick={() => {
                useArtifactDrafts.getState().clear(meta.id);
                onClose();
              }}
            >
              Discard
            </Button>
          </>
        }
      />
    </section>
  );
}

/** The "Updated by" and conflict banners of a non-entry file (same wording as the entry's). */
function FileBanners({ file, path, agentTitle }: { file: ArtifactFileState; path: string; agentTitle: (id: string) => string | undefined }) {
  if (file.conflict)
    return (
      <Banner tone="warn" role="alert">
        <span className="flex-1">
          <strong className="font-semibold text-ink">{cap(authorLabel(file.conflict.author, agentTitle))}</strong> saved v{file.conflict.version} with changes to{' '}
          <span className="font-mono">{path}</span> while you were editing it. Saving keeps yours as a new version on top (v{file.conflict.version} stays in History).
        </span>
        <Button size={28} variant="primary" onClick={() => void file.save()} disabled={file.saving}>
          Keep mine
        </Button>
        <Button size={28} variant="ghost" onClick={file.takeTheirs}>
          Use theirs
        </Button>
      </Banner>
    );
  if (file.notice)
    return (
      <Banner tone="review" role="status">
        <span className="flex-1">
          Updated by <strong className="font-semibold text-ink">{authorLabel(file.notice.author, agentTitle)}</strong> · v{file.notice.version}
        </span>
        <Button size={28} variant="ghost" onClick={file.dismissNotice}>
          Dismiss
        </Button>
      </Banner>
    );
  if (file.error)
    return (
      <div role="alert" className="px-5 py-2 text-[12.5px] text-bad bg-bad-bg border-b border-bad-line">
        {file.error}
      </div>
    );
  return null;
}

/** A non-entry file: Monaco for text, the image inline, a note for other binary files. */
function OtherFile({
  meta,
  path,
  info,
  file,
  busy,
  entryDirty,
  onOpenOn,
  preview,
}: {
  meta: ArtifactMeta;
  path: string;
  info: ArtifactFile | undefined;
  file: ArtifactFileState;
  busy: boolean;
  entryDirty: boolean;
  onOpenOn: (path: string) => void;
  preview: ReactNode;
}) {
  const binary = info?.text === false;
  const openOnBlocked = file.dirty || entryDirty;
  const header = (
    <div className="flex items-center gap-2 flex-wrap min-h-[28px]">
      <span className="font-mono text-[12px] text-ink-2 truncate">{path}</span>
      {info && <span className="text-[11.5px] text-ink-3">{formatSize(info.size)}</span>}
      <span className="flex-1" />
      {meta.kind === 'design' && isPagePath(path) && (
        <Button size={28} onClick={() => onOpenOn(path)} disabled={busy || openOnBlocked} title={openOnBlocked ? 'Save your changes first.' : undefined}>
          Open on this page
        </Button>
      )}
    </div>
  );
  if (binary) {
    return (
      <div className="flex-1 min-w-0 min-h-0 flex flex-col gap-2">
        {header}
        {isImagePath(path) ? <ImageFile id={meta.id} path={path} version={meta.version} /> : <p className="m-0 text-[12.5px] text-ink-3">A binary file. It can&apos;t be shown here.</p>}
      </div>
    );
  }
  return (
    <>
      <div className="flex-1 min-w-0 min-h-0 flex flex-col gap-2">
        {header}
        <div className="flex-1 min-h-0 flex flex-col">
          {file.base ? (
            <Suspense fallback={<Loading />}>
              <SourceEditor key={path} value={file.draft} language={languageForPath(path)} label={`Source of ${path}`} onChange={file.setDraft} onSave={() => void file.save()} />
            </Suspense>
          ) : file.error ? null : (
            <Loading />
          )}
        </div>
      </div>
      {preview}
    </>
  );
}

/** An image file of the current version, as a data: URL (the renderer CSP allows data: images). */
function ImageFile({ id, path, version }: { id: string; path: string; version: number }) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    let on = true;
    setSrc(null);
    setFailed(null);
    oide
      .invoke('artifacts.readFile', { id, path })
      .then((c) => on && setSrc(c.encoding === 'base64' ? imageDataUrl(path, c.data) : null))
      .catch((err) => on && setFailed(ipcErrorMessage(err)));
    return () => {
      on = false;
    };
  }, [id, path, version]);
  if (failed)
    return (
      <div role="alert" className="text-[12.5px] text-bad">
        Couldn&apos;t open {path}: {failed}
      </div>
    );
  return (
    <div className="flex-1 min-h-0 rounded-xl border border-line-2 bg-raised overflow-auto flex items-start justify-center p-4">
      {src ? <img src={src} alt={path} className="max-w-full h-auto" /> : <Spinner label={`Loading ${path}`} />}
    </div>
  );
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function Loading() {
  return (
    <div className="flex-1 flex items-center justify-center">
      <Spinner label="Loading the editor" />
    </div>
  );
}

function Banner({
  tone,
  role,
  children,
}: {
  tone: 'warn' | 'review';
  role: 'alert' | 'status';
  children: ReactNode;
}) {
  return (
    <div
      role={role}
      className={
        tone === 'warn'
          ? 'flex items-center gap-2 flex-wrap px-5 py-2 text-[12.5px] text-ink-2 bg-warn-bg border-b border-warn-line'
          : 'flex items-center gap-2 flex-wrap px-5 py-2 text-[12.5px] text-ink-2 bg-review-bg border-b border-review-line'
      }
    >
      {children}
    </div>
  );
}

/** Doc: live render of the draft. Design: the saved version in the sandboxed frame (reloads on save). */
function PreviewPane({
  kind,
  meta,
  draft,
  saved,
  dirty,
}: {
  kind: ArtifactMeta['kind'];
  meta: ArtifactMeta;
  draft: string;
  saved: { version: number; content: string };
  dirty: boolean;
}) {
  const savedVersion = saved.version;
  if (kind === 'doc')
    return (
      <div
        className="flex-1 min-w-0 min-h-0 rounded-xl border border-line-2 bg-raised overflow-auto"
        aria-label={`Preview of ${meta.title}`}
        role="region"
      >
        <MarkdownView source={draft} />
      </div>
    );
  return (
    <div className="flex-1 min-w-0 min-h-0 flex flex-col gap-1.5">
      <div className="flex-1 min-h-0 rounded-xl border border-line-2 bg-raised overflow-hidden">
        <DesignFrame
          artifactId={meta.id}
          title={meta.title}
          html={saved.content}
          version={savedVersion}
          className="w-full h-full"
        />
      </div>
      <span className="text-[11.5px] text-ink-3">
        {dirty
          ? `Showing v${savedVersion}. Save to refresh the preview.`
          : `v${savedVersion}, sandboxed: no network, no access to oIDE.`}
      </span>
    </div>
  );
}

interface CompareProps {
  detail: Detail;
  /** Unsaved edits, when there are any (offered as a side). */
  draft: string | null;
  sides: { from: CompareSide; to: CompareSide } | null;
  onSides: (s: { from: CompareSide; to: CompareSide }) => void;
  agentTitle: (id: string) => string | undefined;
}

/** Pick two versions (or a version and your draft) and diff them. */
function Compare({ detail, draft, sides, onSides, agentTitle }: CompareProps) {
  const { meta, versions } = detail;
  const latest = meta.version;
  const fallback = useMemo<{ from: CompareSide; to: CompareSide }>(
    () => (draft !== null ? { from: latest, to: 'draft' } : { from: Math.max(1, latest - 1), to: latest }),
    [draft, latest],
  );
  const cur =
    sides && (sides.from !== 'draft' || draft !== null) && (sides.to !== 'draft' || draft !== null)
      ? sides
      : fallback;
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [stats, setStats] = useState<{ additions: number; deletions: number } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  const textOf = (s: CompareSide): string | undefined =>
    s === 'draft' ? (draft ?? undefined) : s === latest ? detail.content : texts[String(s)];

  useEffect(() => {
    let live = true;
    setFailed(null);
    for (const s of [cur.from, cur.to]) {
      if (s === 'draft' || s === latest || texts[String(s)] !== undefined) continue;
      oide
        .invoke('artifacts.readVersion', { id: meta.id, version: s })
        .then(({ content }) => live && setTexts((t) => ({ ...t, [String(s)]: content })))
        .catch((err) => live && setFailed(`Couldn't load v${s}: ${ipcErrorMessage(err)}`));
    }
    return () => {
      live = false;
    };
    // texts is a cache; re-running on it would refetch nothing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cur.from, cur.to, latest, meta.id]);

  if (versions.length < 2 && draft === null) {
    return (
      <div className="flex-1 flex items-center justify-center text-[12.5px] text-ink-3">
        Only one version so far. Save a change to compare versions.
      </div>
    );
  }

  const options = [
    ...(draft !== null ? [{ value: 'draft', label: 'Your unsaved changes' }] : []),
    ...versions.map((v) => ({ value: String(v.version), label: versionLabel(v, agentTitle) })),
  ];
  const parse = (v: string): CompareSide => (v === 'draft' ? 'draft' : Number(v));
  const name = (s: CompareSide) => (s === 'draft' ? 'your changes' : `v${s}`);
  const a = textOf(cur.from);
  const b = textOf(cur.to);

  return (
    <div className="flex-1 min-w-0 min-h-0 flex flex-col gap-3">
      <div className="flex items-end gap-3 flex-wrap">
        <Select
          label="From"
          size={28}
          options={options}
          value={String(cur.from)}
          onChange={(e) => onSides({ ...cur, from: parse(e.target.value) })}
          containerClassName="min-w-[240px]"
        />
        <Select
          label="To"
          size={28}
          options={options}
          value={String(cur.to)}
          onChange={(e) => onSides({ ...cur, to: parse(e.target.value) })}
          containerClassName="min-w-[240px]"
        />
        <span className="text-[12.5px] text-ink-3 pb-2" aria-live="polite">
          Comparing {name(cur.from)} with {name(cur.to)}
          {stats && (
            <>
              {' · '}
              <DiffStat additions={stats.additions} deletions={stats.deletions} />
              {' lines'}
            </>
          )}
        </span>
      </div>
      {failed ? (
        <div role="alert" className="text-[12.5px] text-bad">
          {failed}
        </div>
      ) : a === undefined || b === undefined ? (
        <Loading />
      ) : (
        <VersionDiff
          original={contentForDiff(meta.kind, a)}
          modified={contentForDiff(meta.kind, b)}
          language={sourceLanguage(meta.kind, meta.entry)}
          label={`Changes from ${name(cur.from)} to ${name(cur.to)}`}
          onStats={setStats}
        />
      )}
    </div>
  );
}
