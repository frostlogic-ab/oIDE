/**
 * Add a custom tool (Marketplace.dc.html dialog). Four routes, all ending in one CustomServer
 * record (or an extension for the folder/git route): From a URL, Found on this computer, Local
 * command or JSON, Extension from folder or git. Every route shows the tools with editable risk
 * labels, on/off per tool, where it is saved and which projects it is on for, plus the
 * "not reviewed" warning. Secrets (env values, header tokens) go to main once and are cleared
 * from state right after saving; they are never rendered back.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { CommandOutput, CustomServer, InstalledExtension, Project } from '@oide/protocol';
import { Badge, Button, Icon, Spinner, cn } from '@oide/ui';
import { ipcErrorMessage, oide } from '../../lib/bridge';
import { toast } from '../../stores/ui';
import { CheckButton, ModalShell, SaveFields, ToolRows, inputClass, type EditableTool, type SavedTo } from './parts';
import { parsePastedJson, riskFromHints, sanitizeServerName, splitCommandLine } from './model';

export type AddCustomTab = 'url' | 'found' | 'cmd' | 'ext';

type ProbeUrl = CommandOutput<'custom.probeUrl'>;
type ScanItem = CommandOutput<'custom.scanImports'>[number];
type HintedTool = { name: string; description?: string; readOnlyHint?: boolean; destructiveHint?: boolean };

const toEditable = (tools: HintedTool[]): EditableTool[] => tools.map((t) => ({ name: t.name, description: t.description, risk: riskFromHints(t), enabled: true }));
const toCustomTools = (tools: EditableTool[]) => tools.map((t) => ({ name: t.name, description: t.description, risk: t.risk, enabled: t.enabled }));
const newServerId = () => `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const scanKey = (s: { file: string; name: string }) => `${s.file}\u0000${s.name}`;

export interface AddCustomDialogProps {
  onClose: () => void;
  projects: Project[];
  /** Called after something was saved (custom server(s) or an extension), to refresh the list. */
  onSaved: (what: { servers?: CustomServer[]; extension?: InstalledExtension }) => void;
  /** Edit an existing custom server instead of adding one. */
  editing?: CustomServer;
  initialTab?: AddCustomTab;
}

export function AddCustomDialog({ onClose, projects, onSaved, editing, initialTab = 'url' }: AddCustomDialogProps) {
  const [tab, setTab] = useState<AddCustomTab>(initialTab);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Shared "save" fields (per route they start fresh when the tab changes).
  const allIds = useMemo(() => projects.map((p) => p.id), [projects]);
  const [savedTo, setSavedTo] = useState<SavedTo>(editing?.savedTo ?? 'my-settings');
  const [selected, setSelected] = useState<string[]>(editing ? (editing.allProjects ? allIds : editing.projects) : allIds);
  const [name, setName] = useState(editing?.name ?? '');

  /* ---- URL route */
  const serverId = useRef(editing?.id ?? newServerId());
  const [url, setUrl] = useState('');
  const [probing, setProbing] = useState(false);
  const [probe, setProbe] = useState<ProbeUrl | null>(null);
  const [urlTools, setUrlTools] = useState<EditableTool[]>([]);
  const [auth, setAuth] = useState<'idle' | 'signing' | 'signed' | 'failed'>('idle');
  const [draftSaved, setDraftSaved] = useState(false);
  const [useToken, setUseToken] = useState(false);
  const [tokenHeader, setTokenHeader] = useState('Authorization');
  const [token, setToken] = useState('');

  /* ---- Found route */
  const [scan, setScan] = useState<ScanItem[] | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [imported, setImported] = useState<CustomServer[] | null>(null);

  /* ---- Command route */
  const [cmdMode, setCmdMode] = useState<'form' | 'json'>('form');
  const [cmdLine, setCmdLine] = useState('');
  const [env, setEnv] = useState<Array<{ key: string; value: string }>>([{ key: '', value: '' }]);
  const [json, setJson] = useState('');
  const [cmdProbe, setCmdProbe] = useState<Record<string, { tools: EditableTool[]; error?: string }> | null>(null);

  /* ---- Extension route */
  const [devMode, setDevMode] = useState(true);
  const [gitUrl, setGitUrl] = useState('');
  const [ext, setExt] = useState<InstalledExtension | null>(null);

  /* ---- Edit mode */
  const [editTools, setEditTools] = useState<EditableTool[]>(editing ? editing.tools.map((t) => ({ ...t })) : []);

  const finished = useRef(false);
  const urlId = useId();
  const gitId = useId();
  const cmdId = useId();
  const jsonId = useId();

  // Scan other apps' MCP settings once, so the tab can show its count.
  useEffect(() => {
    if (editing) return;
    let live = true;
    oide
      .invoke('custom.scanImports', undefined)
      .then((r) => live && setScan(r))
      .catch((err) => live && (setScan([]), setScanError(ipcErrorMessage(err))));
    return () => {
      live = false;
    };
  }, [editing]);

  const pickTab = (t: AddCustomTab) => {
    setTab(t);
    setError(null);
    setName('');
    setSelected(allIds);
    setSavedTo('my-settings');
  };

  const close = () => {
    if (!finished.current) {
      // Clean up what this dialog created but the user did not finish.
      if (draftSaved) void oide.invoke('custom.remove', { id: serverId.current }).catch(() => {});
      if (ext) void oide.invoke('extensions.uninstall', { id: ext.id }).catch(() => {});
    }
    setToken('');
    setEnv([]);
    onClose();
  };

  const placement = () => ({
    savedTo,
    projects: selected,
    allProjects: savedTo === 'my-settings' && projects.length > 0 && selected.length === projects.length,
  });

  const nameError = (n: string) => (!sanitizeServerName(n) ? 'Enter a name (letters, numbers, - and _).' : undefined);

  /* ------------------------------------------------------------------ URL */

  const connect = async () => {
    setError(null);
    let parsed: URL;
    try {
      parsed = new URL(url.trim());
    } catch {
      setError('Enter a full URL, for example https://mcp.example.com/mcp');
      return;
    }
    setProbing(true);
    setAuth('idle');
    try {
      const r = await oide.invoke('custom.probeUrl', { url: parsed.toString() });
      setProbe(r);
      setUrlTools(toEditable(r.tools));
      if (r.reached && !name) setName(r.serverName ?? parsed.hostname);
    } catch (err) {
      setProbe({ reached: false, needsAuth: false, tools: [], error: ipcErrorMessage(err) });
    } finally {
      setProbing(false);
    }
  };

  const urlServer = (authKind: 'none' | 'oauth' | 'header'): CustomServer => ({
    id: serverId.current,
    name: sanitizeServerName(name || probe?.serverName || 'server'),
    route: 'url',
    transport: { kind: 'http', url: url.trim(), auth: authKind },
    tools: toCustomTools(urlTools),
    ...placement(),
    reviewed: false,
    serverInfo: probe?.serverInfo ?? (probe?.serverName ? `${probe.serverName}${probe.serverVersion ? ` v${probe.serverVersion}` : ''}` : undefined),
  });

  const signIn = async () => {
    setAuth('signing');
    setError(null);
    try {
      await oide.invoke('custom.save', { server: urlServer('oauth'), secrets: {} });
      setDraftSaved(true);
      const r = await oide.invoke('custom.authorize', { id: serverId.current });
      setAuth(r.ok ? 'signed' : 'failed');
      if (!r.ok) setError(r.error ?? 'Sign-in did not finish.');
    } catch (err) {
      setAuth('failed');
      setError(ipcErrorMessage(err));
    }
  };

  const addUrl = async () => {
    const authKind = auth === 'signed' ? 'oauth' : useToken && token ? 'header' : probe?.needsAuth ? 'oauth' : 'none';
    const server = urlServer(authKind);
    const saved = await oide.invoke('custom.save', { server, secrets: {} });
    if (authKind === 'header') await oide.invoke('custom.setHeaderToken', { id: saved.id, header: tokenHeader || 'Authorization', token });
    setToken('');
    finished.current = true;
    onSaved({ servers: [saved] });
    toast(`Added ${saved.name}. New agents get its tools.`, 'success');
  };

  /* ---------------------------------------------------------------- Found */

  const doImport = async () => {
    const items = (scan ?? []).filter((s) => picked.includes(scanKey(s))).map((s) => ({ file: s.file, name: s.name }));
    const servers = await oide.invoke('custom.importSelected', { items, ...placement() });
    setImported(servers);
    setPicked([]);
  };

  const finishImport = async () => {
    const saved = await Promise.all((imported ?? []).map((server) => oide.invoke('custom.save', { server, secrets: {} })));
    finished.current = true;
    onSaved({ servers: saved });
    toast(`Imported ${saved.length} ${saved.length === 1 ? 'server' : 'servers'}.`, 'success');
  };

  /* -------------------------------------------------------------- Command */

  const pasted = useMemo(() => (cmdMode === 'json' ? parsePastedJson(json) : null), [cmdMode, json]);

  const cmdServers = (): Array<{ name: string; command: string; args: string[]; env: Record<string, string> }> => {
    if (cmdMode === 'json') return pasted?.servers ?? [];
    const [command = '', ...args] = splitCommandLine(cmdLine);
    const envMap: Record<string, string> = {};
    for (const row of env) if (row.key.trim()) envMap[row.key.trim()] = row.value;
    return command ? [{ name: name || command.split(/[\\/]/).pop() || 'server', command, args, env: envMap }] : [];
  };

  const testCommand = async () => {
    setError(null);
    const list = cmdServers();
    if (!list.length) {
      setError(cmdMode === 'json' ? (pasted?.error ?? 'Paste an mcpServers JSON first.') : 'Enter the command that starts the server.');
      return;
    }
    setBusy(true);
    try {
      const out: Record<string, { tools: EditableTool[]; error?: string }> = {};
      for (const s of list) {
        try {
          const r = await oide.invoke('custom.probeCommand', { command: s.command, args: s.args, env: s.env });
          out[s.name] = { tools: toEditable(r.tools), error: r.started ? undefined : (r.error ?? 'It did not start.') };
        } catch (err) {
          out[s.name] = { tools: [], error: ipcErrorMessage(err) };
        }
      }
      setCmdProbe(out);
    } finally {
      setBusy(false);
    }
  };

  const addCommand = async () => {
    const list = cmdServers();
    if (!list.length) throw new Error(cmdMode === 'json' ? (pasted?.error ?? 'Paste an mcpServers JSON first.') : 'Enter the command that starts the server.');
    const saved: CustomServer[] = [];
    for (const s of list) {
      const server: CustomServer = {
        id: newServerId(),
        name: sanitizeServerName(cmdMode === 'form' ? name || s.name : s.name),
        route: 'command',
        transport: { kind: 'stdio', command: s.command, args: s.args, envKeys: Object.keys(s.env) },
        tools: toCustomTools(cmdProbe?.[s.name]?.tools ?? []),
        ...placement(),
        reviewed: false,
      };
      saved.push(await oide.invoke('custom.save', { server, secrets: s.env }));
    }
    // Secrets went to main (keychain); drop them from the form.
    setEnv([{ key: '', value: '' }]);
    setJson('');
    finished.current = true;
    onSaved({ servers: saved });
    toast(`Added ${saved.map((s) => s.name).join(', ')}.`, 'success');
  };

  /* ------------------------------------------------------------ Extension */

  const loadFolder = async () => {
    setError(null);
    setBusy(true);
    try {
      const rec = await oide.invoke('extensions.addFromFolder', { devMode });
      if (rec) {
        if (ext) await oide.invoke('extensions.uninstall', { id: ext.id }).catch(() => {});
        setExt(rec);
      }
    } catch (err) {
      setError(ipcErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const loadGit = async () => {
    setError(null);
    try {
      new URL(gitUrl.trim());
    } catch {
      setError('Enter the repository URL, for example https://github.com/you/your-extension');
      return;
    }
    setBusy(true);
    try {
      const rec = await oide.invoke('extensions.addFromGit', { url: gitUrl.trim() });
      if (ext) await oide.invoke('extensions.uninstall', { id: ext.id }).catch(() => {});
      setExt(rec);
    } catch (err) {
      setError(ipcErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const installExt = async () => {
    if (!ext) throw new Error('Choose a folder or a git repository first.');
    let rec = ext;
    if (projects.length > 0 && selected.length === projects.length) rec = await oide.invoke('extensions.setEnabled', { id: ext.id, enabled: true });
    else for (const p of selected) rec = await oide.invoke('extensions.setEnabled', { id: ext.id, projectId: p, enabled: true });
    finished.current = true;
    onSaved({ extension: rec });
    toast(`Installed ${rec.displayName}.`, 'success');
  };

  /* ----------------------------------------------------------------- Edit */

  const saveEdit = async () => {
    if (!editing) return;
    const server: CustomServer = { ...editing, name: sanitizeServerName(name) || editing.name, tools: toCustomTools(editTools), ...placement() };
    const saved = await oide.invoke('custom.save', { server, secrets: {} });
    finished.current = true;
    onSaved({ servers: [saved] });
    toast(`Saved ${saved.name}.`, 'success');
  };

  /* --------------------------------------------------------------- footer */

  const urlNameErr = probe?.reached ? nameError(name) : undefined;
  const cmdNameErr = tab === 'cmd' && cmdMode === 'form' && cmdLine.trim() ? nameError(name || splitCommandLine(cmdLine)[0] || '') : undefined;
  const nImport = picked.length;

  const primary: { label: string; disabled: boolean; run: () => Promise<void> } = editing
    ? { label: 'Save', disabled: Boolean(nameError(name)), run: saveEdit }
    : tab === 'url'
      ? { label: 'Add tool', disabled: !probe?.reached || Boolean(urlNameErr) || auth === 'signing', run: addUrl }
      : tab === 'found'
        ? imported
          ? { label: 'Done', disabled: false, run: finishImport }
          : { label: `Import ${nImport}`, disabled: nImport === 0, run: doImport }
        : tab === 'cmd'
          ? { label: 'Add tool', disabled: cmdServers().length === 0 || Boolean(cmdNameErr) || Boolean(pasted?.error), run: addCommand }
          : { label: 'Install extension', disabled: !ext, run: installExt };

  const runPrimary = async () => {
    setBusy(true);
    setError(null);
    try {
      await primary.run();
      if (finished.current) onClose();
    } catch (err) {
      setError(ipcErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const foundCount = scan ? scan.length : null;
  const methods: Array<{ id: AddCustomTab; label: string }> = [
    { id: 'url', label: 'From a URL' },
    { id: 'found', label: `Found on this computer${foundCount != null ? ` · ${foundCount}` : ''}` },
    { id: 'cmd', label: 'Local command or JSON' },
    { id: 'ext', label: 'Extension from folder or git' },
  ];

  const tabsEl = editing ? (
    <div className="border-b border-line-2" />
  ) : (
    <div role="tablist" aria-label="How to add" className="flex gap-0.5 px-4 border-b border-line-2 flex-wrap">
      {methods.map((m, i) => {
        const sel = tab === m.id;
        return (
          <button
            key={m.id}
            id={`addcustom-tab-${m.id}`}
            type="button"
            role="tab"
            aria-selected={sel}
            aria-controls={`addcustom-panel-${m.id}`}
            tabIndex={sel ? 0 : -1}
            onClick={() => pickTab(m.id)}
            onKeyDown={(e) => {
              if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
              e.preventDefault();
              const next = methods[(i + (e.key === 'ArrowRight' ? 1 : methods.length - 1)) % methods.length]!;
              pickTab(next.id);
              document.getElementById(`addcustom-tab-${next.id}`)?.focus();
            }}
            className={cn(
              'h-9 px-2.5 border-0 border-b-2 bg-transparent text-[12.5px]',
              sel ? 'border-accent text-ink font-semibold' : 'border-transparent text-ink-3 hover:text-ink-2',
            )}
          >
            {m.label}
          </button>
        );
      })}
    </div>
  );

  const footer = (
    <>
      {/* One line, as drawn: the "not reviewed" badge lives on the detail and in the review step. */}
      <span className="flex-1 min-w-0 text-[12px] text-ink-3">Custom tools aren't reviewed by the marketplace. Only add ones you trust.</span>
      <Button size={36} variant="secondary" onClick={close}>
        Cancel
      </Button>
      <Button size={36} variant="primary" disabled={primary.disabled || busy} onClick={() => void runPrimary()}>
        {primary.label}
      </Button>
    </>
  );

  const errorEl = error ? (
    <div role="alert" className="text-[12.5px] text-bad">
      {error}
    </div>
  ) : null;

  return (
    <ModalShell
      title={editing ? `Edit ${editing.name}` : 'Add a custom tool'}
      description={editing ? 'Change which tools agents get, their risk labels, and where it is on.' : "Any MCP server or oIDE extension, even if it isn't in the marketplace."}
      onClose={close}
      tabs={tabsEl}
      footer={footer}
    >
      {editing ? (
        <div className="flex flex-col gap-3.5">
          <ToolRows tools={editTools} onChange={setEditTools} />
          <SaveFields name={name} onName={setName} nameError={nameError(name)} savedTo={savedTo} onSavedTo={setSavedTo} projects={projects} selected={selected} onSelected={setSelected} />
          {errorEl}
        </div>
      ) : (
        <div role="tabpanel" id={`addcustom-panel-${tab}`} aria-labelledby={`addcustom-tab-${tab}`} className="flex flex-col gap-3.5">
          {tab === 'url' && (
            <>
              <div className="flex flex-col gap-1.5">
                <label htmlFor={urlId} className="text-[12px] text-ink-2">
                  MCP server URL
                </label>
                <div className="flex gap-2">
                  <input
                    id={urlId}
                    data-autofocus
                    type="url"
                    className={cn(inputClass, 'flex-1')}
                    placeholder="https://mcp.example.com/mcp"
                    value={url}
                    aria-describedby={`${urlId}-hint`}
                    onChange={(e) => {
                      setUrl(e.target.value);
                      setProbe(null);
                      setAuth('idle');
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void connect();
                    }}
                  />
                  <Button size={36} variant="primary" className="h-[34px]" onClick={() => void connect()} disabled={probing || !url.trim()}>
                    {probing ? 'Connecting…' : probe ? 'Check again' : 'Connect'}
                  </Button>
                </div>
                <span id={`${urlId}-hint`} className="text-[12px] text-ink-3">
                  Paste the address and oIDE works out the rest: how to talk to it, how to sign in, and what tools it has.
                </span>
              </div>
              {probing && <Spinner label="Connecting" />}
              {probe && !probe.reached && (
                <div role="alert" className="p-3 rounded-xl border border-bad-line bg-bad-bg text-[12.5px] text-bad-bright">
                  Could not reach it. {probe.error}
                </div>
              )}
              {probe?.reached && (
                <>
                  <div className="flex flex-col gap-2 p-3 rounded-xl border border-line-2 bg-panel" aria-live="polite">
                    <span className="text-[11px] font-semibold tracking-[0.08em] uppercase text-ink-3">What oIDE found</span>
                    <span className="flex gap-2 items-center flex-wrap">
                      <Icon name="check" size={14} className="text-ok" />
                      <span>
                        Reached <b className="font-semibold">{probe.serverName ?? 'the server'}</b>
                      </span>
                      <span className="text-ink-3 text-[12px]">
                        {[probe.transport, probe.serverVersion ? `server v${probe.serverVersion}` : null].filter(Boolean).map((s) => ` · ${s}`).join('')}
                      </span>
                    </span>
                    <div className="flex gap-2 items-center flex-wrap">
                      {probe.needsAuth ? (
                        auth === 'signed' ? (
                          <>
                            <Icon name="check" size={14} className="text-ok" />
                            <span className="flex-1 min-w-[220px]">Signed in. oIDE keeps the token in your system keychain.</span>
                          </>
                        ) : (
                          <>
                            <span aria-hidden="true" className="w-2 h-2 mx-[3px] rounded-full bg-warn" />
                            <span className="flex-1 min-w-[220px]">It uses OAuth sign-in. No key to copy: sign in once in your browser.</span>
                            <Button size={28} className="bg-selected" onClick={() => void signIn()} disabled={auth === 'signing'}>
                              {auth === 'signing' ? 'Waiting for the browser…' : 'Sign in in your browser'}
                            </Button>
                          </>
                        )
                      ) : (
                        <>
                          <Icon name="check" size={14} className="text-ok" />
                          <span className="flex-1">No sign-in needed.</span>
                        </>
                      )}
                    </div>
                    {probe.needsAuth && auth !== 'signed' && (
                      <div className="flex flex-col gap-2">
                        <button type="button" className="self-start border-0 bg-transparent p-0 text-link text-[12px]" aria-expanded={useToken} onClick={() => setUseToken(!useToken)}>
                          {useToken ? 'Use browser sign-in instead' : 'Use a token instead'}
                        </button>
                        {useToken && (
                          <div className="flex gap-2 flex-wrap">
                            <label className="flex flex-col gap-1 text-[12px] text-ink-2 flex-[1_1_160px]">
                              Header
                              <input className={cn(inputClass, 'font-mono text-[12px]')} value={tokenHeader} onChange={(e) => setTokenHeader(e.target.value)} />
                            </label>
                            <label className="flex flex-col gap-1 text-[12px] text-ink-2 flex-[2_1_240px]">
                              Token
                              <input type="password" autoComplete="off" className={inputClass} placeholder="Stored in your OS keychain" value={token} onChange={(e) => setToken(e.target.value)} />
                            </label>
                          </div>
                        )}
                      </div>
                    )}
                    <span className="flex gap-2 items-center">
                      <Icon name="check" size={14} className="text-ok" />
                      {urlTools.length} tools found · {urlTools.filter((t) => t.enabled).length} turned on
                    </span>
                  </div>
                  <ToolRows tools={urlTools} onChange={setUrlTools} />
                  <SaveFields name={name} onName={setName} nameError={urlNameErr} savedTo={savedTo} onSavedTo={setSavedTo} projects={projects} selected={selected} onSelected={setSelected} />
                </>
              )}
            </>
          )}

          {tab === 'found' && !imported && (
            <>
              <span className="text-[12.5px] text-ink-2 leading-[1.5]">
                oIDE looked through the MCP settings other apps on this computer already use. Pick what to bring in. Nothing is changed in those apps.
              </span>
              {scan === null ? (
                <Spinner label="Searching" />
              ) : scan.length === 0 ? (
                <span className="text-[12.5px] text-ink-3">{scanError ? `The search failed: ${scanError}` : 'No MCP servers found in other apps.'}</span>
              ) : (
                <ul className="m-0 p-0 list-none flex flex-col gap-1.5" aria-label="Found MCP servers">
                  {scan.map((s) => {
                    const key = scanKey(s);
                    const on = picked.includes(key);
                    return (
                      <li key={key} className="flex items-center gap-2.5 px-2.5 py-2 rounded-md bg-panel border border-line">
                        <CheckButton
                          checked={on && !s.alreadyAdded}
                          disabled={s.alreadyAdded}
                          label={`Import ${s.name}`}
                          onChange={(v) => setPicked(v ? [...picked, key] : picked.filter((k) => k !== key))}
                        />
                        <span className="flex-1 min-w-0 flex flex-col gap-0.5">
                          <span className="font-semibold">{s.name}</span>
                          <span className="font-mono text-[11px] text-ink-3 truncate">{s.display ?? ''}</span>
                        </span>
                        <span className="text-[11.5px] text-ink-3 text-right">{s.source}</span>
                        <span className="text-[11.5px] text-ink-3 w-[110px] text-right">{s.alreadyAdded ? 'already added' : s.kind === 'http' ? 'remote' : ''}</span>
                      </li>
                    );
                  })}
                </ul>
              )}
              <span className="text-[12px] text-ink-3">
                Searched: Claude Desktop, Claude Code (your settings and each open project's .mcp.json), and other editors' MCP settings. Only server entries are read; secrets move to your keychain.
              </span>
              <SaveFields showName={false} savedTo={savedTo} onSavedTo={setSavedTo} projects={projects} selected={selected} onSelected={setSelected} />
            </>
          )}

          {tab === 'found' && imported && (
            <>
              <span className="text-[12.5px] text-ink-2">
                Imported {imported.length} {imported.length === 1 ? 'server' : 'servers'}. Check each one's tools and risk labels.
              </span>
              {imported.map((s, i) => (
                <ToolRows
                  key={s.id}
                  heading={s.name}
                  tools={s.tools.map((t) => ({ ...t }))}
                  onChange={(tools) => setImported(imported.map((x, j) => (j === i ? { ...x, tools: toCustomTools(tools) } : x)))}
                />
              ))}
            </>
          )}

          {tab === 'cmd' && (
            <>
              <div role="radiogroup" aria-label="How to describe it" className="flex gap-1.5 p-[3px] rounded-md bg-panel self-start">
                {(['form', 'json'] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    role="radio"
                    aria-checked={cmdMode === m}
                    onClick={() => {
                      setCmdMode(m);
                      setCmdProbe(null);
                    }}
                    className={cn('h-[26px] px-2.5 border-0 rounded-sm text-[12px] text-ink', cmdMode === m ? 'bg-selected' : 'bg-transparent')}
                  >
                    {m === 'form' ? 'Fill in' : 'Paste JSON'}
                  </button>
                ))}
              </div>
              {cmdMode === 'form' ? (
                <>
                  <div className="flex gap-3 flex-wrap">
                    <label className="flex-[1_1_180px] flex flex-col gap-1.5 text-[12px] text-ink-2">
                      Name
                      <input className={inputClass} value={name} placeholder="local-search" onChange={(e) => setName(e.target.value)} aria-invalid={cmdNameErr ? true : undefined} />
                      {cmdNameErr && <span className="text-bad">{cmdNameErr}</span>}
                    </label>
                    <div className="flex-[2_1_300px] flex flex-col gap-1.5">
                      <label htmlFor={cmdId} className="text-[12px] text-ink-2">
                        Command
                      </label>
                      <input
                        id={cmdId}
                        data-autofocus
                        className={cn(inputClass, 'font-mono text-[12px]')}
                        placeholder="npx -y @example/search-mcp --root ."
                        value={cmdLine}
                        onChange={(e) => {
                          setCmdLine(e.target.value);
                          setCmdProbe(null);
                        }}
                      />
                    </div>
                  </div>
                  <fieldset className="m-0 p-0 border-0 flex flex-col gap-1.5">
                    <legend className="text-[12px] text-ink-2 p-0 mb-1.5">Environment variables</legend>
                    {env.map((row, i) => (
                      <div key={i} className="flex gap-2">
                        <input
                          aria-label={`Variable ${i + 1} name`}
                          className={cn(inputClass, 'flex-1 font-mono text-[12px]')}
                          placeholder="SEARCH_API_KEY"
                          value={row.key}
                          onChange={(e) => setEnv(env.map((r, j) => (j === i ? { ...r, key: e.target.value } : r)))}
                        />
                        <input
                          aria-label={`Variable ${i + 1} value`}
                          type="password"
                          autoComplete="off"
                          className={cn(inputClass, 'flex-[1.4] font-mono text-[12px]')}
                          placeholder="stored in your keychain"
                          value={row.value}
                          onChange={(e) => setEnv(env.map((r, j) => (j === i ? { ...r, value: e.target.value } : r)))}
                        />
                      </div>
                    ))}
                    <button type="button" className="self-start border-0 bg-transparent p-0 text-link text-[12px]" onClick={() => setEnv([...env, { key: '', value: '' }])}>
                      + Add variable
                    </button>
                  </fieldset>
                </>
              ) : (
                <div className="flex flex-col gap-1.5">
                  <label htmlFor={jsonId} className="text-[12px] text-ink-2">
                    mcpServers JSON
                  </label>
                  <textarea
                    id={jsonId}
                    data-autofocus
                    rows={8}
                    spellCheck={false}
                    className={cn('px-2.5 py-2.5 rounded-md border bg-chrome text-ink font-mono text-[12px] leading-[1.55] outline-none focus:border-accent resize-y', pasted?.error ? 'border-bad-line' : 'border-line-3')}
                    placeholder='{ "mcpServers": { "local-search": { "command": "npx", "args": ["-y", "@example/search-mcp"], "env": { "SEARCH_API_KEY": "..." } } } }'
                    value={json}
                    aria-invalid={pasted?.error ? true : undefined}
                    aria-describedby={`${jsonId}-status`}
                    onChange={(e) => {
                      setJson(e.target.value);
                      setCmdProbe(null);
                    }}
                  />
                  <span id={`${jsonId}-status`} className={cn('text-[12px]', pasted?.error ? 'text-bad' : 'text-ok')}>
                    {pasted?.error
                      ? pasted.error
                      : pasted?.servers.length
                        ? `Recognised ${pasted.servers.length} ${pasted.servers.length === 1 ? 'server' : 'servers'} in the standard mcpServers format. Secrets move to your keychain.`
                        : ''}
                  </span>
                </div>
              )}
              <div className="flex items-center gap-2.5">
                <Button size={32} onClick={() => void testCommand()} disabled={busy}>
                  Test it
                </Button>
                <span className="text-[12px] text-ink-3">Starts it once and lists its tools, like a URL server.</span>
              </div>
              {cmdProbe &&
                Object.entries(cmdProbe).map(([srv, r]) =>
                  r.error ? (
                    <div key={srv} role="alert" className="text-[12.5px] text-bad">
                      {srv}: {r.error}
                    </div>
                  ) : (
                    <ToolRows
                      key={srv}
                      heading={Object.keys(cmdProbe).length > 1 ? srv : 'Tools agents can use'}
                      tools={r.tools}
                      onChange={(tools) => setCmdProbe({ ...cmdProbe, [srv]: { tools } })}
                    />
                  ),
                )}
              {cmdServers().length > 0 && <SaveFields showName={false} savedTo={savedTo} onSavedTo={setSavedTo} projects={projects} selected={selected} onSelected={setSelected} />}
            </>
          )}

          {tab === 'ext' && (
            <>
              <div
                className="flex flex-col items-center gap-2 p-[22px] rounded-xl border-[1.5px] border-dashed border-line-hover text-center text-ink-2"
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  void loadFolder();
                }}
              >
                <span className="font-semibold">Drop an extension folder or package here</span>
                <span className="text-[12px] text-ink-3">or</span>
                <Button size={32} onClick={() => void loadFolder()} disabled={busy} data-autofocus>
                  Choose a folder…
                </Button>
              </div>
              <div className="flex flex-col gap-1.5">
                <label htmlFor={gitId} className="text-[12px] text-ink-2">
                  Or a git repository
                </label>
                <div className="flex gap-2">
                  <input
                    id={gitId}
                    type="url"
                    className={cn(inputClass, 'flex-1 font-mono text-[12.5px]')}
                    placeholder="https://github.com/you/your-extension"
                    value={gitUrl}
                    onChange={(e) => setGitUrl(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void loadGit();
                    }}
                  />
                  <Button size={36} className="h-[34px]" onClick={() => void loadGit()} disabled={busy || !gitUrl.trim()}>
                    Fetch
                  </Button>
                </div>
              </div>
              <label className="flex items-center gap-2 text-[12.5px] cursor-pointer">
                <input type="checkbox" className="accent-accent" checked={devMode} onChange={(e) => setDevMode(e.target.checked)} />
                Developer mode: reload when its files change
              </label>
              <span className="text-[12px] text-ink-3 leading-[1.5]">oIDE reads the extension's manifest and shows its tools and permissions before anything runs.</span>
              {busy && <Spinner label="Reading the manifest" />}
              {ext && (
                <div className="flex flex-col gap-3 p-3 rounded-xl border border-line-2 bg-panel">
                  <span className="flex items-center gap-2 flex-wrap">
                    <b className="font-semibold">{ext.displayName}</b>
                    <span className="text-ink-3 text-[12px]">
                      v{ext.version} · from {ext.source === 'git' ? 'git' : 'a folder'}
                      {ext.devMode ? ' · developer mode' : ''}
                    </span>
                    <Badge tone="warn">not reviewed</Badge>
                  </span>
                  <ToolRows
                    readOnlyRisk
                    tools={Object.values(ext.manifest.oide.mcpServers).flatMap((s) => Object.entries(s.tools).map(([n, t]) => ({ name: n, description: t.description, risk: t.risk, enabled: true })))}
                  />
                  <Capabilities caps={ext.manifest.oide.capabilities} />
                </div>
              )}
              {ext && (
                <fieldset className="m-0 p-0 border-0 flex flex-col gap-1.5">
                  <legend className="text-[12px] text-ink-2 mb-1.5 p-0">Turn on for</legend>
                  <div className="flex gap-3.5 flex-wrap">
                    {projects.map((p) => (
                      <label key={p.id} className="flex items-center gap-1.5 cursor-pointer">
                        <input
                          type="checkbox"
                          className="accent-accent"
                          checked={selected.includes(p.id)}
                          onChange={(e) => setSelected(e.target.checked ? [...selected, p.id] : selected.filter((x) => x !== p.id))}
                        />
                        {p.name}
                      </label>
                    ))}
                  </div>
                </fieldset>
              )}
            </>
          )}
          {errorEl}
        </div>
      )}
    </ModalShell>
  );
}

/**
 * Declared capabilities, shown for consent. Not enforced (SEC-14): Electron 45's utilityProcess
 * ignores Node's `--permission` flags and the RunAsNode fuse is off, so the copy must never imply it.
 */
export function Capabilities({ caps }: { caps: { network: string[]; spawn: boolean; fs?: string[] } }) {
  const rows: string[] = [
    ...caps.network.map((h) => `Network: ${h}`),
    ...(caps.spawn ? ['Starts processes on this computer'] : []),
    ...(caps.fs ?? []).map((p) => `Files: ${p}`),
  ];
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[11px] font-semibold tracking-[0.08em] uppercase text-ink-3">Declared capabilities</span>
      {rows.length === 0 ? (
        <span className="text-[12px] text-ink-3">None declared.</span>
      ) : (
        <ul className="m-0 pl-4 list-disc text-[12.5px] text-ink-2 flex flex-col gap-0.5">
          {rows.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}
      <span className="text-[11.5px] text-ink-3">
        What the extension says it uses. oIDE does not enforce this: its code runs as you, with the same access to your files, network and programs.
      </span>
    </div>
  );
}

