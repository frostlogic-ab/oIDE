import { useCallback, useEffect, useState } from 'react';
import type { Diagnostics } from '@oide/protocol';
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
