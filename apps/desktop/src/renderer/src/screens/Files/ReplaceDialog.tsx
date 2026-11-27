import { useEffect, useMemo, useState } from 'react';
import { Button, Checkbox, Dialog, Icon } from '@oide/ui';
import type { ContentFileResult, ContentMatch, ReplaceFileResult, SearchOptions } from '@oide/protocol';
import { invokeOr, ipcErrorMessage, oide } from '../../lib/bridge';
import { useAgents } from '../../stores/agents';
import { joinPath } from './filesStore';
import { lineDiffs, type Seg } from './searchModel';
import { resultKey } from './searchStore';

export interface ReplaceItem {
  file: ContentFileResult;
  matches: ContentMatch[];
}

/**
 * Replace confirm: per file a checkbox, a warning when an agent is changing the file
 * (`files.editingAgents`), and the old / new text of each matched line. Only the checked files'
 * listed matches go to `files.replace`, which refuses files that changed since the search.
 */
export function ReplaceDialog({
  items,
  options,
  replacement,
  rootLabel,
  onClose,
  onDone,
}: {
  items: ReplaceItem[];
  options: SearchOptions;
  replacement: string;
  rootLabel: (root: string) => string;
  onClose(): void;
  onDone(results: ReplaceFileResult[]): void;
}) {
  const [checked, setChecked] = useState<Record<string, boolean>>(() => Object.fromEntries(items.map((i) => [resultKey(i.file), true])));
  const [editing, setEditing] = useState<Record<string, string[]>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const agents = useAgents((s) => s.byId);

  useEffect(() => {
    let cancelled = false;
    void Promise.all(
      items.map(async (i) => [resultKey(i.file), await invokeOr('files.editingAgents', { path: joinPath(i.file.root, i.file.path) }, [] as string[]).catch(() => [] as string[])] as const),
    ).then((pairs) => {
      if (!cancelled) setEditing(Object.fromEntries(pairs.filter(([, ids]) => ids.length)));
    });
    return () => {
      cancelled = true;
    };
  }, [items]);

  const chosen = items.filter((i) => checked[resultKey(i.file)]);
  const total = chosen.reduce((n, i) => n + i.matches.length, 0);
  const diffs = useMemo(() => new Map(items.map((i) => [resultKey(i.file), lineDiffs(i.matches, options, replacement)])), [items, options, replacement]);
  const allMatches = items.reduce((n, i) => n + i.matches.length, 0);

  const confirm = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const { results } = await oide.invoke('files.replace', {
        ...options,
        replacement,
        files: chosen.map((i) => ({ root: i.file.root, path: i.file.path, hash: i.file.hash, matches: i.matches.map(({ line, column, length, text }) => ({ line, column, length, text })) })),
      });
      onDone(results);
    } catch (err) {
      setError(ipcErrorMessage(err));
      setBusy(false);
    }
  };

  // The replace can't be interrupted, so the dialog stays until it finishes.
  const close = () => {
    if (!busy) onClose();
  };

  const title = `Replace ${allMatches} ${allMatches === 1 ? 'match' : 'matches'}${items.length > 1 ? ` in ${items.length} files` : ''}?`;
  return (
    <Dialog
      open
      onClose={close}
      dismissOnScrim={!busy}
      title={title}
      description={
        <>
          <span className="font-mono text-[12px] text-ink-2">{options.query}</span> becomes{' '}
          <span className="font-mono text-[12px] text-ink-2">{replacement === '' ? '(nothing)' : replacement}</span>. Files that changed since the search are left alone.
        </>
      }
      width={720}
      position="top"
      footer={
        <>
          {error && <span className="mr-auto text-[12px] text-bad">{error}</span>}
          <Button variant="secondary" size={28} disabled={busy} onClick={close}>
            Cancel
          </Button>
          <Button variant="primary" size={28} disabled={busy || total === 0} onClick={() => void confirm()}>
            {busy ? 'Replacing…' : `Replace ${total} ${total === 1 ? 'match' : 'matches'}`}
          </Button>
        </>
      }
    >
      <ul aria-label="Files to change" className="list-none m-0 px-5 py-4 flex flex-col gap-2.5 max-h-[52vh] overflow-auto">
        {items.map((i) => {
          const key = resultKey(i.file);
          const who = (editing[key] ?? []).map((id) => agents[id]?.title ?? 'An agent');
          return (
            <li key={key} className="rounded-lg border border-line-2 bg-panel overflow-hidden">
              <div className="flex items-center gap-2 px-3 py-2 border-b border-line-2">
                <Checkbox
                  checked={Boolean(checked[key])}
                  onChange={(v) => setChecked((c) => ({ ...c, [key]: v }))}
                  label={<span className="font-mono text-[12px] text-ink">{i.file.path}</span>}
                />
                <span className="flex-1" />
                <span className="text-[11.5px] text-ink-3 whitespace-nowrap">
                  {rootLabel(i.file.root)} · {i.matches.length} {i.matches.length === 1 ? 'match' : 'matches'}
                </span>
              </div>
              {who.length > 0 && (
                <div role="note" className="flex items-start gap-2 mx-3 mt-2 px-2.5 py-2 rounded-sm border border-warn-line bg-warn-bg text-[12px] text-[#EBDDBF] leading-[1.45]">
                  <Icon name="warning" size={14} className="text-warn mt-px" />
                  <span>
                    <b>{who.join(', ')}</b> {who.length === 1 ? 'is' : 'are'} changing this file. Replacing here can clash with {who.length === 1 ? 'its' : 'their'} edits.
                  </span>
                </div>
              )}
              <div className="font-mono text-[12px] leading-5 py-1.5" aria-label={`Changes in ${i.file.path}`}>
                {diffs.get(key)!.map((d) => (
                  <div key={d.line}>
                    <DiffRow kind="del" line={d.line} segs={d.old} />
                    <DiffRow kind="add" line={d.line} segs={d.next} />
                  </div>
                ))}
              </div>
            </li>
          );
        })}
      </ul>
    </Dialog>
  );
}

function DiffRow({ kind, line, segs }: { kind: 'add' | 'del'; line: number; segs: Seg[] }) {
  const del = kind === 'del';
  return (
    <div data-kind={kind} className={`flex min-w-0 ${del ? 'bg-bad-bg' : 'bg-ok-bg'}`}>
      <span className="w-12 shrink-0 text-right pr-3 text-ink-3 select-none">{line}</span>
      <span aria-hidden="true" className={`w-4 shrink-0 select-none ${del ? 'text-bad' : 'text-ok'}`}>
        {del ? '−' : '+'}
      </span>
      <span className="sr-only">{del ? 'Before: ' : 'After: '}</span>
      <span className="flex-1 min-w-0 whitespace-pre overflow-hidden text-ellipsis pr-3 text-ink-2">
        {segs.map((s, i) =>
          s.hit && del ? (
            <span key={i} className="rounded-[2px] bg-bad-line text-bad-bright">
              {s.text}
            </span>
          ) : s.added ? (
            <span key={i} className="rounded-[2px] bg-ok-line text-ok-bright">
              {s.text}
            </span>
          ) : s.hit ? null : (
            <span key={i}>{s.text}</span>
          ),
        )}
      </span>
    </div>
  );
}
