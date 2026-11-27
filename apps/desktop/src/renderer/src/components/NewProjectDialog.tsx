import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { cloneUrlProblem, folderNameProblem, normalizeCloneInput, repoNameFromUrl, type CloneProgress, type GithubRepo, type Project } from '@oide/protocol';
import { Badge, Button, Checkbox, Dialog, Icon, Spinner, Tabs, TextField, cn, tabPanelProps } from '@oide/ui';
import { ipcErrorCode, ipcErrorMessage, oide } from '../lib/bridge';
import { useProjects } from '../stores/projects';
import { defaultParent, joinPath, rememberParent, useNewProject, type NewProjectTab } from '../stores/newProject';
import { toast } from '../stores/ui';

const TABS: ReadonlyArray<{ id: NewProjectTab; label: string }> = [
  { id: 'open', label: 'Open folder' },
  { id: 'clone', label: 'Clone repository' },
  { id: 'create', label: 'New repository' },
];
const ID = 'new-project';

/**
 * New project: the ways a project starts. Open folder (a git repository, or a plain folder oIDE
 * initialises), Clone repository (a URL, `owner/repo`, or one of your GitHub repositories through
 * your own `gh`), New repository (git init with a first commit). Main does the git work and asks
 * for trust where the code is not the user's own (see projects.ts in main).
 */
export function NewProjectDialog() {
  const open = useNewProject((s) => s.open);
  const tab = useNewProject((s) => s.tab);
  const [busy, setBusy] = useState(false);
  const hide = () => {
    if (!busy) useNewProject.getState().hide();
  };
  const done = (p: Project, verb: string) => {
    toast(`${verb} ${p.name}`, 'success');
    useNewProject.getState().hide();
  };
  return (
    <Dialog
      open={open}
      onClose={hide}
      title="New project"
      position="top"
      width={620}
      dismissOnScrim={!busy}
      description="A project is a git repository. Every agent you spawn in it gets its own worktree and branch."
    >
      <div className="flex flex-col">
        <Tabs
          tabs={TABS.map((t) => ({ ...t, disabled: busy && t.id !== tab }))}
          value={tab}
          onChange={(t) => useNewProject.getState().setTab(t)}
          label="How to start the project"
          idPrefix={ID}
          className="mt-2 px-5 gap-5 border-b border-line"
        />
        <div {...tabPanelProps(ID, tab)} className="px-5 pt-5 pb-5 outline-none">
          {tab === 'open' && <OpenFolder busy={busy} setBusy={setBusy} onDone={(p) => done(p, 'Opened')} onCancel={hide} />}
          {tab === 'clone' && <CloneRepo busy={busy} setBusy={setBusy} onDone={(p) => done(p, 'Cloned')} onCancel={hide} />}
          {tab === 'create' && <CreateRepo busy={busy} setBusy={setBusy} onDone={(p) => done(p, 'Created')} onCancel={hide} />}
        </div>
      </div>
    </Dialog>
  );
}

interface PaneProps {
  busy: boolean;
  setBusy: (b: boolean) => void;
  onDone: (p: Project) => void;
  onCancel: () => void;
}

function Footer({ children }: { children: ReactNode }) {
  return <div className="flex items-center justify-end gap-2 pt-4 mt-4 border-t border-line">{children}</div>;
}

function ErrorLine({ children }: { children?: string }) {
  if (!children) return null;
  return (
    <div role="alert" className="flex items-start gap-2 px-3 py-2.5 rounded-lg border border-bad-line bg-bad-bg text-[12.5px] text-ink-2 leading-[1.45]">
      <Icon name="alert-circle" className="text-bad shrink-0 mt-px" />
      <span className="min-w-0 break-words">{children}</span>
    </div>
  );
}

// ------------------------------------------------------------------------------- open folder

function OpenFolder({ busy, setBusy, onDone, onCancel }: PaneProps) {
  const [notRepo, setNotRepo] = useState<string>();
  const [commitFiles, setCommitFiles] = useState(true);
  const [error, setError] = useState<string>();

  const choose = async () => {
    setError(undefined);
    setNotRepo(undefined);
    const path = await oide.invoke('dialog.pickFolder', { title: 'Open a project folder' }).catch(() => null);
    if (!path) return;
    setBusy(true);
    try {
      const p = await useProjects.getState().open(path);
      if (p) onDone(p);
    } catch (err) {
      if (ipcErrorCode(err) === 'not_a_repo') setNotRepo(path);
      else setError(ipcErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const init = async () => {
    if (!notRepo) return;
    setBusy(true);
    setError(undefined);
    try {
      const p = await oide.invoke('projects.initFolder', { path: notRepo, commitFiles });
      onDone(p);
    } catch (err) {
      setError(ipcErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3.5">
      <p className="m-0 text-[13px] text-ink-2 leading-[1.5]">
        Choose a folder on this computer. A git repository opens as it is; a folder without git can be initialized here, so agents can branch from it.
      </p>
      {notRepo && (
        <div className="flex flex-col gap-3 p-3.5 rounded-[10px] border border-warn-line bg-warn-bg">
          <div className="flex items-start gap-2 text-[12.5px] text-ink-2 leading-[1.45]">
            <Icon name="warning" className="text-warn shrink-0 mt-px" />
            <span className="min-w-0">
              <span className="font-mono text-ink break-all">{notRepo}</span> is not a git repository yet. Initialize git there to use it as a project.
            </span>
          </div>
          <Checkbox
            checked={commitFiles}
            onChange={setCommitFiles}
            label="Commit its files as the first commit"
            description="Files your .gitignore lists stay out. Unchecked: an empty first commit, and the files stay uncommitted."
          />
        </div>
      )}
      <ErrorLine>{error}</ErrorLine>
      <Footer>
        <Button variant="secondary" size={32} onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        {notRepo ? (
          <>
            <Button variant="secondary" size={32} onClick={() => void choose()} disabled={busy}>
              Choose another…
            </Button>
            <Button variant="primary" size={32} icon="branch" onClick={() => void init()} disabled={busy}>
              {busy ? 'Initializing…' : 'Initialize git'}
            </Button>
          </>
        ) : (
          <Button variant="primary" size={32} icon="folder" onClick={() => void choose()} disabled={busy}>
            {busy ? 'Opening…' : 'Choose folder…'}
          </Button>
        )}
      </Footer>
    </div>
  );
}

// ------------------------------------------------------------------------------- location

function useLocation() {
  const projects = useProjects((s) => s.list);
  const [parent, setParent] = useState(() => defaultParent(projects));
  const choose = async () => {
    const p = await oide.invoke('dialog.pickFolder', { title: 'Choose where the project folder goes' }).catch(() => null);
    if (p) {
      setParent(p);
      rememberParent(p);
    }
    return p;
  };
  return { parent, choose };
}

function LocationField({ parent, onChoose, disabled }: { parent: string; onChoose: () => void; disabled: boolean }) {
  return (
    <div className="flex flex-col gap-2 min-w-0">
      <span id={`${ID}-location`} className="text-[12px] font-semibold text-ink-2">
        Location
      </span>
      <div className="flex items-center gap-2 min-w-0">
        <span
          aria-labelledby={`${ID}-location`}
          className={cn(
            'flex-1 min-w-0 h-[34px] px-2.5 flex items-center rounded-md border border-line-3 bg-chrome font-mono text-[12.5px]',
            parent ? 'text-ink-2' : 'text-ink-3',
          )}
          title={parent || undefined}
        >
          <span className="min-w-0 truncate">{parent || 'No folder chosen'}</span>
        </span>
        <Button size={32} icon="folder" onClick={onChoose} disabled={disabled} className="h-[34px] shrink-0">
          Choose…
        </Button>
      </div>
    </div>
  );
}

/** Location refused by main (not picked this session): ask for it again instead of failing. */
async function withLocation<T>(run: () => Promise<T>, choose: () => Promise<string | null>, retry: (parent: string) => Promise<T>): Promise<T | undefined> {
  try {
    return await run();
  } catch (err) {
    if (ipcErrorCode(err) !== 'forbidden_path') throw err;
    const picked = await choose();
    return picked ? retry(picked) : undefined;
  }
}

// ------------------------------------------------------------------------------- clone

function CloneRepo({ busy, setBusy, onDone, onCancel }: PaneProps) {
  const [input, setInput] = useState('');
  const [source, setSource] = useState<'url' | 'github'>('url');
  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [showUrlError, setShowUrlError] = useState(false);
  const [error, setError] = useState<string>();
  const [progress, setProgress] = useState<CloneProgress>();
  const { parent, choose } = useLocation();
  const urlRef = useRef<HTMLInputElement>(null);

  const url = normalizeCloneInput(input);
  const urlProblem = cloneUrlProblem(url);
  const finalName = nameTouched ? name : repoNameFromUrl(url);
  const nameProblem = finalName ? folderNameProblem(finalName) : 'Enter a folder name.';
  const ready = !urlProblem && !nameProblem && !!parent;

  useEffect(() => {
    if (!busy) return;
    return oide.on('projects.cloneProgress', setProgress);
  }, [busy]);

  const pickRepo = (r: GithubRepo) => {
    setInput(r.cloneUrl);
    setSource('github');
    setNameTouched(false);
    setShowUrlError(false);
  };

  const clone = async () => {
    setShowUrlError(true);
    if (!ready) return;
    setBusy(true);
    setError(undefined);
    setProgress({ phase: 'Connecting' });
    const run = (at: string) => oide.invoke('projects.clone', { url, parent: at, name: finalName, source });
    try {
      const p = await withLocation(() => run(parent), choose, run);
      if (p) onDone(p);
      else if (p === null) setError('Clone cancelled. Nothing was left behind.');
    } catch (err) {
      setError(ipcErrorMessage(err));
    } finally {
      setBusy(false);
      setProgress(undefined);
    }
  };

  return (
    <form
      className="flex flex-col gap-3.5"
      onSubmit={(e) => {
        e.preventDefault();
        void clone();
      }}
    >
      <TextField
        ref={urlRef}
        label="Repository"
        mono
        autoFocus
        value={input}
        disabled={busy}
        onChange={(e) => {
          setInput(e.target.value);
          setSource('url');
        }}
        onBlur={() => setShowUrlError(!!input.trim())}
        placeholder="https://github.com/owner/repo.git or owner/repo"
        error={showUrlError && input.trim() ? urlProblem : undefined}
        hint={
          url !== input.trim() && !urlProblem
            ? `Clones ${url}`
            : 'HTTPS or SSH URL, or owner/repo for GitHub. Uses your own git sign-in (credential manager, SSH keys, gh); oIDE never asks for or stores passwords.'
        }
        spellCheck={false}
        autoComplete="off"
      />
      <GithubRepos onPick={pickRepo} disabled={busy} selected={source === 'github' ? url : undefined} />
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,180px)] items-start gap-3">
        <LocationField parent={parent} onChoose={() => void choose()} disabled={busy} />
        <TextField
          label="Folder name"
          containerClassName="min-w-0"
          mono
          value={finalName}
          disabled={busy}
          onChange={(e) => {
            setName(e.target.value);
            setNameTouched(true);
          }}
          error={nameTouched && finalName ? nameProblem : undefined}
          spellCheck={false}
          autoComplete="off"
        />
      </div>
      {parent && finalName && !nameProblem && (
        <span className="text-[12px] text-ink-3 leading-[1.45] -mt-1">
          Clones into <span className="font-mono text-ink-2 break-all">{joinPath(parent, finalName)}</span>. You will be asked whether to trust it.
        </span>
      )}
      {busy && progress && <ProgressBar progress={progress} />}
      <ErrorLine>{error}</ErrorLine>
      <Footer>
        {busy ? (
          <Button variant="secondary" size={32} icon="stop" onClick={() => void oide.invoke('projects.cancelClone', undefined).catch(() => {})}>
            Cancel clone
          </Button>
        ) : (
          <Button variant="secondary" size={32} onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button type="submit" variant="primary" size={32} icon="branch" disabled={busy || !ready}>
          {busy ? 'Cloning…' : 'Clone'}
        </Button>
      </Footer>
    </form>
  );
}

function ProgressBar({ progress }: { progress: CloneProgress }) {
  const pct = progress.percent;
  return (
    <div className="flex flex-col gap-1.5" aria-live="polite">
      <div className="flex items-center gap-2 text-[12.5px] text-ink-2">
        <Spinner size={14} label="Cloning" />
        <span className="flex-1">{progress.phase}…</span>
        {pct !== undefined && <span className="font-mono text-ink-3">{pct}%</span>}
      </div>
      <div
        role="progressbar"
        aria-label={progress.phase}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        className="h-1.5 rounded-full bg-raised overflow-hidden"
      >
        <div className={cn('h-full bg-accent transition-[width] duration-200', pct === undefined && 'w-1/3 animate-pulse')} style={pct !== undefined ? { width: `${pct}%` } : undefined} />
      </div>
    </div>
  );
}

type GhState = { status: 'loading' } | { status: 'ready'; repos: GithubRepo[] } | { status: 'unavailable'; reason?: string };

/** Your GitHub repositories (through your own `gh` login). Hidden behind a short note when gh is missing. */
function GithubRepos({ onPick, disabled, selected }: { onPick: (r: GithubRepo) => void; disabled: boolean; selected?: string }) {
  const [state, setState] = useState<GhState>({ status: 'loading' });
  const [filter, setFilter] = useState('');
  useEffect(() => {
    let live = true;
    oide
      .invoke('projects.githubRepos', undefined)
      .then((r) => live && setState(r.available ? { status: 'ready', repos: r.repos } : { status: 'unavailable', ...(r.reason ? { reason: r.reason } : {}) }))
      .catch(() => live && setState({ status: 'unavailable' }));
    return () => {
      live = false;
    };
  }, []);
  const shown = useMemo(() => {
    if (state.status !== 'ready') return [];
    const q = filter.trim().toLowerCase();
    return q ? state.repos.filter((r) => r.nameWithOwner.toLowerCase().includes(q) || r.description?.toLowerCase().includes(q)) : state.repos;
  }, [state, filter]);

  if (state.status === 'loading') {
    return (
      <div className="flex items-center gap-2 text-[12px] text-ink-3">
        <Spinner size={12} label="Loading your GitHub repositories" /> Looking for your GitHub repositories…
      </div>
    );
  }
  if (state.status === 'unavailable') {
    return <span className="text-[12px] text-ink-3 leading-[1.45]">{state.reason ?? 'Sign in to the GitHub CLI (gh auth login) to pick from your repositories.'}</span>;
  }
  return (
    <fieldset className="m-0 p-0 border-0 flex flex-col gap-2.5 min-w-0">
      <legend className="text-[12px] font-semibold text-ink-2 mb-2.5 p-0">Or pick one of your GitHub repositories</legend>
      <TextField label="Filter your repositories" hideLabel size={34} placeholder={`Filter ${state.repos.length} repositories`} value={filter} onChange={(e) => setFilter(e.target.value)} disabled={disabled} />
      <ul className="m-0 list-none flex flex-col gap-px max-h-[188px] overflow-y-auto overflow-x-hidden rounded-lg border border-line-2 bg-chrome p-1.5">
        {shown.length === 0 && <li className="px-2.5 py-2 text-[12px] text-ink-3">{state.repos.length ? 'No repository matches.' : 'No repositories on this account.'}</li>}
        {shown.map((r) => (
          <li key={r.nameWithOwner}>
            <button
              type="button"
              disabled={disabled}
              aria-pressed={selected === r.cloneUrl}
              onClick={() => onPick(r)}
              className={cn(
                'w-full min-w-0 flex items-center gap-2.5 px-2.5 py-[7px] rounded-md border-0 text-left text-[12.5px]',
                selected === r.cloneUrl ? 'bg-selected text-ink' : 'bg-transparent text-ink-2 hover:bg-raised',
              )}
            >
              <span className="font-mono shrink-0 max-w-[60%] truncate">{r.nameWithOwner}</span>
              {r.isPrivate && <Badge>Private</Badge>}
              {r.description && <span className="text-ink-3 truncate min-w-0 flex-1">{r.description}</span>}
            </button>
          </li>
        ))}
      </ul>
    </fieldset>
  );
}

// ------------------------------------------------------------------------------- create

function CreateRepo({ busy, setBusy, onDone, onCancel }: PaneProps) {
  const [name, setName] = useState('');
  const [touched, setTouched] = useState(false);
  const [readme, setReadme] = useState(true);
  const [error, setError] = useState<string>();
  const { parent, choose } = useLocation();
  const problem = folderNameProblem(name);
  const ready = !problem && !!parent;

  const create = async () => {
    setTouched(true);
    if (!ready) return;
    setBusy(true);
    setError(undefined);
    const run = (at: string) => oide.invoke('projects.create', { parent: at, name, readme });
    try {
      const p = await withLocation(() => run(parent), choose, run);
      if (p) onDone(p);
    } catch (err) {
      setError(ipcErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="flex flex-col gap-3.5"
      onSubmit={(e) => {
        e.preventDefault();
        void create();
      }}
    >
      <TextField
        label="Name"
        mono
        autoFocus
        value={name}
        disabled={busy}
        onChange={(e) => setName(e.target.value)}
        onBlur={() => setTouched(!!name)}
        placeholder="my-project"
        error={touched ? problem : undefined}
        hint="The folder's name. Letters, numbers, dashes and dots work everywhere."
        spellCheck={false}
        autoComplete="off"
      />
      <LocationField parent={parent} onChoose={() => void choose()} disabled={busy} />
      <Checkbox checked={readme} onChange={setReadme} label="Add a README.md" description="Unchecked: an empty first commit. Either way agents have a base to branch from." />
      {parent && name && !problem && (
        <span className="text-[12px] text-ink-3 leading-[1.45]">
          Creates <span className="font-mono text-ink-2 break-all">{joinPath(parent, name)}</span> with git on <span className="font-mono">main</span> and a first commit.
        </span>
      )}
      <ErrorLine>{error}</ErrorLine>
      <Footer>
        <Button variant="secondary" size={32} onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" size={32} icon="plus" disabled={busy || !ready}>
          {busy ? 'Creating…' : 'Create repository'}
        </Button>
      </Footer>
    </form>
  );
}
