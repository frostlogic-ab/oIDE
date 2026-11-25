/**
 * Artifacts screen (docs/wiki/raw/design/Artifacts.dc.html, page: docs/wiki/pages/screen-artifacts.md).
 *
 * Grid of local artifacts filtered by kind, the shared project scope and a search; a detail pane
 * with a live preview, Open, Give to an agent, Open in claude.ai, Rename, Delete, Agents using it
 * and History (view, restore or compare versions); Import from claude.ai and New artifact dialogs.
 * Open shows the editor for the kind (Viewer.tsx).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { ArtifactMeta, ArtifactUse, ArtifactVersion, CommandOutput } from '@oide/protocol';
import { Button, EmptyState, Icon, IconButton, LinkButton, Spinner, agentStatusMeta, cn } from '@oide/ui';
import { HeaderSlot } from '../../components/frame/HeaderSlot';
import { invokeOr, ipcErrorMessage, isNotImplemented, oide } from '../../lib/bridge';
import { useAgents } from '../../stores/agents';
import { projectName as nameOf, useProjects } from '../../stores/projects';
import { navigate, useRouter } from '../../stores/router';
import { useScope } from '../../stores/scope';
import { toast } from '../../stores/ui';
import { DeleteDialog, ImportDialog, NewArtifactDialog, RenameDialog } from './Dialogs';
import { ArtifactPreview, KindThumb } from './Preview';
import { Viewer, type CompareSide, type ViewerMode } from './Viewer';
import { KIND_LABEL, KIND_TABS, agentsUsing, filterArtifacts, isClaudeLink, usageLine, versionLabel, type KindTab } from './model';
import './artifacts.css';
import { ResizableAside } from '../../components/ResizableAside';
import { PANELS } from '../../lib/panels';

type Detail = CommandOutput<'artifacts.get'>;
type OpenAs = { mode?: ViewerMode; compare?: { from: CompareSide; to: CompareSide } };

/** List + uses log, refreshed on `artifacts.changed`. */
function useLibrary() {
  const [list, setList] = useState<ArtifactMeta[] | null>(null);
  const [uses, setUses] = useState<Record<string, ArtifactUse[]>>({});
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const l = await invokeOr('artifacts.list', {}, []);
      setList(l);
      setError(null);
      if (l.length) setUses(await invokeOr('artifacts.uses', { ids: l.map((a) => a.id).slice(0, 500) }, {}));
    } catch (err) {
      setList((prev) => prev ?? []);
      setError(ipcErrorMessage(err));
    }
  }, []);

  useEffect(() => {
    void load();
    return oide.on('artifacts.changed', () => void load());
  }, [load]);

  return { list, uses, error, reload: load };
}

function useDetail(id: string | undefined) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const load = useCallback(async () => {
    if (!id) return setDetail(null);
    try {
      setDetail(await oide.invoke('artifacts.get', { id }));
    } catch (err) {
      if (!isNotImplemented(err)) toast(`Couldn't load the artifact: ${ipcErrorMessage(err)}`, 'error');
      setDetail(null);
    }
  }, [id]);
  useEffect(() => {
    setDetail((d) => (d?.meta.id === id ? d : null));
    void load();
    return oide.on('artifacts.changed', (e) => {
      if (e.id && e.id !== id) return;
      // Deleted (by an agent, or in another window): drop it instead of reporting a failed load.
      if (e.change === 'deleted') return setDetail(null);
      void load();
    });
  }, [id, load]);
  return { detail, setDetail, reload: load };
}

export default function ArtifactsScreen() {
  const route = useRouter((s) => s.route);
  const routeId = route.screen === 'artifacts' ? route.params.artifactId : undefined;
  const scope = useScope((s) => s.scope);
  const setScope = useScope((s) => s.setScope);
  const projects = useProjects((s) => s.list);
  const agents = useAgents((s) => s.byId);
  const { list, uses } = useLibrary();
  const [kind, setKind] = useState<KindTab>('all');
  const [query, setQuery] = useState('');
  const [dialog, setDialog] = useState<'new' | 'import' | 'rename' | 'delete' | null>(null);
  const [opened, setOpened] = useState<false | OpenAs>(false);

  const projectName = useCallback((id: string | undefined) => (id ? nameOf(projects, id) : 'Personal'), [projects]);
  const visible = useMemo(() => filterArtifacts(list ?? [], { kind, project: scope, query }, projectName), [list, kind, scope, query, projectName]);
  const selectedId = routeId && (list ?? []).some((a) => a.id === routeId) ? routeId : visible[0]?.id;
  const { detail, setDetail } = useDetail(selectedId);
  const select = (id: string) => useRouter.getState().replace('artifacts', { artifactId: id });

  useEffect(() => setOpened(false), [selectedId]);

  const shown = detail?.meta.id === selectedId ? detail : null;
  const actionDialogs = shown && (
    <>
      <RenameDialog
        open={dialog === 'rename'}
        meta={shown.meta}
        onClose={() => setDialog(null)}
        onRenamed={(meta) => {
          setDialog(null);
          setDetail((d) => (d && d.meta.id === meta.id ? { ...d, meta } : d));
          toast(`Renamed to ${meta.title}`, 'success');
        }}
      />
      <DeleteDialog
        open={dialog === 'delete'}
        meta={shown.meta}
        onClose={() => setDialog(null)}
        onDeleted={() => {
          setDialog(null);
          setOpened(false);
          setDetail(null);
          toast(`Deleted ${shown.meta.title}`, 'success');
          const next = visible.find((a) => a.id !== shown.meta.id);
          useRouter.getState().replace('artifacts', next ? { artifactId: next.id } : {});
        }}
      />
    </>
  );

  if (opened && shown) {
    return (
      <>
        <Viewer
          key={shown.meta.id}
          detail={shown}
          projectName={shown.meta.projectId ? projectName(shown.meta.projectId) : ''}
          initialMode={opened.mode}
          compare={opened.compare}
          onClose={() => setOpened(false)}
          onSaved={(meta, content) => setDetail((d) => (d && d.meta.id === meta.id ? withSaved(d, meta, content) : d))}
          onRename={() => setDialog('rename')}
          onDelete={() => setDialog('delete')}
        />
        {actionDialogs}
      </>
    );
  }

  const created = (meta: ArtifactMeta) => {
    setDialog(null);
    setKind('all');
    setQuery('');
    if (meta.projectId && scope !== 'all' && scope !== meta.projectId) void setScope(meta.projectId);
    select(meta.id);
  };

  return (
    <>
      <HeaderSlot name="actions">
          <label className="flex items-center gap-1.5 h-7 px-2.5 rounded-md border border-line-3 bg-card text-ink-3 focus-within:border-accent">
            <Icon name="search" size={14} />
            <span className="sr-only">Search artifacts</span>
            <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search artifacts" className="w-[180px] bg-transparent border-0 outline-none text-ink text-[12.5px] placeholder:text-ink-3" />
          </label>
      </HeaderSlot>
      <main className="flex-1 min-w-[360px] overflow-auto flex flex-col gap-4 px-5 py-[18px] box-border">
        <div className="flex items-center gap-3 flex-wrap">
          <h1 className="m-0 text-[18px] font-semibold">Artifacts</h1>
          <KindTabs value={kind} onChange={setKind} />
          <div className="flex-1" />
          <label htmlFor="aproj" className="text-[12px] text-ink-3">
            Project
          </label>
          <select
            id="aproj"
            value={scope}
            onChange={(e) => void setScope(e.target.value)}
            className="h-[30px] px-2 rounded-md border border-line-3 bg-card text-ink text-[12.5px] outline-none focus:border-accent"
          >
            <option value="all">All projects</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <Button size={32} className="rounded-md" onClick={() => setDialog('import')}>
            Import from claude.ai
          </Button>
          <Button size={32} variant="primary" className="rounded-md px-3.5" onClick={() => setDialog('new')}>
            + New artifact
          </Button>
        </div>

        {list === null ? (
          <div className="flex-1 flex items-center justify-center">
            <Spinner />
          </div>
        ) : visible.length === 0 ? (
          <EmptyState
            icon="artifacts"
            title={list.length ? 'No artifacts match' : 'No artifacts yet'}
            description={list.length ? 'Try another type, project or search.' : 'Create a design, doc or whiteboard, or import one from claude.ai. Agents read and write them through oIDE.'}
            className="flex-1"
          />
        ) : (
          <div id="artifact-grid" role="tabpanel" aria-label="Artifacts" className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(220px,1fr))]">
            {visible.map((a) => {
              const line = usageLine(uses[a.id], agents);
              const sel = a.id === selectedId;
              return (
                <button
                  key={a.id}
                  type="button"
                  aria-pressed={sel}
                  onClick={() => select(a.id)}
                  onDoubleClick={() => {
                    select(a.id);
                    setOpened({});
                  }}
                  className={cn('flex flex-col p-0 rounded-xl border bg-card overflow-hidden text-left text-ink', sel ? 'border-accent' : 'border-line-2 hover:border-line-hover')}
                >
                  <div className="h-[120px] w-full bg-raised relative box-border">
                    <KindThumb kind={a.kind} />
                  </div>
                  <div className="flex flex-col gap-[3px] px-3 py-2.5 w-full box-border">
                    <span className="font-semibold truncate">{a.title}</span>
                    <span className="text-[12px] text-ink-3">
                      {KIND_LABEL[a.kind]} · {projectName(a.projectId)}
                    </span>
                    <span className={cn('text-[11.5px]', line.live ? 'text-ok' : 'text-ink-3')}>{line.text}</span>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </main>

      <DetailPane
        key={selectedId ?? 'none'}
        detail={shown}
        selected={Boolean(selectedId)}
        projectName={projectName}
        agentTitle={(id) => agents[id]?.title}
        agentStatus={(id) => agents[id]?.status}
        onOpen={(o) => setOpened(o ?? {})}
        onRestored={(d) => setDetail(d)}
        onRename={() => setDialog('rename')}
        onDelete={() => setDialog('delete')}
      />
      {actionDialogs}

      <NewArtifactDialog open={dialog === 'new'} onClose={() => setDialog(null)} projects={projects} defaultProjectId={scope === 'all' ? undefined : scope} onCreated={created} />
      <ImportDialog open={dialog === 'import'} onClose={() => setDialog(null)} projects={projects} defaultProjectId={scope === 'all' ? undefined : scope} onImported={created} />
    </>
  );
}

/** Detail after one of our own saves (until the artifacts.changed reload brings the real versions list). */
function withSaved(d: Detail, meta: ArtifactMeta, content: string): Detail {
  const versions = d.versions.some((v) => v.version === meta.version) ? d.versions : [{ version: meta.version, ts: meta.updatedAt, author: 'user', note: 'Edited by you' }, ...d.versions];
  return { ...d, meta, content, versions };
}

function KindTabs({ value, onChange }: { value: KindTab; onChange: (k: KindTab) => void }) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const i = KIND_TABS.findIndex((t) => t.id === value);
    const n = (i + (e.key === 'ArrowRight' ? 1 : KIND_TABS.length - 1)) % KIND_TABS.length;
    onChange(KIND_TABS[n]!.id);
    refs.current[n]?.focus();
  };
  return (
    <div role="tablist" aria-label="Type" className="flex gap-1.5 flex-wrap" onKeyDown={onKeyDown}>
      {KIND_TABS.map((t, i) => {
        const on = t.id === value;
        return (
          <button
            key={t.id}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="tab"
            aria-selected={on}
            aria-controls="artifact-grid"
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(t.id)}
            className={cn('h-7 px-3 rounded-[14px] border text-[12px]', on ? 'border-line-3 bg-selected text-ink' : 'border-line-2 bg-transparent text-ink-2 hover:bg-raised')}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

interface DetailPaneProps {
  detail: Detail | null;
  selected: boolean;
  projectName: (id: string | undefined) => string;
  agentTitle: (id: string) => string | undefined;
  agentStatus: (id: string) => Parameters<typeof agentStatusMeta>[0] | undefined;
  onOpen: (o?: OpenAs) => void;
  onRestored: (d: Detail) => void;
  onRename: () => void;
  onDelete: () => void;
}

function DetailPane({ detail, selected, projectName, agentTitle, agentStatus, onOpen, onRestored, onRename, onDelete }: DetailPaneProps) {
  const [viewing, setViewing] = useState<{ version: number; content: string } | null>(null);
  const [busy, setBusy] = useState(false);

  if (!detail) {
    return (
      <ResizableAside panel={PANELS.artifactsDetails} aria-label="Artifact details" className="flex flex-col items-center justify-center gap-3 px-4 py-[18px] bg-panel border-l border-line box-border text-[12.5px] text-ink-3">
        {selected ? <Spinner /> : 'Select an artifact to see it here.'}
      </ResizableAside>
    );
  }

  const { meta, versions } = detail;
  const users = agentsUsing(detail.uses);
  const claude = isClaudeLink(meta.importedFrom) ? meta.importedFrom : undefined;
  const origin = meta.importedFrom ? (claude ? 'imported from claude.ai' : 'imported') : meta.location === 'repo' ? 'in the repo' : 'personal';

  const viewVersion = async (v: ArtifactVersion) => {
    if (v.version === meta.version) return setViewing(null);
    try {
      const { content } = await oide.invoke('artifacts.readVersion', { id: meta.id, version: v.version });
      setViewing({ version: v.version, content });
    } catch (err) {
      toast(`Couldn't open v${v.version}: ${ipcErrorMessage(err)}`, 'error');
    }
  };

  const restore = async () => {
    if (!viewing) return;
    setBusy(true);
    try {
      const next = await oide.invoke('artifacts.save', { id: meta.id, content: viewing.content, note: `Restored v${viewing.version}` });
      toast(`Restored v${viewing.version} as v${next.version}`, 'success');
      onRestored({ ...detail, meta: next, content: viewing.content });
      setViewing(null);
    } catch (err) {
      toast(`Couldn't restore: ${ipcErrorMessage(err)}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <ResizableAside panel={PANELS.artifactsDetails} aria-label="Artifact details" className="min-h-0 overflow-auto flex flex-col gap-3.5 px-4 py-[18px] bg-panel border-l border-line box-border">
      <div className="h-[190px] shrink-0 rounded-xl bg-raised border border-line-2 overflow-hidden box-border">
        <ArtifactPreview
          artifactId={meta.id}
          title={viewing ? `${meta.title} v${viewing.version}` : meta.title}
          kind={meta.kind}
          content={viewing?.content ?? detail.content}
          forceInline={Boolean(viewing)}
          compact
          version={meta.version}
        />
      </div>
      {viewing && (
        <div role="status" className="flex items-center gap-2 flex-wrap px-2.5 py-2 rounded-md border border-review-line bg-review-bg text-[12px] text-ink-2">
          <span className="flex-1">Viewing v{viewing.version} (current is v{meta.version})</span>
          <Button size={28} onClick={() => onOpen({ mode: 'compare', compare: { from: viewing.version, to: meta.version } })}>
            Compare
          </Button>
          <Button size={28} onClick={() => void restore()} disabled={busy}>
            Restore
          </Button>
          <Button size={28} variant="ghost" onClick={() => setViewing(null)}>
            Back to latest
          </Button>
        </div>
      )}
      <div className="flex items-start gap-1">
        <div className="flex-1 min-w-0 flex flex-col gap-1">
          <h2 className="m-0 text-[16px] font-semibold break-words">{meta.title}</h2>
          <span className="text-[12px] text-ink-3">
            {KIND_LABEL[meta.kind]} · {projectName(meta.projectId)} · {origin}
          </span>
        </div>
        <Button size={28} variant="ghost" aria-label={`Rename ${meta.title}`} onClick={onRename}>
          Rename
        </Button>
        <IconButton icon="trash" aria-label={`Delete ${meta.title}`} title="Delete" onClick={onDelete} />
      </div>
      <div className="flex gap-2 flex-wrap">
        <Button size={32} variant="primary" className="rounded-md" onClick={() => onOpen()}>
          Open
        </Button>
        <LinkButton
          href="#spawn"
          size={32}
          className="rounded-md"
          onClick={(e) => {
            e.preventDefault();
            navigate('spawn', { projectId: meta.projectId, context: [{ kind: 'artifact', id: meta.id, title: meta.title }] });
          }}
        >
          Give to an agent
        </LinkButton>
        {claude && (
          <Button size={32} className="rounded-md" icon="external-link" onClick={() => void oide.invoke('shell.openExternal', { url: claude }).catch((err) => toast(ipcErrorMessage(err), 'error'))}>
            Open in claude.ai
          </Button>
        )}
      </div>
      {meta.importedFrom && <span className="text-[11.5px] text-ink-3 -mt-1.5">A copy, not synced. Changes on claude.ai don't show up here.</span>}

      <section aria-labelledby="art-users" className="flex flex-col gap-2">
        <h3 id="art-users" className="m-0 text-[11px] font-semibold tracking-[0.08em] uppercase text-ink-3">
          Agents using it
        </h3>
        {users.length === 0 ? (
          <span className="text-[12.5px] text-ink-3">No agent has read or written it yet.</span>
        ) : (
          users.map((u) => {
            const status = agentStatus(u.agentId);
            const color = status ? agentStatusMeta(status).color : '#6B7584';
            return (
              <a
                key={u.agentId}
                href={`#focus/${u.agentId}`}
                onClick={(e) => {
                  e.preventDefault();
                  navigate('focus', { agentId: u.agentId });
                }}
                className="flex items-center gap-2 px-2.5 py-2 rounded-md bg-card border border-line-2 text-ink no-underline hover:border-line-hover hover:text-ink"
              >
                <span className="w-[7px] h-[7px] rounded-full shrink-0" style={{ background: color }} aria-hidden="true" />
                <span className="flex-1 truncate">{agentTitle(u.agentId) ?? u.agentId}</span>
                <span className="text-[11.5px] text-ink-3">{u.op}</span>
              </a>
            );
          })
        )}
      </section>

      <section aria-labelledby="art-history" className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <h3 id="art-history" className="m-0 text-[11px] font-semibold tracking-[0.08em] uppercase text-ink-3">
            History
          </h3>
          {versions.length > 1 && (
            <button
              type="button"
              onClick={() => onOpen({ mode: 'compare', compare: { from: viewing?.version ?? meta.version - 1, to: meta.version } })}
              className="bg-transparent border-0 p-0 text-[12px] text-link hover:text-link-hover"
            >
              Compare versions
            </button>
          )}
        </div>
        <ul className="m-0 p-0 list-none flex flex-col gap-1">
          {versions.map((v) => {
            const current = v.version === meta.version;
            const on = viewing ? viewing.version === v.version : current;
            return (
              <li key={v.version}>
                <button
                  type="button"
                  onClick={() => void viewVersion(v)}
                  aria-current={on ? 'true' : undefined}
                  title={current ? 'Current version' : `View v${v.version}`}
                  className={cn('w-full text-left bg-transparent border-0 px-0 py-0.5 text-[12.5px] hover:text-ink', on ? 'text-ink font-medium' : 'text-ink-2')}
                >
                  {versionLabel(v, agentTitle)}
                </button>
              </li>
            );
          })}
        </ul>
      </section>
    </ResizableAside>
  );
}
