import { useEffect, useRef } from 'react';
import '@xterm/xterm/css/xterm.css';
import './terminal.css';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import { ipcErrorMessage, isNotImplemented, oide } from '../../lib/bridge';
import { onSessionDisposed, useTerminals, type TermSession } from '../../stores/terminals';

/**
 * One terminal session drawn with xterm.js (loaded lazily with this module). Each session keeps its
 * own xterm, which lives on while the session does: the view only moves the xterm's element into
 * its host, so switching tabs, agents or screens keeps the scrollback and the running process.
 * The pty is started here, once xterm has measured the host (`terminal.create` for a shell,
 * `terminal.runScript` for a script).
 */

const THEME = {
  background: '#0B0D10',
  foreground: '#C9CED6',
  cursor: '#7AA2F7',
  selectionBackground: '#2B3240',
  black: '#15181D',
  brightBlack: '#6B7584',
  red: '#F08A8A',
  green: '#7FC8A9',
  yellow: '#F2C078',
  blue: '#7AA2F7',
  magenta: '#C4A7E7',
  cyan: '#9DBBFA',
  white: '#C9CED6',
  brightWhite: '#E6E8EB',
};

interface Instance {
  term: Terminal;
  fit: FitAddon;
  el: HTMLDivElement;
  opened: boolean;
  started: boolean;
  terminalId?: string;
}

const instances = new Map<string, Instance>();
const byTerminalId = new Map<string, string>();
/** Output that arrived before `terminal.create` / `runScript` returned its id. */
const early = new Map<string, string>();
const EARLY_MAX_IDS = 32;
const EARLY_MAX_CHARS = 64 * 1024;

let routed = false;
function routeEvents(): void {
  if (routed) return;
  routed = true;
  oide.on('terminal.data', ({ terminalId, data }) => {
    const key = byTerminalId.get(terminalId);
    const inst = key ? instances.get(key) : undefined;
    if (inst) {
      inst.term.write(data);
      return;
    }
    // Not ours yet (or another terminal, such as sign-in): hold a little, bounded.
    const prev = early.get(terminalId) ?? '';
    early.set(terminalId, (prev + data).slice(-EARLY_MAX_CHARS));
    if (early.size > EARLY_MAX_IDS) early.delete(early.keys().next().value!);
  });
  oide.on('terminal.exit', ({ terminalId, code }) => {
    const key = byTerminalId.get(terminalId);
    const inst = key ? instances.get(key) : undefined;
    inst?.term.write(`\r\n\x1b[90m[process exited${code !== null ? ` with code ${code}` : ''}]\x1b[0m\r\n`);
    useTerminals.getState().exited(terminalId, code);
    byTerminalId.delete(terminalId);
  });
}

function instanceFor(session: TermSession): Instance {
  const existing = instances.get(session.key);
  if (existing) return existing;
  const term = new Terminal({
    fontFamily: "'JetBrains Mono', ui-monospace, monospace",
    fontSize: 12,
    lineHeight: 1.25,
    cursorBlink: true,
    scrollback: 5000,
    theme: THEME,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  const el = document.createElement('div');
  el.className = 'h-full w-full';
  const inst: Instance = { term, fit, el, opened: false, started: false };
  term.onData((data) => {
    if (inst.terminalId) void oide.invoke('terminal.write', { terminalId: inst.terminalId, data }).catch(() => {});
  });
  term.onResize(({ cols, rows }) => {
    if (inst.terminalId) void oide.invoke('terminal.resize', { terminalId: inst.terminalId, cols, rows }).catch(() => {});
  });
  instances.set(session.key, inst);
  onSessionDisposed(session.key, () => {
    if (inst.terminalId) byTerminalId.delete(inst.terminalId);
    instances.delete(session.key);
    inst.el.remove();
    inst.term.dispose();
  });
  return inst;
}

function fitSafely(inst: Instance): void {
  try {
    inst.fit.fit();
  } catch {
    /* hidden or not laid out yet */
  }
}

function start(session: TermSession, inst: Instance): void {
  if (inst.started) return;
  inst.started = true;
  const { cols, rows } = inst.term;
  const req =
    session.kind === 'script' && session.script
      ? oide.invoke('terminal.runScript', { cwd: session.cwd, scriptId: session.script.id, cols, rows }).then((r) => r.terminalId)
      : oide.invoke('terminal.create', { cwd: session.cwd, cols, rows }).then((r) => r.terminalId);
  req.then(
    (terminalId) => {
      if (!instances.has(session.key)) {
        // Closed while starting.
        void oide.invoke('terminal.kill', { terminalId }).catch(() => {});
        return;
      }
      inst.terminalId = terminalId;
      byTerminalId.set(terminalId, session.key);
      const held = early.get(terminalId);
      if (held) {
        early.delete(terminalId);
        inst.term.write(held);
      }
      useTerminals.getState().started(session.key, terminalId);
      // xterm may have been fitted to a new size before the id was known.
      if (inst.term.cols !== cols || inst.term.rows !== rows) void oide.invoke('terminal.resize', { terminalId, cols: inst.term.cols, rows: inst.term.rows }).catch(() => {});
    },
    (err: unknown) => {
      const message = isNotImplemented(err) ? 'Terminals are not available in this build.' : ipcErrorMessage(err);
      inst.term.write(`\x1b[38;2;240;138;138m${message}\x1b[0m\r\n`);
      useTerminals.getState().failed(session.key, message);
    },
  );
}

export function TerminalView({ session, visible, label }: { session: TermSession; visible: boolean; label: string }) {
  const host = useRef<HTMLDivElement>(null);
  const instRef = useRef<Instance | null>(null);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    routeEvents();
    const inst = instanceFor(session);
    instRef.current = inst;
    el.appendChild(inst.el);
    if (!inst.opened) {
      inst.term.open(inst.el);
      inst.opened = true;
    }
    fitSafely(inst);
    if (session.status === 'starting') start(session, inst);
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => fitSafely(inst)) : null;
    ro?.observe(el);
    return () => {
      ro?.disconnect();
      // Detach only: the session (and its xterm) lives on until its tab is closed.
      if (inst.el.parentElement === el) inst.el.remove();
      instRef.current = null;
    };
    // The session object changes on every status update; the view follows the session key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.key]);

  useEffect(() => {
    if (!visible) return;
    const t = setTimeout(() => {
      const inst = instRef.current;
      if (!inst) return;
      fitSafely(inst);
      inst.term.focus();
    }, 0);
    return () => clearTimeout(t);
  }, [visible, session.key]);

  return <div ref={host} className="oide-term flex-1 min-h-0 bg-chrome" aria-label={label} />;
}

export default TerminalView;
