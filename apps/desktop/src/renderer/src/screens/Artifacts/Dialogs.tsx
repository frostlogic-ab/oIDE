/**
 * New artifact (one dialog, three starting points; it ends with the new artifact selected) and the
 * Rename and Delete confirms.
 *
 * Start from:
 * - A link: oIDE never downloads claude.ai content. `artifacts.importLink` creates the artifact with
 *   no files yet and starts an agent (the user's own `claude` CLI, in the chosen project) that reads
 *   the link with its claude.ai tools and hands the files back (ADR 0014).
 * - Files: picked files or a folder (`dialog.pickArtifactFiles`) or dropped files, through
 *   `artifacts.importFiles`; dropped images (the drop bridge gives no path for them) are added with
 *   `artifacts.writeFiles` right after.
 * - Blank: `artifacts.create`.
 * The primary button stays disabled until the choice can go, with the reason beside it as its
 * `aria-describedby`.
 */
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { classifyClaudeLink, type ArtifactKind, type ArtifactMeta, type Project } from '@oide/protocol';
import { Button, Dialog, IconButton, SegmentedControl, Select, TextField } from '@oide/ui';
import { ipcErrorMessage, oide } from '../../lib/bridge';
import { toast } from '../../stores/ui';
import { useFileDrop, type DropResult, type DroppedFiles, type DroppedImage } from './drop';
import { KIND_LABEL, baseName, entryCandidates, kindFromFiles, validateTitle } from './model';

type Location = 'repo' | 'app-data';
export type StartFrom = 'link' | 'files' | 'blank';

const START_OPTIONS: ReadonlyArray<{ value: StartFrom; label: string }> = [
  { value: 'link', label: 'A link' },
  { value: 'files', label: 'Files' },
  { value: 'blank', label: 'Blank' },
];
const KIND_OPTIONS = (['design', 'doc', 'whiteboard', 'board'] as const).map((k) => ({ value: k, label: KIND_LABEL[k] }));
/** A claude.ai link is never a kanban board (boards are oIDE's own, ADR 0022). */
const LINK_KIND_OPTIONS = KIND_OPTIONS.filter((o) => o.value !== 'board');

/** Where a new artifact lives unless the user picks: a blank one in the project's repo, others personal. */
const defaultLocation = (from: StartFrom, projectId: string): Location => (from === 'blank' && projectId ? 'repo' : 'app-data');

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

/** What the Files choice holds: picked or dropped files (by path), dropped images (inline), or a folder. */
interface Chosen {
  files: Array<{ path: string; name: string }>;
  images: DroppedImage[];
  folder: string | null;
}
const NOTHING: Chosen = { files: [], images: [], folder: null };

function withFiles(c: Chosen, files: Chosen['files'], images: DroppedImage[] = []): Chosen {
  const paths = new Set(c.files.map((f) => f.path));
  const names = new Set(c.images.map((i) => i.name));
  const newFiles = files.filter((f) => !paths.has(f.path) && Boolean(paths.add(f.path)));
  const newImages = images.filter((i) => !names.has(i.name) && Boolean(names.add(i.name)));
  return { folder: null, files: [...c.files, ...newFiles], images: [...c.images, ...newImages] };
}

/** A claude.ai link checked live: the classifier's reason once it parses (or after blur), else nothing. */
function useLinkCheck(raw: string, touched: boolean) {
  const link = raw.trim();
  const info = useMemo(() => (link ? classifyClaudeLink(link) : null), [link]);
  const error = info && !info.ok ? info.reason : undefined;
  // A half-typed link is not an error yet; one that parses but is not an artifact link is.
  const shown = error !== undefined && (touched || error !== 'Not a valid link.') ? error : undefined;
  return { link, error, shown };
}

export interface NewArtifactDialogProps {
  open: boolean;
  onClose: () => void;
  projects: Project[];
  defaultProjectId?: string;
  onCreated: (meta: ArtifactMeta) => void;
  /** Files dropped on the Artifacts grid: the dialog opens on Files with them chosen. */
  initialDrop?: DroppedFiles | null;
}

export function NewArtifactDialog({ open, onClose, projects, defaultProjectId, onCreated, initialDrop }: NewArtifactDialogProps) {
  const [from, setFrom] = useState<StartFrom>('link');
  const [url, setUrl] = useState('');
  const [urlTouched, setUrlTouched] = useState(false);
  const [cameFrom, setCameFrom] = useState('');
  const [cameFromTouched, setCameFromTouched] = useState(false);
  const [title, setTitle] = useState('');
  /** Link and Files: '' detects the kind. */
  const [kind, setKind] = useState<ArtifactKind | ''>('');
  const [blankKind, setBlankKind] = useState<ArtifactKind>('doc');
  const [chosen, setChosen] = useState<Chosen>(NOTHING);
  const [problems, setProblems] = useState<string[]>([]);
  const [entry, setEntry] = useState('');
  const [projectId, setProjectId] = useState(defaultProjectId ?? '');
  const [location, setLocation] = useState<Location>('app-data');
  const [locationPicked, setLocationPicked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** The first field of the current choice (one stable ref, so switching choices doesn't move focus). */
  const firstField = useRef<HTMLElement | null>(null);
  const reasonId = useId();
  const listId = useId();

  const linkCheck = useLinkCheck(url, urlTouched);
  const cameFromCheck = useLinkCheck(cameFrom, cameFromTouched);

  // Start each use from the current scope (the dialog stays mounted between uses). The last
  // "Start from" choice is kept: someone making several blank docs doesn't pick it each time.
  // A layout effect, so a drop opens straight on Files instead of flashing the last choice first.
  useLayoutEffect(() => {
    if (!open) return;
    const p = defaultProjectId ?? '';
    setProjectId(p);
    setLocationPicked(false);
    setLocation(defaultLocation(initialDrop ? 'files' : from, p));
    if (initialDrop) {
      setFrom('files');
      setChosen((c) => withFiles(c, initialDrop.files, initialDrop.images));
      setProblems(initialDrop.problems);
    }
    // Only opening (and a new drop) matters; `from` is read when it runs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, defaultProjectId, initialDrop]);

  const reset = () => {
    setUrl('');
    setUrlTouched(false);
    setCameFrom('');
    setCameFromTouched(false);
    setTitle('');
    setKind('');
    setBlankKind('doc');
    setChosen(NOTHING);
    setProblems([]);
    setEntry('');
    setError(null);
  };
  const close = () => {
    reset();
    onClose();
  };

  const switchTo = (f: StartFrom) => {
    setFrom(f);
    setError(null);
    if (!locationPicked) setLocation(defaultLocation(f, projectId));
  };

  // A stray click on the scrim only closes a pristine form; once anything is typed, chosen or
  // attached it would throw that away (Esc, the × and Cancel still close).
  const pristine =
    !url &&
    !cameFrom &&
    !title &&
    !kind &&
    blankKind === 'doc' &&
    !chosen.folder &&
    !chosen.files.length &&
    !chosen.images.length &&
    !locationPicked &&
    projectId === (defaultProjectId ?? '');

  const names = useMemo(() => [...chosen.files.map((f) => f.name), ...chosen.images.map((i) => i.name)], [chosen]);
  const detected = names.length ? kindFromFiles(names) : undefined;
  const filesKind = kind || detected;
  const pages = useMemo(() => (filesKind === 'design' && !chosen.folder ? entryCandidates(names) : []), [filesKind, chosen.folder, names]);
  const opensOn = pages.includes(entry) ? entry : (pages[0] ?? '');

  const reason: string | undefined =
    from === 'link'
      ? !linkCheck.link
        ? 'Paste a claude.ai link first.'
        : linkCheck.error
          ? 'Fix the link first.'
          : !projectId
            ? projects.length
              ? 'Choose the project the agent runs in.'
              : 'Add a project first: the agent runs in one.'
            : undefined
      : from === 'files'
        ? !chosen.files.length && !chosen.folder
          ? chosen.images.length
            ? "Add a page or another file too, or use Choose files… for images: a drop doesn't give oIDE an image's file path."
            : 'Choose or drop files first.'
          : cameFromCheck.error
            ? 'Fix the link it came from, or clear it.'
            : undefined
        : !title.trim()
          ? 'Give it a title first.'
          : undefined;

  const addDrop = (r: DropResult) => {
    setError(null);
    switchTo('files');
    if ('error' in r) return setProblems([r.error]);
    setChosen((c) => withFiles(c, r.files, r.images));
    setProblems(r.problems);
  };
  const { dragging, dropProps } = useFileDrop(addDrop, busy);

  const pick = async (folder: boolean) => {
    setError(null);
    try {
      const paths = await oide.invoke('dialog.pickArtifactFiles', { folder });
      if (!paths.length) return;
      setProblems([]);
      if (folder) setChosen({ ...NOTHING, folder: paths[0]! });
      else setChosen((c) => withFiles(c, paths.map((path) => ({ path, name: baseName(path) }))));
    } catch (err) {
      setError(ipcErrorMessage(err));
    }
  };

  const removeChosen = (key: string) =>
    setChosen((c) => (key === c.folder ? NOTHING : { ...c, files: c.files.filter((f) => f.path !== key), images: c.images.filter((i) => `image:${i.name}` !== key) }));

  const submit = async () => {
    setUrlTouched(true);
    if (reason || busy) return;
    setBusy(true);
    setError(null);
    const location_ = projectId ? location : ('app-data' as const);
    const titled = title.trim() ? { title: title.trim() } : {};
    try {
      let meta: ArtifactMeta;
      if (from === 'link') {
        meta = await oide.invoke('artifacts.importLink', { url: linkCheck.link, ...titled, ...(kind ? { kind } : {}), projectId, location: location_ });
        toast(`Retrieving ${meta.title} with an agent. You can follow it on the Wall.`, 'info');
      } else if (from === 'files') {
        meta = await oide.invoke('artifacts.importFiles', {
          filePaths: chosen.files.map((f) => f.path),
          ...(chosen.folder ? { folderPath: chosen.folder } : {}),
          ...(pages.length > 1 && opensOn ? { entry: opensOn } : {}),
          ...(cameFromCheck.link ? { url: cameFromCheck.link } : {}),
          ...titled,
          ...(kind ? { kind } : {}),
          ...(projectId ? { projectId } : {}),
          location: location_,
        });
        if (chosen.images.length) {
          try {
            meta = await oide.invoke('artifacts.writeFiles', {
              id: meta.id,
              files: chosen.images.map((i) => ({ path: i.name, encoding: 'base64' as const, data: i.dataBase64 })),
              baseVersion: meta.version,
              note: 'Added the dropped images',
            });
          } catch (err) {
            toast(`Created ${meta.title}, but couldn't add the dropped images: ${ipcErrorMessage(err)}`, 'error');
          }
        }
      } else {
        meta = await oide.invoke('artifacts.create', { title: title.trim(), kind: blankKind, ...(projectId ? { projectId } : {}), location: location_ });
      }
      reset();
      onCreated(meta);
    } catch (err) {
      setError(ipcErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const projectField =
    from === 'link' ? (
      <Select
        label="Project"
        hint="The agent runs in this project."
        options={[
          ...(projectId ? [] : [{ value: '', label: projects.length ? 'Choose a project' : 'No projects yet', disabled: true }]),
          ...projects.map((p) => ({ value: p.id, label: p.name })),
        ]}
        value={projectId}
        onChange={(e) => setProjectId(e.target.value)}
      />
    ) : (
      <Select
        label="Project"
        options={[{ value: '', label: 'No project' }, ...projects.map((p) => ({ value: p.id, label: p.name }))]}
        value={projectId}
        onChange={(e) => {
          // No project: personal only. Picking one after "No project" goes back to the default.
          if (!e.target.value) setLocation('app-data');
          else if (!projectId && !locationPicked) setLocation(defaultLocation(from, e.target.value));
          setProjectId(e.target.value);
        }}
      />
    );

  const chosenRows = [
    ...(chosen.folder ? [{ key: chosen.folder, name: chosen.folder, title: chosen.folder }] : []),
    ...chosen.files.map((f) => ({ key: f.path, name: f.name, title: f.path })),
    ...chosen.images.map((i) => ({ key: `image:${i.name}`, name: i.name, title: `${i.name} (dropped image)` })),
  ];
  const chosenSummary = chosen.folder
    ? 'A folder: every file in it, keeping its subfolders.'
    : chosenRows.length
      ? `${chosenRows.length} ${chosenRows.length === 1 ? 'file' : 'files'}`
      : 'Pages, styles, images, Markdown or a board. Up to 500 files, 10 MB each.';
  const setFirst = (el: HTMLElement | null) => {
    firstField.current = el;
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      title="New artifact"
      description="A design, doc, whiteboard or kanban board that you and your agents can read and edit."
      width={560}
      showClose
      dismissOnScrim={pristine && !busy}
      initialFocus={firstField}
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
            {from === 'link' ? (busy ? 'Starting…' : 'Retrieve') : busy ? 'Creating…' : 'Create'}
          </Button>
        </>
      }
    >
      <form
        {...dropProps}
        className="relative flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {dragging && (
          <div aria-hidden="true" className="absolute -inset-2 z-10 rounded-lg border-2 border-dashed border-accent bg-panel/90 flex items-center justify-center text-[13px] text-ink pointer-events-none">
            Drop the files to add them
          </div>
        )}
        <div className="flex flex-col gap-2">
          <span className="text-[12px] font-semibold text-ink-2" aria-hidden="true">
            Start from
          </span>
          <SegmentedControl label="Start from" variant="inset" size={28} options={START_OPTIONS} value={from} onChange={switchTo} className="self-start" />
        </div>

        {from === 'link' && (
          <>
            <TextField
              ref={setFirst}
              label="Link"
              mono
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
                setError(null);
              }}
              onBlur={() => url && setUrlTouched(true)}
              placeholder="https://claude.ai/…"
              error={linkCheck.shown ? <span role="alert">{linkCheck.shown}</span> : undefined}
              hint="An agent opens the link with your Claude Code CLI and copies its files here. You can follow it on the Wall; the artifact fills in when it's done."
            />
            <div className="grid grid-cols-2 gap-3">
              <TextField label="Title (optional)" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} placeholder="Uses the artifact's own title" />
              <Select label="Kind" options={[{ value: '', label: 'Detect' }, ...LINK_KIND_OPTIONS]} value={kind} onChange={(e) => setKind(e.target.value as ArtifactKind | '')} />
            </div>
          </>
        )}

        {from === 'files' && (
          <>
            <div className="flex flex-col gap-2.5 rounded-lg border border-dashed border-line-3 px-3 py-3">
              <div className="flex items-center gap-2 flex-wrap">
                <Button ref={setFirst} size={28} icon="file" onClick={() => void pick(false)}>
                  Choose files…
                </Button>
                <Button size={28} icon="folder" onClick={() => void pick(true)}>
                  Choose a folder…
                </Button>
                <span className="text-[12px] text-ink-3">or drop files here</span>
              </div>
              <span id={listId} className="text-[12px] text-ink-2" aria-live="polite">
                {chosenSummary}
              </span>
              {chosenRows.length > 0 && (
                <ul aria-labelledby={listId} className="m-0 p-0 list-none max-h-[132px] overflow-auto rounded-md border border-line-2 bg-chrome">
                  {chosenRows.map((r) => (
                    <li key={r.key} className="flex items-center gap-2 pl-2.5 pr-0.5 h-7 border-b border-line-2 last:border-b-0">
                      <span className="flex-1 min-w-0 truncate font-mono text-[12px] text-ink-2" title={r.title}>
                        {r.name}
                      </span>
                      <IconButton icon="close" size={28} iconSize={13} aria-label={`Remove ${r.name}`} onClick={() => removeChosen(r.key)} />
                    </li>
                  ))}
                </ul>
              )}
              {problems.map((p) => (
                <ErrorLine key={p}>{p}</ErrorLine>
              ))}
            </div>
            {pages.length > 1 && (
              <Select label="Opens on" hint="The page the preview shows first." options={pages.map((p) => ({ value: p, label: p }))} value={opensOn} onChange={(e) => setEntry(e.target.value)} />
            )}
            <div className="grid grid-cols-2 gap-3">
              <TextField label="Title (optional)" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} placeholder="From the files" />
              <Select
                label="Kind"
                options={[{ value: '', label: detected ? `Detect (${KIND_LABEL[detected]})` : 'Detect' }, ...KIND_OPTIONS]}
                value={kind}
                onChange={(e) => setKind(e.target.value as ArtifactKind | '')}
              />
            </div>
            <TextField
              label="Came from (optional)"
              mono
              value={cameFrom}
              onChange={(e) => setCameFrom(e.target.value)}
              onBlur={() => cameFrom && setCameFromTouched(true)}
              placeholder="https://claude.ai/…"
              error={cameFromCheck.shown ? <span role="alert">{cameFromCheck.shown}</span> : undefined}
              hint="The claude.ai link these files came from: Open in claude.ai and Update use it."
            />
          </>
        )}

        {from === 'blank' && (
          <>
            <TextField ref={setFirst} label="Title" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} placeholder="Checkout flow" required />
            <div className="flex flex-col gap-2">
              <span className="text-[12px] font-semibold text-ink-2" aria-hidden="true">
                Kind
              </span>
              <SegmentedControl label="Kind" variant="inset" size={28} options={KIND_OPTIONS} value={blankKind} onChange={setBlankKind} className="self-start" />
            </div>
          </>
        )}

        {projectField}
        <LocationField
          value={projectId ? location : 'app-data'}
          onChange={(l) => {
            setLocation(l);
            setLocationPicked(true);
          }}
          hasProject={Boolean(projectId)}
        />
        {error && <ErrorLine>{error}</ErrorLine>}
        <button type="submit" hidden />
      </form>
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
        meta.version === 0
          ? "It has no files yet. This can't be undone."
          : meta.location === 'repo'
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
