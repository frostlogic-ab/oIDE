/**
 * Extension marketplace (docs/wiki/raw/design/Marketplace.dc.html): categories, search and sort,
 * the extension list (index entries, installed extensions and custom MCP servers), a detail pane
 * with the tools each gives agents and their risk, install with consent, enable per project,
 * updates (re-consent when tools or capabilities grow), and Add custom. See screen-marketplace.md.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { MARKETPLACE_CATEGORIES, type CustomServer, type ExtensionUpdate, type InstalledExtension, type MarketplaceEntry } from '@oide/protocol';
import { Badge, Button, Dialog, EmptyState, Icon, Spinner, cn } from '@oide/ui';
import { invokeOr, ipcErrorMessage, oide } from '../../lib/bridge';
import { useProjects } from '../../stores/projects';
import { useRouter } from '../../stores/router';
import { toast } from '../../stores/ui';
import { AddCustomDialog, Capabilities, type AddCustomTab } from './AddCustomDialog';
import { CheckButton, Monogram, RiskPill } from './parts';
import { RISK_COLOR, RISK_LABEL, YOURS, buildItems, categoryLabel, customSource, enabledIn, filterItems, inCategory, isCustomLike, type CategoryId, type ListItem, type SortId } from './model';

interface Data {
  index: MarketplaceEntry[];
  installed: InstalledExtension[];
  custom: CustomServer[];
  updates: ExtensionUpdate[];
  loaded: boolean;
  error?: string;
}

function useMarketplaceData() {
  const [data, setData] = useState<Data>({ index: [], installed: [], custom: [], updates: [], loaded: false });
  const reload = useCallback(async (refresh = false) => {
    try {
      const [index, installed, custom, updates] = await Promise.all([
        invokeOr('extensions.index', { refresh }, []),
        invokeOr('extensions.installed', undefined, []),
        invokeOr('custom.list', undefined, []),
        invokeOr('extensions.updates', undefined, []),
      ]);
      setData({ index, installed, custom, updates, loaded: true });
    } catch (err) {
      setData((d) => ({ ...d, loaded: true, error: ipcErrorMessage(err) }));
    }
  }, []);
  useEffect(() => {
    void reload();
    const off = oide.on('extensions.changed', (installed) => {
      setData((d) => ({ ...d, installed }));
      void invokeOr('extensions.updates', undefined, []).then((updates) => setData((d) => ({ ...d, updates })));
    });
    return off;
  }, [reload]);
  return { data, setData, reload };
}

const STATE_TEXT: Record<ListItem['state'], { label: string; cls: string }> = {
  install: { label: 'Install', cls: 'text-link' },
  installed: { label: 'Installed', cls: 'text-ok' },
  builtin: { label: 'Built in', cls: 'text-ink-3' },
  update: { label: 'Update', cls: 'text-link' },
};

type Consent =
  | { kind: 'install'; item: ListItem }
  | { kind: 'update'; item: ListItem; update: ExtensionUpdate };

export default function MarketplaceScreen() {
  const { data, setData, reload } = useMarketplaceData();
  const projects = useProjects((s) => s.list);
  const routeExt = useRouter((s) => (s.route.screen === 'marketplace' ? s.route.params.extension : undefined));
  const replace = useRouter((s) => s.replace);

  const [cat, setCat] = useState<CategoryId>('agent-tools');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortId>('installs');
  const [dialog, setDialog] = useState<{ tab?: AddCustomTab; editing?: CustomServer } | null>(null);
  const [consent, setConsent] = useState<Consent | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<ListItem | null>(null);
  const [busy, setBusy] = useState(false);

  const items = useMemo(() => buildItems(data.index, data.installed, data.custom, data.updates), [data]);
  const visible = useMemo(() => filterItems(items, cat, query, sort), [items, cat, query, sort]);
  const counts = useMemo(
    () => ({ installed: items.filter((i) => inCategory(i, 'installed')).length, custom: items.filter(isCustomLike).length, updates: data.updates.length }),
    [items, data.updates],
  );

  const selected = useMemo(() => {
    const byRoute = routeExt ? items.find((i) => i.key === routeExt || i.name === routeExt) : undefined;
    return byRoute ?? visible[0] ?? null;
  }, [items, visible, routeExt]);

  const select = (item: ListItem) => replace('marketplace', { extension: item.key });

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    try {
      await fn();
      if (ok) toast(ok, 'success');
    } catch (err) {
      toast(ipcErrorMessage(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  const install = (item: ListItem) =>
    run(async () => {
      const rec = await oide.invoke('extensions.install', { name: item.name });
      setData((d) => ({ ...d, installed: [...d.installed.filter((e) => e.name !== rec.name), rec] }));
      setConsent(null);
      await reload();
    }, `Installed ${item.displayName}. It is on for all projects; turn it off per project below.`);

  const doUpdate = (item: ListItem, update: ExtensionUpdate, consentGiven: boolean) =>
    run(async () => {
      await oide.invoke('extensions.update', { id: update.id, consent: consentGiven });
      setConsent(null);
      await reload();
    }, `Updated ${item.displayName} to ${update.to}.`);

  const startUpdate = (item: ListItem) => {
    if (!item.update) return;
    if (item.update.needsConsent) setConsent({ kind: 'update', item, update: item.update });
    else void doUpdate(item, item.update, false);
  };

  const remove = (item: ListItem) =>
    run(async () => {
      if (item.custom) await oide.invoke('custom.remove', { id: item.custom.id });
      else if (item.installed) await oide.invoke('extensions.uninstall', { id: item.installed.id });
      setConfirmRemove(null);
      await reload();
    }, `Removed ${item.displayName}.`);

  const saveCustom = (server: CustomServer) =>
    run(async () => {
      const saved = await oide.invoke('custom.save', { server, secrets: {} });
      setData((d) => ({ ...d, custom: d.custom.map((c) => (c.id === saved.id ? saved : c)) }));
    });

  const setEnabled = (ext: InstalledExtension, projectId: string | undefined, enabled: boolean) =>
    run(async () => {
      const rec = await oide.invoke('extensions.setEnabled', { id: ext.id, projectId, enabled });
      setData((d) => ({ ...d, installed: d.installed.map((e) => (e.id === rec.id ? rec : e)) }));
    });

  return (
    <div className="flex-1 min-w-0 flex min-h-0">
      {/* Categories */}
      <aside aria-label="Categories" className="w-[220px] shrink-0 flex flex-col gap-0.5 px-2.5 py-3.5 bg-panel border-r border-line box-border overflow-auto">
        <h2 className="m-0 px-2.5 pb-1.5 text-[11px] font-semibold tracking-[0.08em] uppercase text-ink-3">Browse</h2>
        <nav aria-label="Browse categories" className="flex flex-col gap-0.5">
          {MARKETPLACE_CATEGORIES.map((c) => (
            <CategoryButton key={c.id} current={cat === c.id} onClick={() => setCat(c.id)} label={c.label} meta={c.id === 'agent-tools' ? 'MCP' : undefined} />
          ))}
        </nav>
        <h2 className="m-0 px-2.5 pt-4 pb-1.5 text-[11px] font-semibold tracking-[0.08em] uppercase text-ink-3">Yours</h2>
        <nav aria-label="Your extensions" className="flex flex-col gap-0.5">
          {YOURS.map((c) => (
            <CategoryButton key={c.id} current={cat === c.id} onClick={() => setCat(c.id)} label={c.label} meta={String(counts[c.id as 'installed' | 'custom' | 'updates'])} />
          ))}
        </nav>
        <button
          type="button"
          onClick={() => setDialog({})}
          className="mt-2 h-8 rounded-md border border-dashed border-line-hover bg-transparent text-ink text-[12.5px] hover:bg-raised"
        >
          + Add custom
        </button>
        <div className="flex-1" />
        <p className="m-0 mt-4 p-2.5 rounded-lg border border-line-2 text-[12px] text-ink-3 leading-[1.5]">
          Extensions are open source and declare exactly which tools they hand to agents.
        </p>
      </aside>

      {/* List */}
      <main className="flex-[999_1_460px] min-w-0 flex flex-col gap-3.5 px-5 py-[18px] box-border overflow-auto">
        <div className="flex items-center gap-2.5 flex-wrap">
          <label htmlFor="msearch" className="sr-only">
            Search extensions
          </label>
          <div className="flex-1 min-w-[240px] flex items-center gap-2 h-9 px-3 rounded-lg border border-line-3 bg-card text-ink-3 focus-within:border-accent">
            <Icon name="search" />
            <input
              id="msearch"
              type="search"
              placeholder="Search agent tools, views, themes"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="flex-1 min-w-0 border-0 outline-none bg-transparent text-ink text-[13px] placeholder:text-ink-4"
            />
          </div>
          <label htmlFor="msort" className="text-[12px] text-ink-3">
            Sort
          </label>
          <select
            id="msort"
            value={sort}
            onChange={(e) => setSort(e.target.value as SortId)}
            className="h-9 px-2 rounded-md border border-line-3 bg-card text-ink text-[12.5px] outline-none focus:border-accent"
          >
            <option value="installs">Most installed</option>
            <option value="updated">Recently updated</option>
            <option value="name">Name</option>
          </select>
          <Button size={36} variant="primary" onClick={() => setDialog({})}>
            + Add custom
          </Button>
        </div>
        <h1 className="m-0 text-[16px] font-semibold">{categoryLabel(cat)}</h1>
        {!data.loaded ? (
          <Spinner label="Loading extensions" />
        ) : data.error ? (
          <div role="alert" className="text-bad text-[12.5px]">
            Could not load the marketplace: {data.error}{' '}
            <Button size={28} onClick={() => void reload(true)}>
              Try again
            </Button>
          </div>
        ) : visible.length === 0 ? (
          <EmptyState
            icon="marketplace"
            title={query ? 'Nothing matches your search' : cat === 'updates' ? 'Everything is up to date' : 'Nothing here yet'}
            description={cat === 'custom' ? 'Add any MCP server or local extension with Add custom.' : undefined}
          />
        ) : (
          <ul className="m-0 p-0 list-none flex flex-col gap-2" aria-label={`${categoryLabel(cat)} extensions`}>
            {visible.map((item) => {
              const sel = selected?.key === item.key;
              const st = STATE_TEXT[item.state];
              return (
                <li key={item.key}>
                  <button
                    type="button"
                    aria-current={sel ? 'true' : undefined}
                    onClick={() => select(item)}
                    className={cn(
                      'w-full flex items-center gap-3 p-3 rounded-xl border bg-card text-left text-ink hover:border-line-hover',
                      sel ? 'border-accent hover:border-accent' : 'border-line-2',
                    )}
                  >
                    <Monogram name={item.displayName} />
                    <span className="flex-1 min-w-0 flex flex-col gap-[3px]">
                      <span className="font-semibold flex items-center gap-1.5 flex-wrap">
                        {item.displayName} <span className="font-normal text-ink-3 text-[12px]">· {item.kind === 'custom' ? 'You' : item.publisher}</span>
                        {isCustomLike(item) && (
                          <span className="text-[10.5px] font-medium px-[7px] py-px rounded-[9px] border border-violet-bg text-violet">Custom</span>
                        )}
                      </span>
                      <span className="text-[12.5px] text-ink-2">{item.description}</span>
                    </span>
                    <span className={cn('text-[12px] whitespace-nowrap', st.cls)}>{item.state === 'update' && item.update ? `Update to ${item.update.to}` : st.label}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </main>

      {/* Detail */}
      <aside aria-label="Extension details" className="flex-[1_1_320px] max-w-[380px] min-w-[300px] flex flex-col gap-4 px-4 py-[18px] bg-panel border-l border-line box-border overflow-auto">
        {selected ? (
          <Detail
            item={selected}
            busy={busy}
            projects={projects}
            onInstall={() => setConsent({ kind: 'install', item: selected })}
            onUpdate={() => startUpdate(selected)}
            onRemove={() => setConfirmRemove(selected)}
            onEdit={() => selected.custom && setDialog({ editing: selected.custom })}
            onSaveCustom={saveCustom}
            onSetEnabled={setEnabled}
          />
        ) : (
          <span className="text-ink-3 text-[12.5px]">Pick an extension to see the tools it gives agents.</span>
        )}
      </aside>

      {dialog && (
        <AddCustomDialog
          projects={projects}
          editing={dialog.editing}
          initialTab={dialog.tab}
          onClose={() => setDialog(null)}
          onSaved={({ servers, extension }) => {
            void reload();
            if (servers?.[0]) replace('marketplace', { extension: `c:${servers[0].id}` });
            else if (extension) replace('marketplace', { extension: data.index.some((e) => e.name === extension.name) ? `e:${extension.name}` : `x:${extension.id}` });
          }}
        />
      )}

      {consent && <ConsentDialog consent={consent} busy={busy} onClose={() => setConsent(null)} onConfirm={() => void (consent.kind === 'install' ? install(consent.item) : doUpdate(consent.item, consent.update, true))} />}

      <Dialog
        open={Boolean(confirmRemove)}
        onClose={() => setConfirmRemove(null)}
        title={confirmRemove?.custom ? `Remove ${confirmRemove.displayName}?` : `Uninstall ${confirmRemove?.displayName ?? ''}?`}
        description={
          confirmRemove?.custom
            ? confirmRemove.custom.savedTo === 'project-mcp-json'
              ? "New agents lose its tools. oIDE also removes its entry from the projects' .mcp.json and deletes its stored secrets."
              : 'New agents lose its tools. oIDE deletes its stored secrets and sign-in.'
            : 'New agents lose its tools. Running agents keep them until they end.'
        }
        footer={
          <>
            <Button size={32} onClick={() => setConfirmRemove(null)}>
              Cancel
            </Button>
            <Button size={32} variant="danger" disabled={busy} onClick={() => confirmRemove && void remove(confirmRemove)}>
              {confirmRemove?.custom ? 'Remove' : 'Uninstall'}
            </Button>
          </>
        }
      />
    </div>
  );
}

function CategoryButton({ current, onClick, label, meta }: { current: boolean; onClick: () => void; label: string; meta?: string }) {
  return (
    <button
      type="button"
      aria-current={current ? 'page' : undefined}
      onClick={onClick}
      className={cn(
        'flex justify-between items-center px-2.5 py-[7px] rounded-[7px] border-0 text-left text-[12.5px]',
        current ? 'bg-selected text-ink' : 'bg-transparent text-ink-2 hover:bg-raised',
      )}
    >
      <span>{label}</span>
      {meta && <span className="text-ink-3">{meta}</span>}
    </button>
  );
}

interface DetailProps {
  item: ListItem;
  busy: boolean;
  projects: Array<{ id: string; name: string }>;
  onInstall(): void;
  onUpdate(): void;
  onRemove(): void;
  onEdit(): void;
  onSaveCustom(server: CustomServer): void;
  onSetEnabled(ext: InstalledExtension, projectId: string | undefined, enabled: boolean): void;
}

function Detail({ item, busy, projects, onInstall, onUpdate, onRemove, onEdit, onSaveCustom, onSetEnabled }: DetailProps) {
  const custom = item.custom;
  const ext = item.installed;
  const authorLine = custom
    ? 'Added by you · custom'
    : item.state === 'builtin'
      ? `${item.publisher} · built in`
      : ext?.source === 'folder'
        ? `Loaded from a folder${ext.devMode ? ' · developer mode' : ''}`
        : ext?.source === 'git'
          ? 'Installed from git'
          : `${item.publisher} · open source`;

  const mainButton = (() => {
    if (item.state === 'builtin') return <Button size={36} disabled className="w-full">Built in</Button>;
    if (custom) return <Button size={36} className="w-full" onClick={onRemove} disabled={busy}>Remove</Button>;
    if (ext) return <Button size={36} className="w-full" onClick={onRemove} disabled={busy}>Uninstall</Button>;
    return <Button size={36} variant="primary" className="w-full" onClick={onInstall} disabled={busy}>Install</Button>;
  })();

  return (
    <>
      <div className="flex gap-3 items-center">
        <Monogram name={item.displayName} size={52} />
        <div className="flex flex-col gap-[3px] min-w-0">
          <h2 className="m-0 text-[16px] font-semibold">{item.displayName}</h2>
          <span className="text-[12px] text-ink-3 flex items-center gap-1.5 flex-wrap">
            {authorLine}
            {!item.reviewed && <Badge tone="warn">not reviewed</Badge>}
          </span>
        </div>
      </div>
      {item.description && <p className="m-0 leading-[1.5] text-ink-2">{item.description}</p>}
      {item.update && (
        <div className="flex flex-col gap-2 p-2.5 rounded-lg border border-review-line bg-review-bg">
          <span className="text-[12.5px] text-ink-2">
            Version {item.update.to} is available (you have {item.update.from}).
            {item.update.needsConsent ? ' It adds tools or capabilities, so oIDE asks again.' : ''}
          </span>
          <Button size={32} variant="review" onClick={onUpdate} disabled={busy}>
            Update to {item.update.to}
          </Button>
        </div>
      )}
      {mainButton}

      <section aria-labelledby="mk-tools" className="flex flex-col gap-2">
        <h3 id="mk-tools" className="m-0 text-[11px] font-semibold tracking-[0.08em] uppercase text-ink-3">
          Tools it gives agents
        </h3>
        {item.tools.length === 0 && <span className="text-[12px] text-ink-3">No agent tools. It adds UI or settings only.</span>}
        <ul className="m-0 p-0 list-none flex flex-col gap-2">
          {item.tools.map((t, i) => (
            <li key={`${t.server ?? ''}:${t.name}`} className="flex items-center justify-between gap-2 px-2.5 py-[7px] rounded-[7px] bg-card border border-line-2 font-mono text-[12px]">
              {custom ? (
                <CheckButton
                  checked={t.enabled !== false}
                  label={`Allow ${t.name}`}
                  onChange={(v) => onSaveCustom({ ...custom, tools: custom.tools.map((x, j) => (j === i ? { ...x, enabled: v } : x)) })}
                />
              ) : ext && item.state !== 'install' ? (
                <CheckButton
                  checked={t.enabled !== false}
                  label={`Allow ${t.name}`}
                  onChange={(v) =>
                    void oide
                      .invoke('extensions.setToolEnabled', { id: ext.id, tool: t.name, server: t.server, enabled: v })
                      .catch((err) => toast(`Couldn't change ${t.name}: ${ipcErrorMessage(err)}`, 'error'))
                  }
                />
              ) : null}
              <span className={cn('flex-1 min-w-0 truncate', t.enabled === false ? 'text-ink-4' : 'text-ink')} title={t.description}>
                {t.name}
              </span>
              <span className="font-sans whitespace-nowrap" style={{ color: RISK_COLOR[t.risk] }}>
                {RISK_LABEL[t.risk]}
              </span>
            </li>
          ))}
        </ul>
      </section>

      {(ext || custom) && projects.length > 0 && (
        <fieldset className="m-0 p-0 border-0 flex flex-col gap-2">
          <legend className="p-0 mb-2 text-[11px] font-semibold tracking-[0.08em] uppercase text-ink-3">Enabled for</legend>
          {ext && item.state !== 'builtin' ? (
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" className="accent-accent" checked={ext.enabledGlobally} onChange={(e) => onSetEnabled(ext, undefined, e.target.checked)} />
              All projects
            </label>
          ) : null}
          {custom ? (
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" className="accent-accent" checked={custom.allProjects} onChange={(e) => onSaveCustom({ ...custom, allProjects: e.target.checked })} />
              All projects
            </label>
          ) : null}
          {projects.map((p) => {
            const on = ext ? enabledIn(ext, p.id) : custom ? custom.allProjects || custom.projects.includes(p.id) : false;
            return (
              <label key={p.id} className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  className="accent-accent"
                  checked={on}
                  onChange={(e) => {
                    if (ext) onSetEnabled(ext, p.id, e.target.checked);
                    else if (custom) {
                      const base = custom.allProjects ? projects.map((x) => x.id) : custom.projects;
                      const next = e.target.checked ? [...new Set([...base, p.id])] : base.filter((x) => x !== p.id);
                      onSaveCustom({ ...custom, allProjects: false, projects: next });
                    }
                  }}
                />
                {p.name}
              </label>
            );
          })}
        </fieldset>
      )}

      {item.capabilities && <Capabilities caps={item.capabilities} />}

      {custom && (
        <div className="flex flex-col gap-1.5 p-2.5 rounded-lg border border-line-2 text-[12px] text-ink-2 leading-[1.5]">
          <span className="font-mono text-[11px] text-ink-3 break-all">{customSource(custom)}</span>
          <span>Added by you, not from the marketplace. oIDE passes it to each agent's Claude Code session as an MCP server.</span>
          <span className="text-ink-3">Saved in {custom.savedTo === 'my-settings' ? 'My settings (all my projects)' : 'Project .mcp.json (shared through git)'}.</span>
          <div className="flex gap-1.5 flex-wrap">
            <Button size={28} onClick={onEdit}>
              Edit
            </Button>
            <Button
              size={28}
              onClick={() => void oide.invoke('shell.openExternal', { url: 'https://github.com/oide-dev/oide-marketplace' }).catch((err) => toast(ipcErrorMessage(err), 'error'))}
            >
              Publish to marketplace
            </Button>
          </div>
        </div>
      )}

      <p className="m-0 text-[12px] text-ink-3 leading-[1.5]">Tools marked "asks first" always show a permission prompt on the agent's tile.</p>
    </>
  );
}

function ConsentDialog({ consent, busy, onClose, onConfirm }: { consent: Consent; busy: boolean; onClose(): void; onConfirm(): void }) {
  const { item } = consent;
  const isUpdate = consent.kind === 'update';
  return (
    <Dialog
      open
      onClose={onClose}
      width={520}
      title={isUpdate ? `Update ${item.displayName} to ${consent.update.to}?` : `Install ${item.displayName}?`}
      description={isUpdate ? 'This update gives agents more than before. Check what is new.' : `${item.publisher} · ${item.entry?.versions[0]?.version ? `v${item.entry.versions[0].version}` : ''}`}
      footer={
        <>
          <Button size={32} onClick={onClose}>
            Cancel
          </Button>
          <Button size={32} variant="primary" onClick={onConfirm} disabled={busy}>
            {isUpdate ? 'Update' : 'Install'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3.5">
        {isUpdate ? (
          <>
            {consent.update.addedTools.length > 0 && (
              <section className="flex flex-col gap-1.5">
                <h3 className="m-0 text-[11px] font-semibold tracking-[0.08em] uppercase text-ink-3">New tools</h3>
                <ul className="m-0 pl-4 list-disc font-mono text-[12px] flex flex-col gap-0.5">
                  {consent.update.addedTools.map((t) => (
                    <li key={t}>{t}</li>
                  ))}
                </ul>
              </section>
            )}
            {consent.update.addedCapabilities.length > 0 && (
              <section className="flex flex-col gap-1.5">
                <h3 className="m-0 text-[11px] font-semibold tracking-[0.08em] uppercase text-ink-3">New capabilities</h3>
                <ul className="m-0 pl-4 list-disc text-[12.5px] flex flex-col gap-0.5">
                  {consent.update.addedCapabilities.map((c) => (
                    <li key={c}>{c}</li>
                  ))}
                </ul>
              </section>
            )}
          </>
        ) : (
          <>
            <section className="flex flex-col gap-1.5">
              <h3 className="m-0 text-[11px] font-semibold tracking-[0.08em] uppercase text-ink-3">Tools it gives agents</h3>
              {item.tools.length === 0 && <span className="text-[12px] text-ink-3">None.</span>}
              <ul className="m-0 p-0 list-none flex flex-col gap-1.5">
                {item.tools.map((t) => (
                  <li key={t.name} className="flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-md bg-panel border border-line">
                    <span className="font-mono text-[12px]">{t.name}</span>
                    {t.description && <span className="flex-1 text-[11.5px] text-ink-3 truncate">{t.description}</span>}
                    <RiskPill risk={t.risk} toolName={t.name} />
                  </li>
                ))}
              </ul>
            </section>
            {item.capabilities && <Capabilities caps={item.capabilities} />}
            {!item.reviewed && (
              <p className="m-0 text-[12px] text-warn">This extension is not verified by the marketplace. Only install it if you trust the publisher.</p>
            )}
          </>
        )}
        <p className="m-0 text-[12px] text-ink-3 leading-[1.5]">
          Read-only tools run without asking. Tools marked "asks first" always show a permission prompt on the agent's tile. No install scripts run.
        </p>
      </div>
    </Dialog>
  );
}
