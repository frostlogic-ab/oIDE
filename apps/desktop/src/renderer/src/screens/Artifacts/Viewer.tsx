/**
 * "Open": the artifact full size, with an editor per kind (all lazy chunks):
 * - doc: Monaco (Markdown) with the rendered preview live beside it.
 * - design: Monaco (HTML) beside the sandboxed preview, which reloads when you save.
 * - whiteboard: the embedded Excalidraw editor.
 * Plus Preview (docs, designs) and Compare (a side-by-side diff of any two versions, or of a version
 * and your unsaved edits).
 *
 * Save writes a new numbered version (`artifacts.save` with `baseVersion`). When an agent saves
 * while the artifact is open (`artifacts.changed` reloads `detail`), the editor loads it and says
 * "Updated by <agent>"; with unsaved edits it keeps them and shows a conflict banner instead.
 */
import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ArtifactMeta, CommandOutput } from '@oide/protocol';
import { Badge, Button, Dialog, DiffStat, Icon, Menu, Select, Spinner, Tabs, tabPanelProps } from '@oide/ui';
import { ipcErrorCode, ipcErrorMessage, oide } from '../../lib/bridge';
import { useKeymapScope } from '../../lib/useKeymap';
import { useAgents } from '../../stores/agents';
import { toast } from '../../stores/ui';
import { ExtensionArtifactView } from '../../extensions/ExtensionArtifactView';
import { artifactTypeOf } from '../../extensions/model';
import { useExtensions } from '../../extensions/store';
import { FixImportPanel } from './FixImportPanel';
import { DesignFrame, MarkdownView } from './Preview';
import {
  KIND_LABEL,
  authorLabel,
  contentForDiff,
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
  const [base, setBase] = useState({ version: meta.version, content: detail.content });
  const [draft, setDraft] = useState(detail.content);
  /** What "unchanged" looks like: the base content, or (whiteboards) Excalidraw's serialisation of it. */
  const [baseline, setBaseline] = useState<string | null>(kind === 'whiteboard' ? null : detail.content);
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
  const live = useRef({ base, dirty });
  live.current = { base, dirty };

  // A broken import puts the cursor in its paste box instead.
  useEffect(() => {
    if (!meta.brokenImport) headingRef.current?.focus();
    // On open only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const authorOf = (version: number) => detail.versions.find((v) => v.version === version)?.author;

  // An artifacts.changed reload brought a newer version: ours, someone else's, or a conflict.
  useEffect(() => {
    const incoming = {
      version: detail.meta.version,
      content: detail.content,
      author: authorOf(detail.meta.version),
    };
    const d = liveDecision({
      baseVersion: live.current.base.version,
      incomingVersion: incoming.version,
      ownVersions: own.current,
      dirty: live.current.dirty,
    });
    if (d === 'own') setBase({ version: incoming.version, content: incoming.content });
    else if (d === 'reload') loadOther(incoming, true);
    else if (d === 'conflict') setConflict(incoming);
    // Only a new version or content matters here; the rest is read through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail.meta.version, detail.content]);

  /** Replace the editor content with another saved version (an agent's, or "Use theirs"). */
  const loadOther = (o: Other, announce: boolean) => {
    setBase({ version: o.version, content: o.content });
    setDraft(o.content);
    setBaseline(kind === 'whiteboard' ? null : o.content);
    setSceneKey((k) => k + 1);
    setConflict(null);
    setError(null);
    setNotice(announce ? o : null);
  };

  const requestClose = () => (dirty ? setConfirmClose(true) : onClose());
  useKeymapScope('artifact-viewer', {
    'view.back': () => {
      // Esc inside the whiteboard belongs to Excalidraw (deselect, close a menu).
      if (document.activeElement?.closest('.oide-whiteboard')) return;
      requestClose();
    },
  });

  // Pasted code saved from the fix panel: it is our own version, and the editor starts from it.
  const fixed = (next: ArtifactMeta, content: string) => {
    own.current.add(next.version);
    setBase({ version: next.version, content });
    setDraft(content);
    setBaseline(content);
    onSaved(next, content);
  };

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
      const next = await oide.invoke('artifacts.save', {
        id: meta.id,
        content,
        note: over ? `Edited by you over v${over.version}` : 'Edited by you',
        baseVersion: over ? over.version : base.version,
      });
      own.current.add(next.version);
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
            {extType ? `${extType.label} (${extType.displayName})` : KIND_LABEL[kind]} · {projectName || 'Personal'} · v{base.version}
          </span>
        </div>
        {dirty && <Badge tone="warn">Unsaved changes</Badge>}
        <div className="flex-1" />
        {!meta.brokenImport && <Tabs label="View" idPrefix="viewer" variant="pill" tabs={tabs} value={mode} onChange={setMode} />}
        {!meta.brokenImport && (
          <Button size={32} variant="primary" onClick={() => void save()} disabled={!dirty || saving}>
            {saving ? 'Saving…' : 'Save'}
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

      {conflict && (
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
      {!conflict && notice && (
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

      {meta.brokenImport ? (
        <div className="flex-1 min-h-0 overflow-auto p-4">
          <div className="max-w-[720px] mx-auto">
            <FixImportPanel meta={meta} autoFocus onSaved={fixed} onReplaced={onReplaced} onDelete={onDelete} />
          </div>
        </div>
      ) : (
      <div {...tabPanelProps('viewer', mode)} className="flex-1 min-h-0 flex gap-4 p-4 outline-none">
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
