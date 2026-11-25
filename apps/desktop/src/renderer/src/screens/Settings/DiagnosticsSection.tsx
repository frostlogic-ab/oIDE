import { useCallback, useEffect, useState } from 'react';
import type { Diagnostics, FolderHolderInfo, PendingCleanupInfo } from '@oide/protocol';
import { Spinner, cn } from '@oide/ui';
import { ipcErrorMessage, oide } from '../../lib/bridge';
import { toast } from '../../stores/ui';
import { H1, Rd, Row, Sec, outlineBtn } from './ui';

const TONE: Record<Diagnostics['checks'][number]['status'], { label: string; cls: string }> = {
  ok: { label: 'OK', cls: 'text-ok border-ok-line' },
  warn: { label: 'Check', cls: 'text-warn border-warn-line' },
  error: { label: 'Problem', cls: 'text-bad border-bad-line' },
  info: { label: 'Info', cls: 'text-ink-3 border-line-3' },
};

type Holders = { supported: boolean; holders: FolderHolderInfo[]; error?: string };

function holderText(h: Holders): string {
  if (!h.supported) return 'oIDE cannot list the programs holding a folder on this system.';
  if (h.error && !h.holders.length) return `Could not list the programs holding this folder (${h.error}).`;
  if (!h.holders.length) return 'No program holds this folder open right now. Retry now should remove it.';
  return h.holders.map((x) => (x.exes.length === 1 && x.exes[0] === x.label ? x.label : `${x.label} (${x.exes.join(', ')})`)).join(' · ');
}

/**
 * Worktree folders oIDE could not delete because a program held them open (Docker Desktop, an
 * editor, a terminal). oIDE retries them every 5 minutes and at start; here they can be retried at
 * once, and the programs holding them listed.
 */
function PendingCleanups() {
  const [items, setItems] = useState<PendingCleanupInfo[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [holders, setHolders] = useState<Record<string, Holders>>({});

  const load = useCallback(async () => {
    try {
      setItems(await oide.invoke('app.pendingCleanups', undefined));
    } catch {
      setItems([]);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const retry = async (path: string) => {
    setBusy(`retry:${path}`);
    try {
      const r = await oide.invoke('app.retryCleanup', { path });
      if (r.stillPending.length) toast('The folder is still in use. oIDE keeps trying in the background.', 'error');
    } catch (err) {
      toast(`Could not retry: ${ipcErrorMessage(err)}`, 'error');
    } finally {
      setBusy(null);
      void load();
    }
  };

  const show = async (path: string) => {
    setBusy(`holders:${path}`);
    try {
      const h = await oide.invoke('app.cleanupHolders', { path });
      setHolders((m) => ({ ...m, [path]: h }));
    } catch (err) {
      toast(`Could not list the programs: ${ipcErrorMessage(err)}`, 'error');
    } finally {
      setBusy(null);
    }
  };

  if (!items?.length) return null;
  return (
    <>
      <Sec>Folders waiting to be removed</Sec>
      <Rd className="block mt-2">
        Worktree folders a program still held open when their agent was removed. oIDE tries again every 5 minutes and when it starts; quit the program holding a folder and it goes.
      </Rd>
      {items.map((e) => {
        const h = holders[e.path];
        return (
          <Row
            key={e.path}
            title={e.name}
            desc={
              <>
                <span className="font-mono text-[11.5px] break-all">{e.path}</span>
                <span className="block mt-1">
                  {e.attempts} {e.attempts === 1 ? 'try' : 'tries'}
                  {e.lastError === 'denied' ? ' · access denied' : ''}
                  {!h && e.holders.length ? ` · last held by ${e.holders.join(', ')}` : ''}
                </span>
                {h && (
                  <span className="block mt-1" role="status">
                    {holderText(h)}
                  </span>
                )}
              </>
            }
          >
            {() => (
              <span className="flex gap-2">
                <button type="button" className={outlineBtn} disabled={busy !== null} onClick={() => void show(e.path)} aria-label={`Show programs holding ${e.name}`}>
                  {busy === `holders:${e.path}` ? 'Looking…' : 'Show holders'}
                </button>
                <button type="button" className={outlineBtn} disabled={busy !== null} onClick={() => void retry(e.path)} aria-label={`Retry removing ${e.name}`}>
                  {busy === `retry:${e.path}` ? 'Retrying…' : 'Retry now'}
                </button>
              </span>
            )}
          </Row>
        );
      })}
    </>
  );
}

/**
 * Settings › Diagnostics: what oIDE found at startup (CLI and its tested range, git ≥ 2.38 for
 * merge-tree, gh, node, keychain, database, MCP port, logs). Values are redacted in main, so
 * "Copy report" is safe to paste into a bug report. "Open logs folder" opens `<userData>/logs`.
 */
export function DiagnosticsSection() {
  const [diag, setDiag] = useState<Diagnostics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setDiag(await oide.invoke('app.diagnostics', undefined));
    } catch (err) {
      setError(ipcErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const copy = async () => {
    if (!diag) return;
    try {
      await navigator.clipboard.writeText(diag.report);
      toast('Diagnostics report copied.', 'success');
    } catch {
      toast('Could not copy the report.', 'error');
    }
  };

  const openLogs = async () => {
    try {
      await oide.invoke('app.openLogsFolder', undefined);
    } catch (err) {
      toast(`Could not open the logs folder: ${ipcErrorMessage(err)}`, 'error');
    }
  };

  return (
    <>
      <H1>Diagnostics</H1>
      <Rd>What oIDE checks at startup. Paths are shortened and keys removed, so the report can go into a bug report as is.</Rd>
      <div className="flex gap-2 mt-3.5">
        <button type="button" className={outlineBtn} onClick={() => void copy()} disabled={!diag}>
          Copy report
        </button>
        <button type="button" className={outlineBtn} onClick={() => void refresh()} disabled={busy}>
          {busy ? 'Checking…' : 'Check again'}
        </button>
      </div>
      <Sec>Checks</Sec>
      {error && (
        <Rd className="mt-3 text-bad" id="diag-error">
          Diagnostics failed: {error}
        </Rd>
      )}
      {!diag && !error && (
        <div className="flex items-center gap-2 text-ink-3 text-[12.5px] py-6">
          <Spinner /> Checking…
        </div>
      )}
      {diag?.checks.map((c) => (
        <Row
          key={c.id}
          title={c.label}
          desc={
            <>
              <span className="font-mono text-[11.5px] break-all">{c.value}</span>
              {c.detail && <span className="block mt-1">{c.detail}</span>}
            </>
          }
        >
          {() => <span className={cn('text-[11.5px] font-semibold px-2 py-0.5 rounded-md border', TONE[c.status].cls)}>{TONE[c.status].label}</span>}
        </Row>
      ))}
      <PendingCleanups />
      <Sec>Logs</Sec>
      <Row
        title="Log files"
        desc="Main process, extension host and one log per agent, rotated at 5 MB and kept for 14 days. Tokens, keys, environment values and your home folder are removed before anything is written."
      >
        {() => (
          <button type="button" className={outlineBtn} onClick={() => void openLogs()}>
            Open logs folder
          </button>
        )}
      </Row>
    </>
  );
}
