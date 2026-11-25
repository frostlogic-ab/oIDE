import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Icon, IconButton, SectionLabel, SegmentedControl, Spinner, cn } from '@oide/ui';
import { buildSearchRegExp, type ContentFileResult, type ContentMatch, type Project, type ReplaceFileResult } from '@oide/protocol';
import { oide } from '../../lib/bridge';
import { toast } from '../../stores/ui';
import { ReplaceDialog, type ReplaceItem } from './ReplaceDialog';
import { matchSegments, resultSummary } from './searchModel';
import { MAX_RESULTS, matchCount, resultKey, useSearch, type SearchScope } from './searchStore';

export interface SearchCheckout {
  project: Project;
  /** The checkout shown for the project (project folder or an agent worktree). */
  root: string;
  /** "main" or the worktree's short branch. */
  label: string;
}

/**
 * Files › Search (Ctrl/Cmd+Shift+F): query with match case / whole word / regex, include and
 * exclude globs, scope (the current project's checkout or every project in scope), results grouped
 * by file with highlighted previews, and Replace / Replace all through a confirm with a preview.
 */
export function SearchPanel({
  checkouts,
  currentProjectId,
  onOpen,
  onClose,
}: {
  checkouts: SearchCheckout[];
  currentProjectId?: string;
  onOpen(root: string, path: string, match?: ContentMatch): void;
  onClose(): void;
}) {
  const s = useSearch();
  const inputRef = useRef<HTMLInputElement>(null);
  const [confirm, setConfirm] = useState<ReplaceItem[] | null>(null);
  const current = checkouts.find((c) => c.project.id === currentProjectId) ?? checkouts[0];
  const multi = checkouts.length > 1;
  const roots = !multi || s.scope === 'checkout' ? (current ? [current.root] : []) : checkouts.map((c) => c.root);
  const rootsKey = roots.join('\n');
  const labelOf = useMemo(() => {
    const m = new Map(checkouts.map((c) => [c.root, c.label === 'main' ? c.project.name : `${c.project.name} · ${c.label}`]));
    return (root: string) => m.get(root) ?? root;
  }, [checkouts]);

  const regexError = useMemo(() => {
    if (!s.isRegex || !s.query) return undefined;
    try {
      buildSearchRegExp({ query: s.query, isRegex: true, matchCase: s.matchCase, wholeWord: s.wholeWord });
      return undefined;
    } catch (err) {
      return (err as Error).message.replace(/^Invalid regular expression: /, '');
    }
  }, [s.query, s.isRegex, s.matchCase, s.wholeWord]);

  useEffect(() => oide.on('files.searchResults', (e) => useSearch.getState().onBatch(e)), []);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [s.focusNonce]);

  // Search as you type (debounced) and whenever the options or the scope change.
  useEffect(() => {
    if (regexError) return;
    const t = setTimeout(() => void useSearch.getState().run(rootsKey ? rootsKey.split('\n') : []), 250);
    return () => clearTimeout(t);
  }, [s.query, s.isRegex, s.matchCase, s.wholeWord, s.include, s.exclude, rootsKey, regexError]);

  const runNow = () => {
    if (!regexError) void s.run(roots);
  };
  const onFieldKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      runNow();
    } else if (e.key === 'Escape' && s.status === 'searching') {
      e.preventDefault();
      s.cancel();
    }
  };

  const total = matchCount(s.files);
  const ran = s.ran ?? { query: s.query, isRegex: s.isRegex, matchCase: s.matchCase, wholeWord: s.wholeWord };
  const replacing = s.replaceOpen;
  const canReplace = replacing && s.status !== 'searching' && total > 0 && Boolean(s.ran);

  const done = (results: ReplaceFileResult[]) => {
    setConfirm(null);
    const replaced = results.filter((r) => r.status === 'replaced');
    const n = replaced.reduce((k, r) => k + r.replaced, 0);
    const stale = results.filter((r) => r.status === 'stale');
    const failed = results.filter((r) => r.status === 'failed');
    if (n) toast(`Replaced ${n} ${n === 1 ? 'match' : 'matches'} in ${replaced.length} ${replaced.length === 1 ? 'file' : 'files'}`, 'success');
    if (stale.length) toast(`${stale.length === 1 ? `${stale[0]!.path} changed` : `${stale.length} files changed`} since the search and ${stale.length === 1 ? 'was' : 'were'} left alone. Search again to replace there.`, 'warning');
    if (failed.length) toast(`Couldn't replace in ${failed.map((f) => f.path).join(', ')}: ${failed[0]!.message ?? 'failed'}`, 'error');
    runNow();
  };

  return (
    <aside aria-label="Search" className="flex-[0_0_300px] w-[300px] flex flex-col bg-panel border-r border-line box-border min-h-0">
      <div className="flex items-center gap-1 h-10 px-3 shrink-0">
        <SectionLabel as="h2" className="flex-1">
          Search
        </SectionLabel>
        <IconButton icon="close" aria-label="Close search" title="Close search" onClick={onClose} />
      </div>

      <div className="flex flex-col gap-2 px-3 pb-3 shrink-0 border-b border-line">
        <div className="flex items-start gap-1">
          <button
            type="button"
            aria-label="Toggle replace"
            aria-expanded={replacing}
            title="Toggle replace"
            onClick={() => s.update({ replaceOpen: !replacing })}
            className="w-5 h-7 shrink-0 flex items-center justify-center rounded-xs border-0 bg-transparent text-ink-3 cursor-pointer hover:bg-raised hover:text-ink"
          >
            <Icon name={replacing ? 'chevron-down' : 'chevron-right'} size={14} />
          </button>
          <div className="flex-1 min-w-0 flex flex-col gap-1.5">
            <Field invalid={Boolean(regexError)}>
              <input
                ref={inputRef}
                type="text"
                aria-label="Search text"
                aria-invalid={regexError ? true : undefined}
                placeholder="Search"
                spellCheck={false}
                value={s.query}
                onChange={(e) => s.update({ query: e.target.value })}
                onKeyDown={onFieldKey}
                className="flex-1 min-w-0 h-full bg-transparent border-0 outline-none pl-2 text-[12.5px] text-ink placeholder:text-ink-3"
              />
              <Toggle label="Match case" pressed={s.matchCase} onClick={() => s.update({ matchCase: !s.matchCase })}>
                Aa
              </Toggle>
              <Toggle label="Match whole word" pressed={s.wholeWord} onClick={() => s.update({ wholeWord: !s.wholeWord })}>
                <span className="underline underline-offset-2">ab</span>
              </Toggle>
              <Toggle label="Use regular expression" pressed={s.isRegex} onClick={() => s.update({ isRegex: !s.isRegex })}>
                .*
              </Toggle>
            </Field>
            {replacing && (
              <div className="flex items-center gap-1">
                <Field>
                  <input
                    type="text"
                    aria-label="Replace with"
                    placeholder="Replace"
                    spellCheck={false}
                    value={s.replacement}
                    onChange={(e) => s.update({ replacement: e.target.value })}
                    className="flex-1 min-w-0 h-full bg-transparent border-0 outline-none px-2 text-[12.5px] text-ink placeholder:text-ink-3"
                  />
                </Field>
                <IconButton
                  icon="replace-all"
                  aria-label="Replace all"
                  title={s.isRegex ? 'Replace all ($1, $<name> and $& refer to the match)' : 'Replace all'}
                  disabled={!canReplace}
                  onClick={() => setConfirm(s.files.map((file) => ({ file, matches: file.matches })))}
                />
              </div>
            )}
          </div>
        </div>

        {multi && (
          <div className="flex items-center gap-2 pl-6">
            <span className="text-[11.5px] text-ink-3 shrink-0">Search in</span>
            <SegmentedControl<SearchScope>
              label="Search in"
              variant="inset"
              value={s.scope}
              onChange={(scope) => s.update({ scope })}
              options={[
                { value: 'checkout', label: <span className="block max-w-[92px] truncate">{current ? labelOf(current.root) : 'This project'}</span> },
                { value: 'all', label: `All ${checkouts.length} projects` },
              ]}
            />
          </div>
        )}

        <div className="pl-6 flex flex-col gap-1.5">
          <button
            type="button"
            aria-expanded={s.filtersOpen}
            onClick={() => s.update({ filtersOpen: !s.filtersOpen })}
            className="self-start flex items-center gap-1 h-6 px-1 -ml-1 rounded-xs border-0 bg-transparent text-[11.5px] text-ink-3 cursor-pointer hover:text-ink"
          >
            <Icon name={s.filtersOpen ? 'chevron-down' : 'chevron-right'} size={12} />
            Files to include and exclude
            {!s.filtersOpen && (s.include || s.exclude) && <span className="text-accent">· on</span>}
          </button>
          {s.filtersOpen && (
            <>
              <GlobField label="Files to include" placeholder="e.g. src/**, *.ts" value={s.include} onChange={(include) => s.update({ include })} onKeyDown={onFieldKey} />
              <GlobField label="Files to exclude" placeholder="e.g. dist, **/*.test.ts" value={s.exclude} onChange={(exclude) => s.update({ exclude })} onKeyDown={onFieldKey} />
            </>
          )}
        </div>

        <div aria-live="polite" className="pl-6 min-h-4 flex items-center gap-2 text-[11.5px] text-ink-3">
          {regexError ? (
            <span className="text-bad">Invalid regular expression: {regexError}</span>
          ) : s.status === 'searching' ? (
            <>
              <Spinner size={12} label="Searching" />
              <span>Searching… {total > 0 && resultSummary(total, s.files.length)}</span>
              <button type="button" onClick={() => s.cancel()} className="ml-auto border-0 bg-transparent p-0 text-[11.5px] text-link underline underline-offset-2 cursor-pointer">
                Cancel
              </button>
            </>
          ) : s.status === 'error' ? (
            <span className="text-bad">{s.error}</span>
          ) : s.status === 'done' ? (
            <span>
              {total === 0 ? 'No results.' : resultSummary(total, s.files.length)}
              {s.truncated && ` Showing the first ${MAX_RESULTS.toLocaleString('en-US')}; narrow the search to see more.`}
            </span>
          ) : null}
        </div>
      </div>

      <ul aria-label="Search results" className="flex-1 min-h-0 overflow-auto list-none m-0 px-2 py-2">
        {s.files.map((f) => (
          <FileGroup
            key={resultKey(f)}
            file={f}
            rootLabel={multi && s.scope === 'all' ? labelOf(f.root) : undefined}
            collapsed={Boolean(s.collapsed[resultKey(f)])}
            onToggle={() => s.toggleCollapsed(resultKey(f))}
            onOpen={(m) => onOpen(f.root, f.path, m)}
            replace={replacing ? { options: ran, replacement: s.replacement, enabled: canReplace } : undefined}
            onReplace={(matches) => setConfirm([{ file: f, matches }])}
          />
        ))}
      </ul>

      {confirm && (
        <ReplaceDialog items={confirm} options={ran} replacement={s.replacement} rootLabel={labelOf} onClose={() => setConfirm(null)} onDone={done} />
      )}
    </aside>
  );
}

function Field({ invalid, children }: { invalid?: boolean; children: ReactNode }) {
  return (
    <div className={cn('flex-1 min-w-0 flex items-center gap-0.5 h-7 pr-0.5 rounded-sm border bg-chrome focus-within:border-accent', invalid ? 'border-bad-line' : 'border-line-3')}>
      {children}
    </div>
  );
}

function Toggle({ label, pressed, onClick, children }: { label: string; pressed: boolean; onClick(): void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      title={label}
      onClick={onClick}
      className={cn(
        'w-[22px] h-[22px] shrink-0 flex items-center justify-center rounded-xs border font-mono text-[11px] cursor-pointer',
        pressed ? 'bg-selected border-accent text-ink' : 'bg-transparent border-transparent text-ink-3 hover:bg-raised hover:text-ink',
      )}
    >
      {children}
    </button>
  );
}

function GlobField({ label, placeholder, value, onChange, onKeyDown }: { label: string; placeholder: string; value: string; onChange(v: string): void; onKeyDown(e: KeyboardEvent<HTMLInputElement>): void }) {
  return (
    <label className="flex flex-col gap-1 text-[11.5px] text-ink-3">
      {label}
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        className="h-7 px-2 rounded-sm border border-line-3 bg-chrome text-ink font-mono text-[11.5px] outline-none focus:border-accent placeholder:text-ink-3"
      />
    </label>
  );
}

function FileGroup({
  file,
  rootLabel,
  collapsed,
  onToggle,
  onOpen,
  replace,
  onReplace,
}: {
  file: ContentFileResult;
  rootLabel?: string;
  collapsed: boolean;
  onToggle(): void;
  onOpen(m?: ContentMatch): void;
  replace?: { options: { query: string; isRegex: boolean; matchCase: boolean; wholeWord: boolean }; replacement: string; enabled: boolean };
  onReplace(matches: ContentMatch[]): void;
}) {
  const slash = file.path.lastIndexOf('/');
  const name = file.path.slice(slash + 1);
  const dir = slash > 0 ? file.path.slice(0, slash) : '';
  return (
    <li className="flex flex-col">
      <div className="group flex items-center gap-1 h-[23px] rounded-[5px] hover:bg-raised">
        <button
          type="button"
          aria-expanded={!collapsed}
          onClick={onToggle}
          title={`${rootLabel ? `${rootLabel} › ` : ''}${file.path}`}
          className="flex-1 min-w-0 h-full flex items-center gap-1.5 pl-1 pr-1 border-0 bg-transparent text-left cursor-pointer"
        >
          <Icon name={collapsed ? 'chevron-right' : 'chevron-down'} size={12} className="text-ink-3" />
          <Icon name="file" size={13} className="text-ink-3" />
          <span className="text-[12px] text-ink whitespace-nowrap">{name}</span>
          <span className="min-w-0 truncate text-[11px] text-ink-3">{[rootLabel, dir].filter(Boolean).join(' · ')}</span>
        </button>
        {replace && (
          <IconButton
            icon="replace-all"
            aria-label={`Replace all in ${file.path}`}
            title="Replace all in this file"
            disabled={!replace.enabled}
            onClick={() => onReplace(file.matches)}
            className="opacity-0 group-hover:opacity-100 focus:opacity-100"
            size={28}
            iconSize={14}
            style={{ height: 22, width: 22 }}
          />
        )}
        <span className="shrink-0 min-w-[18px] h-4 px-1 mr-1 rounded-full bg-card border border-line-3 text-[10.5px] leading-[14px] text-center text-ink-2" aria-label={`${file.matches.length} matches`}>
          {file.matches.length}
        </span>
      </div>
      {!collapsed && (
        <ul aria-label={`Matches in ${file.path}`} className="list-none m-0 p-0">
          {file.matches.map((m) => (
            <li key={`${m.line}:${m.column}`} className="group flex items-center h-[23px] rounded-[5px] hover:bg-raised">
              <button
                type="button"
                onClick={() => onOpen(m)}
                title={`Line ${m.line}`}
                className="flex-1 min-w-0 h-full flex items-center gap-2 pl-7 pr-1 border-0 bg-transparent text-left cursor-pointer"
              >
                <span className="sr-only">
                  Line {m.line}: {m.text}
                </span>
                <span aria-hidden="true" className="font-mono text-[10.5px] text-ink-3 shrink-0 min-w-[22px] text-right">
                  {m.line}
                </span>
                <span aria-hidden="true" className="flex-1 min-w-0 truncate whitespace-pre font-mono text-[11.5px] text-ink-2">
                  {matchSegments(m, replace?.options, replace?.replacement).map((seg, i) =>
                    seg.hit ? (
                      <span key={i} className={cn('rounded-[2px] text-ink', replace ? 'bg-bad-line line-through decoration-bad' : 'bg-review-line')}>
                        {seg.text}
                      </span>
                    ) : seg.added ? (
                      <span key={i} className="rounded-[2px] bg-ok-line text-ok-bright">
                        {seg.text}
                      </span>
                    ) : (
                      <span key={i}>{seg.text}</span>
                    ),
                  )}
                </span>
              </button>
              {replace && (
                <IconButton
                  icon="replace"
                  aria-label={`Replace match at line ${m.line}, column ${m.column + 1} of ${file.path}`}
                  title="Replace"
                  disabled={!replace.enabled}
                  onClick={() => onReplace([m])}
                  className="opacity-0 group-hover:opacity-100 focus:opacity-100 mr-1"
                  size={28}
                  iconSize={14}
                  style={{ height: 22, width: 22 }}
                />
              )}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}
