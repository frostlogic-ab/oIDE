/**
 * New artifact and Import from claude.ai dialogs (both end with the new artifact selected), and the
 * Rename and Delete confirms.
 */
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { inferKindFromContent, looksLikeHtml, type ArtifactKind, type ArtifactMeta, type Project } from '@oide/protocol';
import { Button, Dialog, SegmentedControl, Select, Tabs, TextArea, TextField, tabPanelProps } from '@oide/ui';
import { ipcErrorMessage, oide } from '../../lib/bridge';
import { KIND_LABEL, canOpenClaudeLink, isClaudeLink, kindFromFileName, validateContent, validateTitle } from './model';

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

/** Pasted content above this size is refused before it is sent (main checks again). */
const MAX_PASTE_BYTES = 10 * 1024 * 1024;

/**
 * Import from claude.ai. oIDE cannot download an artifact from claude.ai (no public content API, and
 * oIDE never uses the user's claude.ai sign-in), so "Paste a link" takes the artifact's content too:
 * the user opens the link, copies the code and pastes it. The kind follows the content until the user
 * picks one. "Pick a file" imports a downloaded file and can keep the link as its origin.
 */
export function ImportDialog({ open, onClose, projects, defaultProjectId, onImported }: ImportDialogProps) {
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
  // The link is required for "Paste a link" and optional (the file's origin) for "Pick a file".
  const urlError = touched
    ? tab === 'link' && !link
      ? 'Paste a claude.ai link.'
      : link && !isClaudeLink(link)
        ? 'Only https links on claude.ai can be imported.'
        : undefined
    : undefined;
  // Memoised: a multi-MB paste must not be re-scanned on every keystroke in the other fields.
  const contentError = useMemo(() => (tab === 'link' && hasContent ? importContentError(kind, content) : undefined), [tab, hasContent, kind, content]);
  const contentHintId = useId();
  const contentErrorId = useId();

  // Start each use from the current scope (the dialog stays mounted between uses).
  useEffect(() => {
    if (!open) return;
    setProjectId(defaultProjectId ?? '');
    setLocation('app-data');
  }, [open, defaultProjectId]);

  const close = () => {
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
        filters: [{ name: 'Artifacts', extensions: ['html', 'htm', 'md', 'markdown', 'txt', 'excalidraw', 'json'] }],
      });
      if (path) {
        setFilePath(path);
        if (!kindPicked) setKind(kindFromFileName(path));
      }
    } catch (err) {
      setError(ipcErrorMessage(err));
    }
  };

  const switchTab = (t: ImportTab) => {
    setTab(t);
    setError(null);
    if (kindPicked) return;
    if (t === 'link') setKind(content.trim() ? inferKindFromContent(content) : 'doc');
    else setKind(filePath ? kindFromFileName(filePath) : 'doc');
  };

  const submit = async () => {
    setTouched(true);
    if (tab === 'link' && (!link || !isClaudeLink(link))) return;
    if (tab === 'file' && link && !isClaudeLink(link)) return;
    if (tab === 'file' && !filePath) {
      setError('Choose a file first.');
      return;
    }
    if (contentError) return;
    setBusy(true);
    setError(null);
    try {
      const source = tab === 'link' ? { url: link, ...(hasContent ? { content } : {}) } : { filePath: filePath!, ...(link ? { url: link } : {}) };
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
        error={urlError}
        hint={
          tab === 'file'
            ? 'Where the file came from, for Open in claude.ai.'
            : isClaudeLink(link) && !canOpenClaudeLink(link)
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
          <Button size={32} onClick={close}>
            Cancel
          </Button>
          <Button size={32} variant="primary" onClick={() => void submit()} disabled={busy}>
            {tab === 'link' && !hasContent ? 'Import link only' : 'Import'}
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
                placeholder="<!doctype html>…"
                aria-invalid={contentError ? true : undefined}
                aria-describedby={contentError ? `${contentHintId} ${contentErrorId}` : contentHintId}
                className="max-h-[240px] resize-y aria-[invalid=true]:border-bad-line"
              />
              {/* The instructions stay visible when the content is refused; the refusal is announced. */}
              <span id={contentHintId} className="text-[12px] text-ink-3 leading-[1.45]">
                oIDE can&apos;t download from claude.ai: there is no public API, and oIDE never uses your claude.ai sign-in. Open the link, copy the artifact&apos;s code and
                paste it here. Leave it empty to keep only the link.
              </span>
              {contentError && (
                <span id={contentErrorId} role="alert" className="text-[12px] text-bad">
                  {contentError}
                </span>
              )}
            </div>
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
              <span className="text-[12px] text-ink-3">A downloaded .html (design), .md (doc) or .excalidraw (whiteboard) file, up to 10 MB.</span>
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
    </Dialog>
  );
}

/** Why pasted content can't be imported as `kind`, or undefined. Main applies the same rules. */
function importContentError(kind: ArtifactKind, content: string): string | undefined {
  // UTF-8 is at most 3 bytes per UTF-16 unit: only encode when the paste could be over the limit.
  if (content.length * 3 > MAX_PASTE_BYTES && new TextEncoder().encode(content).length > MAX_PASTE_BYTES) return 'The content is larger than 10 MB.';
  if (kind === 'design' && !looksLikeHtml(content)) {
    return "This isn't an HTML page, so it can't be a design: React and other code artifacts don't run in oIDE's preview. Ask Claude on claude.ai for one self-contained HTML file, or import it as a doc.";
  }
  if (kind === 'whiteboard') return validateContent('whiteboard', content.charCodeAt(0) === 0xfeff ? content.slice(1) : content) ?? undefined;
  return undefined;
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
