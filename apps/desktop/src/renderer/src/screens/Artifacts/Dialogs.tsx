/**
 * New artifact and Import from claude.ai dialogs (both end with the new artifact selected), and the
 * Rename and Delete confirms.
 */
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { classifyClaudeLink, inferKindFromContent, type ArtifactKind, type ArtifactMeta, type Project } from '@oide/protocol';
import { Button, Dialog, SegmentedControl, Select, Tabs, TextArea, TextField, tabPanelProps } from '@oide/ui';
import { ipcErrorMessage, oide } from '../../lib/bridge';
import { trackFetchWithAgent } from '../../lib/telemetry';
import { navigate } from '../../stores/router';
import { useFileDrop } from './drop';
import { IMPORT_EXTENSIONS, IMPORT_NEEDS_CODE_REASON, KIND_LABEL, canOpenClaudeLink, importContentError, kindFromFileName, validateTitle } from './model';

type Location = 'repo' | 'app-data';

const KIND_OPTIONS = (['design', 'doc', 'whiteboard'] as const).map((k) => ({ value: k, label: KIND_LABEL[k] }));

function projectOptions(projects: Project[], allowNone: boolean) {
  return [...(allowNone ? [{ value: '', label: 'No project' }] : []), ...projects.map((p) => ({ value: p.id, label: p.name }))];
}

/** "Where it lives": repo (.oide/artifacts, shared through git) or personal (app data). */
function LocationField({ value, onChange, hasProject }: { value: Location; onChange: (l: Location) => void; hasProject: boolean }) {
  const name = useId();
  const opts: Array<{ v: Location; label: string; desc: string; disabled?: boolean }> = [
    { v: 'repo', label: "In the project's repo", desc: 'Saved in .oide/artifacts/ and shared with your team through git.', disabled: !hasProject },
    { v: 'app-data', label: 'Personal', desc: 'Kept in oIDE on this computer only.' },
  ];
  return (
    <fieldset className="m-0 p-0 border-0 flex flex-col gap-2">
      <legend className="text-[12px] font-semibold text-ink-2 mb-2">Where it lives</legend>
      {opts.map((o) => (
        <label key={o.v} className={`flex items-start gap-2 text-[13px] ${o.disabled ? 'opacity-50' : 'cursor-pointer'}`}>
          <input type="radio" name={name} value={o.v} checked={value === o.v} disabled={o.disabled} onChange={() => onChange(o.v)} className="accent-accent mt-[3px]" />
          <span className="flex flex-col gap-0.5">
            <span>{o.label}</span>
            <span className="text-[12px] text-ink-3">{o.disabled ? 'Pick a project first.' : o.desc}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}

function ErrorLine({ children }: { children: ReactNode }) {
  return (
    <span role="alert" className="text-[12px] text-bad">
      {children}
    </span>
  );
}

export interface NewArtifactDialogProps {
  open: boolean;
  onClose: () => void;
  projects: Project[];
  defaultProjectId?: string;
  onCreated: (meta: ArtifactMeta) => void;
}

export function NewArtifactDialog({ open, onClose, projects, defaultProjectId, onCreated }: NewArtifactDialogProps) {
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState<ArtifactKind>('doc');
  const [projectId, setProjectId] = useState(defaultProjectId ?? '');
  const [location, setLocation] = useState<Location>(defaultProjectId ? 'repo' : 'app-data');
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);

  const titleError = touched && !title.trim() ? 'Give it a title.' : undefined;

  const reset = () => {
    setTitle('');
    setTouched(false);
    setError(null);
  };

  // The dialog stays mounted between uses: start each one from the current scope, so the last
  // artifact's project and "Personal" choice do not carry over to the next.
  useEffect(() => {
    if (!open) return;
    setKind('doc');
    setProjectId(defaultProjectId ?? '');
    setLocation(defaultProjectId ? 'repo' : 'app-data');
  }, [open, defaultProjectId]);

  const create = async () => {
    setTouched(true);
    if (!title.trim()) {
      titleRef.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const meta = await oide.invoke('artifacts.create', { title: title.trim(), kind, projectId: projectId || undefined, location: projectId ? location : 'app-data' });
      reset();
      onCreated(meta);
    } catch (err) {
      setError(ipcErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={() => {
        reset();
        onClose();
      }}
      title="New artifact"
      description="A design, doc or whiteboard that you and your agents can read and edit."
      width={520}
      showClose
      initialFocus={titleRef}
      footer={
        <>
          <Button size={32} onClick={onClose}>
            Cancel
          </Button>
          <Button size={32} variant="primary" onClick={() => void create()} disabled={busy}>
            Create
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <TextField ref={titleRef} label="Title" value={title} onChange={(e) => setTitle(e.target.value)} onBlur={() => setTouched(true)} error={titleError} placeholder="Checkout flow" required />
        <div className="flex flex-col gap-2">
          <span id="new-kind-label" className="text-[12px] font-semibold text-ink-2">
            Kind
          </span>
          <SegmentedControl label="Kind" variant="inset" size={28} options={KIND_OPTIONS} value={kind} onChange={setKind} className="self-start" />
        </div>
        <Select
          label="Project"
          options={projectOptions(projects, true)}
          value={projectId}
          onChange={(e) => {
            // No project: personal only. Picking one after "No project" defaults to the repo again.
            if (!e.target.value) setLocation('app-data');
            else if (!projectId) setLocation('repo');
            setProjectId(e.target.value);
          }}
        />
        <LocationField value={projectId ? location : 'app-data'} onChange={setLocation} hasProject={Boolean(projectId)} />
        {error && <ErrorLine>{error}</ErrorLine>}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

export interface ImportDialogProps {
  open: boolean;
  onClose: () => void;
  projects: Project[];
  defaultProjectId?: string;
  onImported: (meta: ArtifactMeta) => void;
  /** A file dropped on the Artifacts grid: opens the dialog on "Pick a file" with it chosen. */
  initialFile?: { path: string; name: string } | null;
}

type ImportTab = 'link' | 'file';

/**
 * Import from claude.ai. oIDE cannot download an artifact from claude.ai (no public content API, and
 * oIDE never uses the user's claude.ai sign-in, even for a public one), so nothing is imported
 * without its code: "Paste a link" takes the artifact's code too (open the link, copy, paste), and
 * "Pick a file" takes a downloaded or dropped file, with the link kept as its origin. Import stays
 * disabled until there is content, and says why. The kind follows the content until the user picks
 * one; a design is HTML or React. "Fetch with an agent" hands the link to an agent that has claude.ai
 * connectors (Claude Docs, Claude Design), which works for those and never for chat artifacts.
 */
export function ImportDialog({ open, onClose, projects, defaultProjectId, onImported, initialFile }: ImportDialogProps) {
  const [tab, setTab] = useState<ImportTab>('link');
  const [url, setUrl] = useState('');
  const [content, setContent] = useState('');
  const [filePath, setFilePath] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState<ArtifactKind>('doc');
  const [kindPicked, setKindPicked] = useState(false);
  const [projectId, setProjectId] = useState(defaultProjectId ?? '');
  const [location, setLocation] = useState<Location>('app-data');
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const link = url.trim();
  const hasContent = content.trim().length > 0;
  const linkInfo = useMemo(() => (link ? classifyClaudeLink(link) : null), [link]);
  const linkError = linkInfo && !linkInfo.ok ? linkInfo.reason : undefined;
  // A half-typed link is not an error yet; one that parses but is not an artifact link is.
  const showLinkError = linkError !== undefined && (touched || linkError !== 'Not a valid link.');
  // Memoised: a multi-MB paste must not be re-scanned on every keystroke in the other fields.
  const contentError = useMemo(() => (tab === 'link' && hasContent ? importContentError(kind, content) : undefined), [tab, hasContent, kind, content]);
  const contentHintId = useId();
  const contentErrorId = useId();
  const reasonId = useId();

  // Why Import is disabled (one line beside it); undefined when it can go.
  const reason: string | undefined =
    tab === 'link'
      ? !hasContent
        ? IMPORT_NEEDS_CODE_REASON
        : contentError
          ? 'Fix the pasted code first.'
          : !link
            ? 'Add the claude.ai link the code came from.'
            : linkError
              ? 'Fix the link first.'
              : undefined
      : !filePath
        ? "Choose or drop a file first. oIDE can't download claude.ai artifacts, even public ones."
        : linkError
          ? 'Fix the link, or clear it.'
          : undefined;

  // Start each use from the current scope (the dialog stays mounted between uses).
  useEffect(() => {
    if (!open) return;
    setProjectId(defaultProjectId ?? '');
    setLocation('app-data');
  }, [open, defaultProjectId]);

  const chooseFile = (path: string) => {
    setFilePath(path);
    setTab('file');
    setError(null);
    if (!kindPicked) setKind(kindFromFileName(path));
  };

  // A file dropped on the grid opens the dialog with it chosen.
  useEffect(() => {
    if (open && initialFile) chooseFile(initialFile.path);
    // Only a new dropped file matters; the rest is read when it runs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialFile]);

  const close = () => {
    setTab('link');
    setUrl('');
    setContent('');
    setFilePath(null);
    setTitle('');
    setKind('doc');
    setKindPicked(false);
    setTouched(false);
    setError(null);
    onClose();
  };

  const onContent = (next: string) => {
    setContent(next);
    if (!kindPicked) setKind(next.trim() ? inferKindFromContent(next) : 'doc');
  };

  const openLink = () => {
    if (!canOpenClaudeLink(link)) {
      setTouched(true);
      return;
    }
    oide.invoke('shell.openExternal', { url: link }).catch((err: unknown) => setError(ipcErrorMessage(err)));
  };

  const pick = async () => {
    setError(null);
    try {
      const path = await oide.invoke('dialog.pickFile', {
        title: 'Import an artifact',
        filters: [{ name: 'Artifacts', extensions: [...IMPORT_EXTENSIONS] }],
      });
      if (path) chooseFile(path);
    } catch (err) {
      setError(ipcErrorMessage(err));
    }
  };

  const { dragging, dropProps } = useFileDrop((f) => {
    if ('error' in f) setError(f.error);
    else chooseFile(f.path);
  }, busy);

  const switchTab = (t: ImportTab) => {
    setTab(t);
    setError(null);
    if (kindPicked) return;
    if (t === 'link') setKind(content.trim() ? inferKindFromContent(content) : 'doc');
    else setKind(filePath ? kindFromFileName(filePath) : 'doc');
  };

  const fetchWithAgent = () => {
    if (!linkInfo?.ok) return;
    const name = title.trim() || 'Imported from claude.ai';
    trackFetchWithAgent();
    const goal =
      `Import the claude.ai artifact at ${linkInfo.url} into oIDE. Read it with your claude.ai connectors ` +
      '(Claude Docs read; DesignSync for a Claude Design project). Only if you get its real content, create it with artifacts_create ' +
      `(kind design for HTML or React, doc for Markdown) titled "${name}". If the read is refused, create nothing and tell me the link ` +
      "can't be fetched, so I should paste the code instead.";
    close();
    navigate('spawn', { ...(projectId ? { projectId } : {}), goal });
  };

  const submit = async () => {
    setTouched(true);
    if (reason || busy) return;
    setBusy(true);
    setError(null);
    try {
      const source = tab === 'link' ? { url: link, content } : { filePath: filePath!, ...(link ? { url: link } : {}) };
      const meta = await oide.invoke('artifacts.import', {
        ...source,
        title: title.trim() || undefined,
        kind,
        projectId: projectId || undefined,
        location: projectId ? location : 'app-data',
      });
      close();
      onImported(meta);
    } catch (err) {
      setError(ipcErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const linkField = (
    <div className="flex items-start gap-2">
      <TextField
        label={tab === 'link' ? 'claude.ai link' : 'claude.ai link (optional)'}
        mono
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        onBlur={() => url && setTouched(true)}
        placeholder="https://claude.ai/artifact/…"
        error={showLinkError ? <span role="alert">{linkError}</span> : undefined}
        hint={
          tab === 'file'
            ? 'Where the file came from, for Open in claude.ai.'
            : linkInfo?.ok && !canOpenClaudeLink(link)
              ? 'oIDE opens only claude.ai links in your browser; open this one yourself to copy its code.'
              : undefined
        }
        containerClassName="flex-1 min-w-0"
      />
      {tab === 'link' && (
        <Button size={32} icon="external-link" onClick={openLink} disabled={!canOpenClaudeLink(link)} aria-label="Open the link on claude.ai" className="mt-[22px] shrink-0">
          Open
        </Button>
      )}
    </div>
  );

  return (
    <Dialog
      open={open}
      onClose={close}
      title="Import from claude.ai"
      description="oIDE stores a copy, marked as imported. It is not synced: later changes on claude.ai don't show up here, and your edits stay in oIDE."
      width={600}
      showClose
      footer={
        <>
          {reason && (
            <span id={reasonId} className="mr-auto self-center text-[12px] text-ink-3 leading-[1.45] min-w-0">
              {reason}
            </span>
          )}
          <Button size={32} onClick={close}>
            Cancel
          </Button>
          <Button size={32} variant="primary" onClick={() => void submit()} disabled={busy || Boolean(reason)} aria-describedby={reason ? reasonId : undefined}>
            Import
          </Button>
        </>
      }
    >
      <div {...dropProps} className="relative flex flex-col gap-4">
        {dragging && (
          <div
            aria-hidden="true"
            className="absolute -inset-2 z-10 rounded-lg border-2 border-dashed border-accent bg-panel/90 flex items-center justify-center text-[13px] text-ink pointer-events-none"
          >
            Drop the file to import it
          </div>
        )}
        <Tabs
          label="How to import"
          idPrefix="import"
          tabs={[
            { id: 'link', label: 'Paste a link' },
            { id: 'file', label: 'Pick a file' },
          ]}
          value={tab}
          onChange={switchTab}
          className="gap-3 border-b border-line-2"
        />
        <div {...tabPanelProps('import', tab)} className="flex flex-col gap-4 outline-none">
          {tab === 'link' ? (
            <>
              {linkField}
              <div className="flex flex-col gap-1.5">
                <TextArea
                  label="Artifact content"
                  mono
                  rows={7}
                  value={content}
                  onChange={(e) => onContent(e.target.value)}
                  placeholder="<!doctype html>… or import React from 'react'…"
                  aria-invalid={contentError ? true : undefined}
                  aria-describedby={contentError ? `${contentHintId} ${contentErrorId}` : contentHintId}
                  className="max-h-[240px] resize-y aria-[invalid=true]:border-bad-line"
                />
                {/* The steps stay visible when the content is refused; the refusal is announced. */}
                <div id={contentHintId} className="text-[12px] text-ink-3 leading-[1.45]">
                  <ol className="m-0 pl-4 list-decimal">
                    <li>Open the link.</li>
                    <li>On claude.ai, use Copy (or Download).</li>
                    <li>Paste the code here, or drop the downloaded file.</li>
                  </ol>
                </div>
                {contentError && (
                  <span id={contentErrorId} role="alert" className="text-[12px] text-bad">
                    {contentError}
                  </span>
                )}
              </div>
              {linkInfo?.ok && (
                <div className="flex flex-col gap-1.5 rounded-lg border border-line-2 bg-card px-3 py-2.5">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Button size={28} icon="agents" onClick={fetchWithAgent}>
                      Fetch with an agent
                    </Button>
                    <span className="text-[12px] text-ink-3">Or let an agent read it for you.</span>
                  </div>
                  <span className="text-[12px] text-ink-3 leading-[1.45]">
                    Works for Claude Docs and Claude Design projects. Chat artifacts can&apos;t be fetched, even public ones: ask Claude on claude.ai to save the design as a Doc to make
                    this automatic.
                  </span>
                </div>
              )}
            </>
          ) : (
            <>
              <div className="flex flex-col gap-2">
                <span className="text-[12px] font-semibold text-ink-2">File</span>
                <div className="flex items-center gap-2.5">
                  <Button size={32} onClick={() => void pick()}>
                    Choose a file…
                  </Button>
                  <span className="font-mono text-[12px] text-ink-2 truncate" aria-live="polite">
                    {filePath ?? 'No file chosen'}
                  </span>
                </div>
                <span className="text-[12px] text-ink-3">Or drop it anywhere on this dialog. An .html, .jsx, .tsx or .svg file (design), .md (doc) or .excalidraw (whiteboard), up to 10 MB.</span>
              </div>
              {linkField}
            </>
          )}
          <div className="grid grid-cols-2 gap-3">
            <TextField
              label="Title"
              value={title}
              maxLength={200}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={tab === 'file' && filePath ? 'From the file name' : tab === 'link' && hasContent ? 'From the content' : 'Imported from claude.ai'}
            />
            <Select
              label="Kind"
              options={KIND_OPTIONS}
              value={kind}
              onChange={(e) => {
                setKind(e.target.value as ArtifactKind);
                setKindPicked(true);
              }}
            />
          </div>
          <Select label="Project" options={projectOptions(projects, true)} value={projectId} onChange={(e) => setProjectId(e.target.value)} />
          <LocationField value={projectId ? location : 'app-data'} onChange={setLocation} hasProject={Boolean(projectId)} />
          {error && <ErrorLine>{error}</ErrorLine>}
        </div>
      </div>
    </Dialog>
  );
}

export interface RenameDialogProps {
  open: boolean;
  meta: ArtifactMeta;
  onClose: () => void;
  onRenamed: (meta: ArtifactMeta) => void;
}

/** Rename: a new title only; the folder, id and versions stay the same. */
export function RenameDialog({ open, meta, onClose, onRenamed }: RenameDialogProps) {
  const [title, setTitle] = useState(meta.title);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setTitle(meta.title);
    setError(null);
    const t = setTimeout(() => inputRef.current?.select(), 0);
    return () => clearTimeout(t);
  }, [open, meta.title]);

  const submit = async () => {
    const v = validateTitle(title);
    if ('error' in v) {
      setError(v.error);
      inputRef.current?.focus();
      return;
    }
    if (v.title === meta.title) return onClose();
    setBusy(true);
    setError(null);
    try {
      onRenamed(await oide.invoke('artifacts.rename', { id: meta.id, title: v.title }));
    } catch (err) {
      setError(ipcErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Rename ${meta.title}`}
      description="Agents keep finding it: only the title changes, not its folder or history."
      initialFocus={inputRef}
      footer={
        <>
          <Button size={32} onClick={onClose}>
            Cancel
          </Button>
          <Button size={32} variant="primary" onClick={() => void submit()} disabled={busy}>
            Rename
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <TextField ref={inputRef} label="Title" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} error={error ?? undefined} required />
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

export interface DeleteDialogProps {
  open: boolean;
  meta: ArtifactMeta;
  onClose: () => void;
  onDeleted: (id: string) => void;
}

/** Delete confirm. Repo artifacts are removed from the working tree (git still has committed copies). */
export function DeleteDialog({ open, meta, onClose, onDeleted }: DeleteDialogProps) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) setError(null);
  }, [open]);

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await oide.invoke('artifacts.delete', { id: meta.id });
      onDeleted(meta.id);
    } catch (err) {
      setError(ipcErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Delete ${meta.title}?`}
      description={
        meta.location === 'repo'
          ? `This deletes its folder in .oide/artifacts/ and all ${meta.version} ${meta.version === 1 ? 'version' : 'versions'}. Copies you committed stay in git history.`
          : `This deletes it from oIDE on this computer, with all ${meta.version} ${meta.version === 1 ? 'version' : 'versions'}. It can't be undone.`
      }
      footer={
        <>
          <Button size={32} onClick={onClose}>
            Cancel
          </Button>
          <Button size={32} variant="danger" onClick={() => void remove()} disabled={busy}>
            Delete
          </Button>
        </>
      }
    >
      {error && <ErrorLine>{error}</ErrorLine>}
    </Dialog>
  );
}
