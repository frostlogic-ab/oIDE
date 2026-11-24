import '@xterm/xterm/css/xterm.css';
import { useEffect, useRef, useState } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import { EmptyState } from '@oide/ui';
import { ipcErrorMessage, isNotImplemented, oide } from '../../../lib/bridge';

/**
 * Inspector › Terminal: a shell (node-pty in main, `terminal.create`) whose cwd is the agent's
 * worktree, drawn with xterm.js. The pty is killed and xterm disposed on unmount.
 */
export function TerminalPanel({ cwd, visible }: { cwd?: string; visible: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!cwd || !host.current) return;
    setError(null);
    const term = new Terminal({
      fontFamily: "'JetBrains Mono', ui-monospace, monospace",
      fontSize: 12,
      lineHeight: 1.25,
      cursorBlink: true,
      scrollback: 5000,
      theme: { background: '#0B0D10', foreground: '#C9CED6', cursor: '#7AA2F7', selectionBackground: '#2B3240', black: '#15181D', brightBlack: '#6B7584', red: '#F08A8A', green: '#7FC8A9', yellow: '#F2C078', blue: '#7AA2F7', magenta: '#C4A7E7', cyan: '#9DBBFA', white: '#C9CED6', brightWhite: '#E6E8EB' },
    });
    const fit = new FitAddon();
    fitRef.current = fit;
    term.loadAddon(fit);
    term.open(host.current);
    try {
      fit.fit();
    } catch {
      /* not laid out yet */
    }
    let id: string | null = null;
    let disposed = false;
    const offs: Array<() => void> = [];

    offs.push(
      oide.on('terminal.data', ({ terminalId, data }) => {
        if (terminalId === id) term.write(data);
      }),
      oide.on('terminal.exit', ({ terminalId, code }) => {
        if (terminalId === id) term.write(`\r\n\x1b[90m[process exited${code !== null ? ` with code ${code}` : ''}]\x1b[0m\r\n`);
      }),
    );
    const input = term.onData((data) => {
      if (id) void oide.invoke('terminal.write', { terminalId: id, data }).catch(() => {});
    });
    const resize = term.onResize(({ cols, rows }) => {
      if (id) void oide.invoke('terminal.resize', { terminalId: id, cols, rows }).catch(() => {});
    });

    oide.invoke('terminal.create', { cwd, cols: term.cols, rows: term.rows }).then(
      ({ terminalId }) => {
        if (disposed) {
          void oide.invoke('terminal.kill', { terminalId }).catch(() => {});
          return;
        }
        id = terminalId;
      },
      (err: unknown) => {
        if (!disposed) setError(isNotImplemented(err) ? 'Terminals are not available in this build.' : ipcErrorMessage(err));
      },
    );

    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        /* hidden */
      }
    }) : null;
    ro?.observe(host.current);

    return () => {
      disposed = true;
      ro?.disconnect();
      offs.forEach((off) => off());
      input.dispose();
      resize.dispose();
      if (id) void oide.invoke('terminal.kill', { terminalId: id }).catch(() => {});
      term.dispose();
      fitRef.current = null;
    };
  }, [cwd]);

  useEffect(() => {
    if (!visible) return;
    const t = setTimeout(() => {
      try {
        fitRef.current?.fit();
      } catch {
        /* ignore */
      }
    }, 0);
    return () => clearTimeout(t);
  }, [visible]);

  if (!cwd) return <EmptyState icon="terminal" title="No worktree yet" description="The terminal opens in the agent's worktree once it has one." className="flex-1" />;
  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="px-4 py-2 font-mono text-[11px] text-ink-3 truncate border-b border-line" title={cwd}>
        {cwd}
      </div>
      {error && <div className="px-4 py-2 text-[12px] text-bad">{error}</div>}
      <div ref={host} className="oide-term flex-1 min-h-[200px] bg-chrome" aria-label="Terminal in the agent's worktree" />
    </div>
  );
}
