/**
 * The single live Monaco editor of the Files screen (lazy chunk: Monaco loads only when a file is
 * opened). One model per open tab, view state kept per tab, Ctrl/Cmd+S saves through files.write.
 * Markdown tabs show the rendered page alone (`mdView` preview) or the source beside it (edit).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Spinner } from '@oide/ui';
import { ipcErrorMessage, oide } from '../../lib/bridge';
import { toast } from '../../stores/ui';
import { onTabsMoved, onTabsReloaded, useFiles, type FileTab } from './filesStore';
import { MarkdownPreview } from './MarkdownPreview';
import type { MarkdownView } from './markdownLinks';
import { BASE_OPTIONS, languageFor, languageLabel, monaco } from './monaco/setup';

export interface SelectionInfo {
  path: string;
  startLine: number;
  endLine: number;
  text: string;
}

export interface EditorStatus {
  line: number;
  column: number;
  language: string;
  dirty: boolean;
  saving: boolean;
  readOnly: boolean;
}

interface Entry {
  model: monaco.editor.ITextModel;
  saved: number;
  view?: monaco.editor.ICodeEditorViewState | null;
  readOnly: boolean;
}

/**
 * Module-level on purpose: the Files screen unmounts when you leave it, and unsaved edits must be
 * there when you come back. Entries are dropped only when their tab closes.
 */
const entries = new Map<string, Entry>();
const isDirty = (e: Entry) => e.model.getAlternativeVersionId() !== e.saved;

// A renamed or moved file keeps its model (and unsaved edits) under its tab's new id; saving then
// writes to the new path. The model's language follows the new name.
onTabsMoved((moves) => {
  const taken = moves.map((m) => [m, entries.get(m.from)] as const);
  for (const [m] of taken) entries.delete(m.from);
  for (const [m, e] of taken) {
    if (!e) continue;
    entries.set(m.to, e);
    const lang = languageFor(m.to.slice(m.to.indexOf('::') + 2));
    if (lang !== e.model.getLanguageId()) monaco.editor.setModelLanguage(e.model, lang);
  }
});

// Discard changes rewrote these files: their models take the content on disk (unsaved edits were
// warned about in the confirmation).
onTabsReloaded((ids) => {
  for (const id of ids) {
    const e = entries.get(id);
    if (!e) continue;
    const at = id.indexOf('::');
    oide
      .invoke('files.read', { root: id.slice(0, at), path: id.slice(at + 2) })
      .then(({ content, binary }) => {
        if (binary || entries.get(id) !== e || e.model.isDisposed()) return;
        if (e.model.getValue() !== content) e.model.setValue(content);
        e.saved = e.model.getAlternativeVersionId();
        useFiles.getState().setDirty(id, false);
      })
      .catch(() => {
        /* gone meanwhile: the tab shows the error when it is next opened */
      });
  }
});

function disposeClosed(open: Set<string>): void {
  for (const [id, e] of entries) {
    if (!open.has(id)) {
      e.model.dispose();
      entries.delete(id);
    }
  }
}
type LoadState = { state: 'loading' } | { state: 'ready' } | { state: 'binary' } | { state: 'error'; message: string };

export interface EditorPaneProps {
  tabs: FileTab[];
  active: FileTab;
  /** Reveal a line (and select a match) in tab `tabId`, once per `nonce`. Columns are 0-based. */
  reveal?: { tabId: string; line: number; column?: number; length?: number; nonce: number; focus?: boolean };
  onStatus(s: EditorStatus): void;
  onDirty(tabId: string, dirty: boolean): void;
  /** Selection toolbar: "Ask an agent about this". */
  onAsk(sel: SelectionInfo): void;
  /** Selection toolbar: "Send to <agent>" (shown when an agent is editing this file). */
  sendTo?: { label: string; run(sel: SelectionInfo): void };
  /** Imperative save hook for the tab bar's Save button. */
  saveRef?: { current: (() => Promise<void>) | null };
  /** Set for a Markdown tab: the rendered page alone, or the source and the page side by side. */
  mdView?: MarkdownView;
  /** A relative link in the Markdown preview: open this path of the active tab's checkout. */
  onOpenFile?(path: string): void;
}

/** Re-render the preview this long after the last keystroke. */
const PREVIEW_DEBOUNCE_MS = 150;

export default function EditorPane({ tabs, active, reveal, onStatus, onDirty, onAsk, sendTo, saveRef, mdView, onOpenFile }: EditorPaneProps) {
  const host = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const [load, setLoad] = useState<LoadState>({ state: 'loading' });
  const [selection, setSelection] = useState<(SelectionInfo & { top: number; left: number }) | null>(null);
  const [saving, setSaving] = useState(false);
  const cb = useRef({ onStatus, onDirty, onAsk });
  cb.current = { onStatus, onDirty, onAsk };
  const mdRef = useRef(mdView);
  mdRef.current = mdView;
  const previewRef = useRef<HTMLDivElement>(null);
  // Bumped (debounced) when the active model changes, so the preview re-reads it.
  const [rev, setRev] = useState(0);
  const revTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const showEditor = mdView !== 'preview';

  const status = (overrides: Partial<EditorStatus> = {}) => {
    const ed = editorRef.current;
    const e = entries.get(activeRef.current.id);
    const pos = ed?.getPosition();
    cb.current.onStatus({
      line: pos?.lineNumber ?? 1,
      column: pos?.column ?? 1,
      language: e ? languageLabel(e.model.getLanguageId()) : '',
      dirty: e ? isDirty(e) : false,
      saving,
      readOnly: e?.readOnly ?? false,
      ...overrides,
    });
  };

  const save = async () => {
    const tab = activeRef.current;
    const e = entries.get(tab.id);
    if (!e || e.readOnly) return;
    const version = e.model.getAlternativeVersionId();
    setSaving(true);
    status({ saving: true });
    try {
      await oide.invoke('files.write', { root: tab.root, path: tab.path, content: e.model.getValue() });
      e.saved = version;
      cb.current.onDirty(tab.id, isDirty(e));
      toast(`Saved ${tab.path}`, 'success', { duration: 2500 });
    } catch (err) {
      toast(`Couldn't save ${tab.path}: ${ipcErrorMessage(err)}`, 'error');
    } finally {
      setSaving(false);
      status({ saving: false });
    }
  };
  if (saveRef) saveRef.current = save;

  // Create the editor once.
  useEffect(() => {
    if (!host.current) return;
    const ed = monaco.editor.create(host.current, { ...BASE_OPTIONS, model: null });
    editorRef.current = ed;
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void save());
    ed.addAction({
      id: 'oide.askAgent',
      label: 'Ask an agent about this',
      contextMenuGroupId: 'navigation',
      contextMenuOrder: 0,
      run: (e) => {
        const sel = currentSelection(e, activeRef.current.path);
        if (sel) cb.current.onAsk(sel);
      },
    });
    const subs = [
      ed.onDidChangeCursorPosition(() => status()),
      ed.onDidChangeCursorSelection(() => {
        const sel = currentSelection(ed, activeRef.current.path);
        const s = ed.getSelection();
        if (!sel || !s || s.isEmpty()) return setSelection(null);
        const pos = ed.getScrolledVisiblePosition(s.getStartPosition());
        if (!pos) return setSelection(null);
        setSelection({ ...sel, top: Math.max(4, pos.top - 40), left: Math.max(8, pos.left) });
      }),
      ed.onDidScrollChange((ev) => {
        setSelection(null);
        // Side by side: the page follows the source, proportionally.
        const pv = previewRef.current;
        if (mdRef.current !== 'edit' || !pv || !ev.scrollTopChanged) return;
        const range = ed.getScrollHeight() - ed.getLayoutInfo().height;
        pv.scrollTop = range > 0 ? (ev.scrollTop / range) * (pv.scrollHeight - pv.clientHeight) : 0;
      }),
      ed.onDidChangeModelContent(() => {
        const e = entries.get(activeRef.current.id);
        if (e) cb.current.onDirty(activeRef.current.id, isDirty(e));
        status();
        if (mdRef.current) {
          clearTimeout(revTimer.current);
          revTimer.current = setTimeout(() => setRev((n) => n + 1), PREVIEW_DEBOUNCE_MS);
        }
      }),
    ];
    return () => {
      clearTimeout(revTimer.current);
      subs.forEach((d) => d.dispose());
      ed.dispose();
      editorRef.current = null;
      // Closing the last tab unmounts the pane before the effect below sees the new tab list: drop
      // the models of tabs that are gone, so reopening the file reads it fresh. Leaving the screen
      // keeps the tabs (and their unsaved edits).
      disposeClosed(new Set(useFiles.getState().tabs.map((t) => t.id)));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Switch models when the active tab changes.
  useEffect(() => {
    const ed = editorRef.current;
    if (!ed) return;
    let cancelled = false;
    const prev = ed.getModel();
    if (prev) {
      for (const e of entries.values()) if (e.model === prev) e.view = ed.saveViewState();
    }
    setSelection(null);
    const show = (e: Entry) => {
      ed.setModel(e.model);
      ed.updateOptions({ readOnly: e.readOnly });
      if (e.view) ed.restoreViewState(e.view);
      setLoad({ state: 'ready' });
      setRev((n) => n + 1);
      cb.current.onDirty(active.id, isDirty(e));
      status();
    };
    const have = entries.get(active.id);
    if (have) {
      show(have);
      return;
    }
    ed.setModel(null);
    setLoad({ state: 'loading' });
    oide
      .invoke('files.read', { root: active.root, path: active.path })
      .then(({ content, binary }) => {
        if (cancelled) return;
        if (binary) {
          setLoad({ state: 'binary' });
          return;
        }
        let uri = monaco.Uri.from({ scheme: 'oide', path: `/${encodeURIComponent(active.root)}/${active.path}` });
        const existing = monaco.editor.getModel(uri);
        // A renamed tab keeps its model under the old URI: a new file at that path needs its own.
        const owned = existing && [...entries.values()].some((x) => x.model === existing);
        if (owned) uri = uri.with({ query: `n=${Date.now()}` });
        const model = (!owned && existing) || monaco.editor.createModel(content, languageFor(active.path), uri);
        const e: Entry = { model, saved: model.getAlternativeVersionId(), readOnly: content.length > 5_000_000 };
        entries.set(active.id, e);
        show(e);
      })
      .catch((err: unknown) => !cancelled && setLoad({ state: 'error', message: ipcErrorMessage(err) }));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active.id]);

  // Reveal a line (Review "Open in editor", quick open "file.ts:42", a search result), once each.
  const revealed = useRef<number>(undefined);
  useEffect(() => {
    const ed = editorRef.current;
    if (!ed || !reveal || reveal.tabId !== active.id || revealed.current === reveal.nonce || load.state !== 'ready' || !showEditor) return;
    revealed.current = reveal.nonce;
    ed.layout(); // it may have just been shown (preview → edit): measure before centring the line
    const lineNumber = Math.max(1, Math.min(reveal.line, ed.getModel()?.getLineCount() ?? reveal.line));
    const startColumn = (reveal.column ?? 0) + 1;
    ed.revealLineInCenter(lineNumber);
    if (reveal.length) ed.setSelection({ startLineNumber: lineNumber, startColumn, endLineNumber: lineNumber, endColumn: startColumn + reveal.length });
    else ed.setPosition({ lineNumber, column: startColumn });
    if (reveal.focus) ed.focus();
  }, [reveal, load.state, active.id, showEditor]);

  // Leaving the preview: lay the editor out at once (its ResizeObserver fires a frame later).
  useEffect(() => {
    if (showEditor) editorRef.current?.layout();
  }, [showEditor, mdView]);

  const previewSource = useMemo(
    () => (mdView && load.state === 'ready' ? (entries.get(active.id)?.model.getValue() ?? '') : ''),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rev, active.id, load.state, Boolean(mdView)],
  );

  // Dispose models of closed tabs, and (on mount too) report every open tab's dirty state from its
  // model, so the tab dots and close warnings match the editor after coming back to Files.
  const openIds = tabs.map((t) => t.id).join('\n');
  useEffect(() => {
    const open = new Set(openIds.split('\n'));
    disposeClosed(open);
    for (const id of open) {
      const e = entries.get(id);
      cb.current.onDirty(id, e ? isDirty(e) : false);
    }
  }, [openIds]);

  return (
    <div className="relative flex-1 min-h-0 flex">
      <div
        ref={host}
        className={showEditor ? 'flex-1 min-w-0 min-h-0' : 'hidden'}
        data-testid="monaco-host"
        style={{ visibility: load.state === 'ready' ? 'visible' : 'hidden' }}
      />
      {mdView && load.state === 'ready' && (
        <MarkdownPreview
          source={previewSource}
          path={active.path}
          onOpenFile={(p: string) => onOpenFile?.(p)}
          scrollRef={previewRef}
          className={`flex-1 min-w-0 ${mdView === 'edit' ? 'border-l border-line' : ''}`}
        />
      )}
      {load.state === 'loading' && (
        <div className="absolute inset-0 flex items-center justify-center">
          <Spinner label={`Opening ${active.path}`} />
        </div>
      )}
      {load.state === 'binary' && <div className="absolute inset-0 px-5 py-6 text-[12.5px] text-ink-3">This is a binary file. oIDE does not edit binary files.</div>}
      {load.state === 'error' && (
        <div role="alert" className="absolute inset-0 px-5 py-6 text-[12.5px] text-bad">
          Couldn't open {active.path}: {load.message}
        </div>
      )}
      {selection && load.state === 'ready' && showEditor && (
        <div
          className="absolute z-10 flex gap-1 p-1 rounded-[9px] bg-card border border-line-3 shadow-[0_8px_24px_rgba(0,0,0,0.45)] font-sans"
          style={{ top: selection.top, left: selection.left }}
          role="toolbar"
          aria-label="Selection actions"
        >
          <button
            type="button"
            className="h-7 px-2.5 rounded-sm bg-accent text-on-accent font-semibold text-[12px] border-0 cursor-pointer hover:brightness-110"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => cb.current.onAsk(selection)}
          >
            Ask an agent about this
          </button>
          {sendTo && (
            <button
              type="button"
              className="h-7 px-2.5 rounded-sm bg-transparent text-ink text-[12px] border-0 cursor-pointer hover:bg-raised"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => sendTo.run(selection)}
            >
              {sendTo.label}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function currentSelection(ed: monaco.editor.ICodeEditor, path: string): SelectionInfo | null {
  const model = ed.getModel();
  const s = ed.getSelection();
  if (!model || !s) return null;
  const startLine = s.startLineNumber;
  const endLine = s.endColumn === 1 && s.endLineNumber > s.startLineNumber ? s.endLineNumber - 1 : s.endLineNumber;
  return { path, startLine, endLine, text: s.isEmpty() ? '' : model.getValueInRange(s) };
}
