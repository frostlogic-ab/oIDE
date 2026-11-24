/**
 * Monaco editor for artifact sources (Markdown docs, HTML designs). Reuses the Files screen's
 * Monaco setup (local package, `oide-dark` theme, inlined editor worker), imported lazily so Monaco
 * stays out of the Artifacts chunk until an editor opens. Ctrl/Cmd+S saves.
 *
 * `value` is controlled loosely: typing reports through `onChange`; a `value` that differs from the
 * model (another version loaded) replaces the model content.
 */
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Spinner } from '@oide/ui';

/**
 * Keys typed into an embedded editor stay there. Monaco types through an EditContext element (and
 * Excalidraw through its canvas), which the app keymap does not see as an editable target, so plain
 * keys (J, K, N, Esc) would otherwise also run app shortcuts. Chorded keys (Ctrl+K) still reach it.
 */
export function keepKeysInEditor(e: KeyboardEvent): void {
  if (!e.ctrlKey && !e.metaKey && !e.altKey) e.stopPropagation();
}

type MonacoModule = typeof import('../Files/monaco/setup');
type Editor = import('../Files/monaco/setup').monaco.editor.IStandaloneCodeEditor;

export interface SourceEditorProps {
  value: string;
  language: 'markdown' | 'html' | 'json';
  /** Accessible name of the editor ("Source of Webhook retry design"). */
  label: string;
  onChange: (value: string) => void;
  onSave: () => void;
  readOnly?: boolean;
}

export default function SourceEditor({
  value,
  language,
  label,
  onChange,
  onSave,
  readOnly,
}: SourceEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const editorRef = useRef<Editor | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const cb = useRef({ onChange, onSave, value });
  cb.current = { onChange, onSave, value };

  useEffect(() => {
    let disposed = false;
    let cleanup = () => {};
    (import('../Files/monaco/setup') as Promise<MonacoModule>)
      .then(({ monaco, BASE_OPTIONS }) => {
        if (disposed || !host.current) return;
        const model = monaco.editor.createModel(cb.current.value, language);
        const editor = monaco.editor.create(host.current, {
          ...BASE_OPTIONS,
          model,
          ariaLabel: label,
          readOnly: Boolean(readOnly),
          wordWrap: language === 'markdown' ? 'on' : 'off',
          lineNumbersMinChars: 3,
        });
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => cb.current.onSave());
        const sub = model.onDidChangeContent(() => cb.current.onChange(model.getValue()));
        editorRef.current = editor;
        setState('ready');
        cleanup = () => {
          sub.dispose();
          editor.dispose();
          model.dispose();
          editorRef.current = null;
        };
      })
      .catch((err) => {
        console.warn('[artifacts] editor failed to load', err);
        if (!disposed) setState('error');
      });
    return () => {
      disposed = true;
      cleanup();
    };
    // The editor is created once per language; label and readOnly are applied below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [language]);

  useEffect(() => {
    editorRef.current?.updateOptions({ ariaLabel: label, readOnly: Boolean(readOnly) });
  }, [label, readOnly]);

  useEffect(() => {
    const model = editorRef.current?.getModel();
    if (model && model.getValue() !== value) model.setValue(value);
  }, [value, state]);

  return (
    <div
      className="relative flex-1 min-w-0 min-h-0 rounded-lg border border-line-3 bg-ground overflow-hidden"
      onKeyDown={keepKeysInEditor}
    >
      {state === 'loading' && (
        <div className="absolute inset-0 flex items-center justify-center">
          <Spinner label="Loading the editor" />
        </div>
      )}
      {state === 'error' && <div className="p-4 text-[12.5px] text-bad">The editor could not load.</div>}
      <div ref={host} className="absolute inset-0" data-testid="artifact-source-editor" />
    </div>
  );
}
