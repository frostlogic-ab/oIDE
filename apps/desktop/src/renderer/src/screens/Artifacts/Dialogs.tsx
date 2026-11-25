/**
 * New artifact and Import from claude.ai dialogs (both end with the new artifact selected), and the
 * Rename and Delete confirms.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { ArtifactKind, ArtifactMeta, Project } from '@oide/protocol';
import { Button, Dialog, SegmentedControl, Select, Tabs, TextField, tabPanelProps } from '@oide/ui';
import { ipcErrorMessage, oide } from '../../lib/bridge';
import { KIND_LABEL, isClaudeLink, kindFromFileName, validateTitle } from './model';

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
}

type ImportTab = 'link' | 'file';

export function ImportDialog({ open, onClose, projects, defaultProjectId, onImported }: ImportDialogProps) {
  const [tab, setTab] = useState<ImportTab>('link');
  const [url, setUrl] = useState('');
  const [filePath, setFilePath] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState<ArtifactKind>('doc');
  const [projectId, setProjectId] = useState(defaultProjectId ?? '');
  const [location, setLocation] = useState<Location>('app-data');
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const urlError = touched && tab === 'link' ? (!url.trim() ? 'Paste a claude.ai link.' : !isClaudeLink(url.trim()) ? 'Only https links on claude.ai can be imported.' : undefined) : undefined;

  const close = () => {
    setUrl('');
    setFilePath(null);
    setTitle('');
    setTouched(false);
    setError(null);
    onClose();
  };

  const pick = async () => {
    setError(null);
    try {
      const path = await oide.invoke('dialog.pickFile', {
        title: 'Import an artifact',
        filters: [{ name: 'Artifacts', extensions: ['html', 'htm', 'md', 'markdown', 'txt', 'excalidraw', 'json'] }],
      });
      if (path) {
        setFilePath(path);
        setKind(kindFromFileName(path));
      }
    } catch (err) {
      setError(ipcErrorMessage(err));
    }
  };

  const submit = async () => {
    setTouched(true);
    if (tab === 'link' && (!url.trim() || !isClaudeLink(url.trim()))) return;
    if (tab === 'file' && !filePath) {
      setError('Choose a file first.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const meta = await oide.invoke('artifacts.import', {
        ...(tab === 'link' ? { url: url.trim() } : { filePath: filePath! }),
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

  return (
    <Dialog
      open={open}
      onClose={close}
      title="Import from claude.ai"
      description="oIDE stores a copy, marked as imported. It is not synced: later changes on claude.ai don't show up here, and your edits stay in oIDE."
      width={560}
      showClose
      footer={
        <>
          <Button size={32} onClick={close}>
            Cancel
          </Button>
          <Button size={32} variant="primary" onClick={() => void submit()} disabled={busy}>
            Import
          </Button>
        </>
      }
    >
      <Tabs
        label="How to import"
        idPrefix="import"
        tabs={[
          { id: 'link', label: 'Paste a link' },
          { id: 'file', label: 'Pick a file' },
        ]}
        value={tab}
        onChange={(t) => {
          setTab(t);
          setError(null);
        }}
        className="gap-3 border-b border-line-2"
      />
      <div {...tabPanelProps('import', tab)} className="flex flex-col gap-4 outline-none">
        {tab === 'link' ? (
          <TextField
            label="claude.ai link"
            mono
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onBlur={() => url && setTouched(true)}
            placeholder="https://claude.ai/public/artifacts/…"
            error={urlError}
            hint="claude.ai has no public API for artifact content, so oIDE keeps the link (for Open in claude.ai) and starts an empty copy. Paste the content into it after import."
          />
        ) : (
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
            <span className="text-[12px] text-ink-3">An exported .html (design), .md (doc) or .excalidraw (whiteboard) file, up to 10 MB.</span>
          </div>
        )}
        <div className="grid grid-cols-2 gap-3">
          <TextField label="Title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={tab === 'file' && filePath ? 'From the file name' : 'Imported from claude.ai'} />
          <Select label="Kind" options={KIND_OPTIONS} value={kind} onChange={(e) => setKind(e.target.value as ArtifactKind)} />
        </div>
        <Select label="Project" options={projectOptions(projects, true)} value={projectId} onChange={(e) => setProjectId(e.target.value)} />
        <LocationField value={projectId ? location : 'app-data'} onChange={setLocation} hasProject={Boolean(projectId)} />
        {error && <ErrorLine>{error}</ErrorLine>}
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
