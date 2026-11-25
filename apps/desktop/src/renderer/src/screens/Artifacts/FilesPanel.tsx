/**
 * Multi-file artifacts in the viewer (ADR 0014): the Files panel (a compact tree, the entry marked
 * "Opens on") and the state of one non-entry file being viewed or edited.
 *
 * A text file opens in Monaco (language by extension) and saves with `artifacts.writeFiles` and
 * `baseVersion`, with the same live rules as the entry editor (`liveDecision`): a newer version
 * written by someone else is loaded when there are no unsaved edits ("Updated by …"), and kept apart
 * in a conflict banner when there are. A version that did not change this file is taken silently.
 * An image is shown from `artifacts.readFile` as a data: URL (the renderer CSP allows data: images,
 * not the oide-artifact: scheme).
 */
import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import type { ArtifactFile, ArtifactFileContent, ArtifactMeta } from '@oide/protocol';
import { Badge, Icon, cn } from '@oide/ui';
import { ipcErrorCode, ipcErrorMessage, oide } from '../../lib/bridge';
import { formatSize } from '../../lib/attachments';
import { fileTree, liveDecision } from './model';

export interface OtherVersion {
  version: number;
  data: string;
  author: string | undefined;
}

export interface ArtifactFileState {
  /** The file content at `base.version`, or null while it loads. */
  base: { version: number; content: ArtifactFileContent } | null;
  draft: string;
  setDraft: (v: string) => void;
  dirty: boolean;
  saving: boolean;
  error: string | null;
  notice: OtherVersion | null;
  conflict: OtherVersion | null;
  save: () => Promise<void>;
  takeTheirs: () => void;
  dismissNotice: () => void;
}

/**
 * One file of a multi-file artifact (`path`, not the entry). `version` and `authorOf` follow the
 * artifact as `artifacts.changed` reloads it; `own` holds the versions this viewer saved itself.
 */
export function useArtifactFile(opts: {
  id: string;
  path: string | null;
  version: number;
  authorOf: (version: number) => string | undefined;
  own: MutableRefObject<Set<number>>;
  onSaved: (meta: ArtifactMeta) => void;
}): ArtifactFileState {
  const { id, path, version, authorOf, own, onSaved } = opts;
  const [base, setBase] = useState<ArtifactFileState['base']>(null);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<OtherVersion | null>(null);
  const [conflict, setConflict] = useState<OtherVersion | null>(null);
  const text = base?.content.encoding === 'utf8';
  const dirty = Boolean(base && text && draft !== base.content.data);
  const live = useRef({ base, dirty, path });
  live.current = { base, dirty, path };

  // A new file: load it.
  useEffect(() => {
    setBase(null);
    setDraft('');
    setError(null);
    setNotice(null);
    setConflict(null);
    if (!path) return;
    let on = true;
    const at = version;
    oide
      .invoke('artifacts.readFile', { id, path })
      .then((content) => {
        if (!on) return;
        setBase({ version: at, content });
        setDraft(content.encoding === 'utf8' ? content.data : '');
      })
      .catch((err) => on && setError(`Couldn't open ${path}: ${ipcErrorMessage(err)}`));
    return () => {
      on = false;
    };
    // Only another file reloads from scratch; a new version goes through the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, path]);

  // A new version of the artifact: ours, someone else's, or a conflict with unsaved edits.
  useEffect(() => {
    const cur = live.current;
    if (!cur.path || !cur.base) return;
    const d = liveDecision({ baseVersion: cur.base.version, incomingVersion: version, ownVersions: own.current, dirty: cur.dirty });
    if (d === 'none') return;
    if (d === 'own') {
      setBase((b) => (b ? { ...b, version } : b));
      return;
    }
    let on = true;
    const p = cur.path;
    oide
      .invoke('artifacts.readFile', { id, path: p })
      .then((content) => {
        if (!on || live.current.path !== p) return;
        const prev = live.current.base;
        // The new version did not touch this file: take it quietly.
        if (prev && prev.content.data === content.data && prev.content.encoding === content.encoding) return setBase({ version, content });
        const other = { version, data: content.data, author: authorOf(version) };
        if (d === 'reload') {
          setBase({ version, content });
          setDraft(content.encoding === 'utf8' ? content.data : '');
          setNotice(other);
          setConflict(null);
        } else setConflict(other);
      })
      .catch(() => {
        // The file is gone in the new version (deleted by an agent): say so instead of saving over it.
        if (on && live.current.path === p) setError(`${p} is not in v${version} any more.`);
      });
    return () => {
      on = false;
    };
    // Only the version matters here; the rest is read through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  const save = async () => {
    if (!path || !base || !dirty || saving) return;
    const data = draft;
    const over = conflict;
    setSaving(true);
    setError(null);
    try {
      const next = await oide.invoke('artifacts.writeFiles', {
        id,
        files: [{ path, encoding: 'utf8', data }],
        note: over ? `Edited ${path} over v${over.version}` : `Edited ${path}`,
        baseVersion: over ? over.version : base.version,
      });
      own.current.add(next.version);
      setBase({ version: next.version, content: { encoding: 'utf8', data } });
      setConflict(null);
      setNotice(null);
      onSaved(next);
    } catch (err) {
      if (ipcErrorCode(err) === 'conflict') {
        try {
          const fresh = await oide.invoke('artifacts.get', { id });
          const theirs = await oide.invoke('artifacts.readFile', { id, path });
          setConflict({ version: fresh.meta.version, data: theirs.data, author: fresh.versions.find((v) => v.version === fresh.meta.version)?.author });
        } catch {
          setError(ipcErrorMessage(err));
        }
      } else setError(ipcErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const takeTheirs = () => {
    if (!conflict) return;
    setBase({ version: conflict.version, content: { encoding: 'utf8', data: conflict.data } });
    setDraft(conflict.data);
    setConflict(null);
    setError(null);
  };

  return {
    base,
    draft,
    setDraft: (v) => {
      setDraft(v);
      setError(null);
    },
    dirty,
    saving,
    error,
    notice,
    conflict,
    save,
    takeTheirs,
    dismissNotice: () => setNotice(null),
  };
}

export interface FilesPanelProps {
  files: readonly ArtifactFile[] | null;
  entry: string;
  /** The open file (the entry when null). */
  selected: string | null;
  onSelect: (path: string) => void;
}

/** The compact file tree: JetBrains Mono paths, folders as plain rows, the entry marked "Opens on". */
export function FilesPanel({ files, entry, selected, onSelect }: FilesPanelProps) {
  const rows = files ? fileTree(files) : [];
  const current = selected ?? entry;
  return (
    <nav aria-label="Files" className="w-[232px] shrink-0 min-h-0 flex flex-col rounded-xl border border-line-2 bg-panel overflow-hidden">
      <div className="flex items-center justify-between px-3 h-8 border-b border-line-2">
        <h3 className="m-0 text-[11px] font-semibold tracking-[0.08em] uppercase text-ink-3">Files</h3>
        {files && <span className="text-[11.5px] text-ink-3">{files.length}</span>}
      </div>
      {!files ? (
        <span className="px-3 py-2 text-[12px] text-ink-3">Loading…</span>
      ) : (
        <ul className="m-0 p-1 list-none overflow-auto flex-1 min-h-0">
          {rows.map((r) =>
            r.dir ? (
              <li key={`d:${r.path}`} className="flex items-center gap-1.5 h-[26px] px-1.5 font-mono text-[12px] text-ink-3" style={{ paddingLeft: 6 + r.depth * 12 }}>
                <Icon name="folder" size={13} />
                <span className="truncate">{r.name}</span>
              </li>
            ) : (
              <li key={r.path}>
                <button
                  type="button"
                  onClick={() => onSelect(r.path)}
                  aria-current={r.path === current ? 'true' : undefined}
                  title={`${r.path} · ${formatSize(r.size ?? 0)}`}
                  className={cn(
                    'w-full flex items-center gap-1.5 h-[26px] pr-1.5 rounded-sm border-0 text-left font-mono text-[12px]',
                    r.path === current ? 'bg-selected text-ink' : 'bg-transparent text-ink-2 hover:bg-raised hover:text-ink',
                  )}
                  style={{ paddingLeft: 6 + r.depth * 12 }}
                >
                  <Icon name="file" size={13} className="shrink-0 text-ink-3" />
                  <span className="flex-1 min-w-0 truncate">{r.name}</span>
                  {r.path === entry && (
                    <Badge tone="accent" className="font-sans shrink-0">
                      Opens on
                    </Badge>
                  )}
                </button>
              </li>
            ),
          )}
        </ul>
      )}
    </nav>
  );
}
