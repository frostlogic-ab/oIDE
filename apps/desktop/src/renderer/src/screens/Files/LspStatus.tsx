/**
 * Tab bar: the open file's language server (state dot + name, a menu with Restart / Copy install
 * command) and its problem counts (click: next problem, like VS Code's status bar and F8).
 */
import { useState } from 'react';
import { ContextMenu, Icon, type ContextMenuEntry } from '@oide/ui';
import type { LspStatus as Status } from '@oide/protocol';
import { toast } from '../../stores/ui';
import { C } from '../SourceControl/model';
import { problemSummary, type FileProblems } from './lspStore';

const DOT: Record<Status['state'], string> = {
  none: C.ink3,
  untrusted: '#6B7584',
  'not-installed': C.warn,
  starting: C.ink3,
  running: C.ok,
  failed: C.bad,
};

export function statusText(s: Status): { label: string; title: string } {
  const name = s.server ?? s.language ?? 'Language server';
  switch (s.state) {
    case 'running':
      return { label: name, title: `${name} is running${s.extension ? ` (from ${s.extension})` : ''}. Hover, completions, go to definition (F12), references (Shift+F12), symbols (Ctrl+Shift+O) and Format Document come from it.` };
    case 'starting':
      return { label: `${name}…`, title: s.message ? `Starting ${name}. ${s.message}` : `Starting ${name}` };
    case 'not-installed':
      return { label: `${name} not installed`, title: `${s.message ?? `${name} was not found.`}${s.install ? ` Install it with: ${s.install}` : ''} Then choose Try again.` };
    case 'failed':
      return { label: `${name} failed`, title: s.message ?? `${name} failed` };
    case 'untrusted':
      return { label: 'Language server off', title: `This project is not trusted, so ${name} does not run (language servers run code from the repository). Trust the project to turn it on.` };
    default:
      return { label: '', title: '' };
  }
}

export function LspStatusControl({ status, problems, onNextProblem, onRestart }: { status?: Status | undefined; problems?: FileProblems | undefined; onNextProblem(): void; onRestart(): void }) {
  const [menu, setMenu] = useState<{ x: number; y: number }>();
  const counts = problems && (problems.errors || problems.warnings) ? problems : undefined;
  if (!status && !counts) return null;
  const text = status ? statusText(status) : undefined;
  const items: ContextMenuEntry[] = [];
  if (status?.state === 'not-installed' && status.install) {
    const install = status.install;
    items.push({
      id: 'copy-install',
      label: 'Copy install command',
      icon: 'copy',
      title: install,
      onSelect: () =>
        void navigator.clipboard.writeText(install).then(
          () => toast('Copied the install command', 'success', { duration: 2000 }),
          () => toast("Couldn't copy the install command", 'error'),
        ),
    });
  }
  if (status && status.state !== 'untrusted') items.push({ id: 'restart', label: status.state === 'not-installed' ? 'Try again' : 'Restart language server', icon: 'refresh', onSelect: onRestart });
  return (
    <>
      {counts && (
        <button
          type="button"
          onClick={onNextProblem}
          title={`${problemSummary(counts)}. Go to the next problem (F8)`}
          aria-label={`${problemSummary(counts)}. Go to the next problem`}
          aria-keyshortcuts="F8"
          className="inline-flex items-center gap-1.5 h-6 px-1.5 rounded-sm border-0 bg-transparent text-[11.5px] text-ink-3 cursor-pointer hover:bg-raised hover:text-ink"
        >
          <span className="inline-flex items-center gap-0.5" style={{ color: counts.errors ? C.bad : undefined }}>
            <Icon name="alert-circle" size={12} />
            {counts.errors}
          </span>
          <span className="inline-flex items-center gap-0.5" style={{ color: counts.warnings ? C.warn : undefined }}>
            <Icon name="warning" size={12} />
            {counts.warnings}
          </span>
        </button>
      )}
      {status && text && text.label && (
        <button
          type="button"
          title={text.title}
          aria-label={`Language server: ${text.label}`}
          aria-haspopup={items.length ? 'menu' : undefined}
          data-lsp-state={status.state}
          disabled={!items.length}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setMenu({ x: r.left, y: r.bottom + 2 });
          }}
          className="inline-flex items-center gap-1.5 h-6 max-w-[220px] px-1.5 rounded-sm border-0 bg-transparent text-[11.5px] text-ink-3 cursor-pointer hover:bg-raised hover:text-ink disabled:cursor-default disabled:hover:bg-transparent"
        >
          <span aria-hidden="true" className={`w-[7px] h-[7px] rounded-full shrink-0 ${status.state === 'starting' ? 'animate-pulse' : ''}`} style={{ background: DOT[status.state] }} />
          <span className="truncate">{text.label}</span>
        </button>
      )}
      {menu && items.length > 0 && <ContextMenu at={menu} label="Language server" items={items} onClose={() => setMenu(undefined)} />}
    </>
  );
}
