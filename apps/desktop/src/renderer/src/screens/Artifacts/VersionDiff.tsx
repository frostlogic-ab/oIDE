/**
 * Side-by-side diff of two artifact versions: Monaco's diff editor (read only, lazy, the same
 * setup and theme as the Review split view). Reports added / removed line counts once computed.
 */
import { useEffect, useRef, useState } from 'react';
import { Spinner } from '@oide/ui';
import type { SourceLanguage } from './model';

type MonacoModule = typeof import('../Files/monaco/setup');
type Monaco = MonacoModule['monaco'];

export interface VersionDiffProps {
  original: string;
  modified: string;
  language: SourceLanguage;
  label: string;
  onStats?: (s: { additions: number; deletions: number }) => void;
}

export default function VersionDiff({ original, modified, language, label, onStats }: VersionDiffProps) {
  const host = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const editorRef = useRef<{
    monaco: Monaco;
    editor: import('../Files/monaco/setup').monaco.editor.IStandaloneDiffEditor;
  } | null>(null);
  const statsRef = useRef(onStats);
  statsRef.current = onStats;

  useEffect(() => {
    let disposed = false;
    let cleanup = () => {};
    (import('../Files/monaco/setup') as Promise<MonacoModule>)
      .then(({ monaco, BASE_OPTIONS }) => {
        if (disposed || !host.current) return;
        const editor = monaco.editor.createDiffEditor(host.current, {
          ...BASE_OPTIONS,
          readOnly: true,
          originalEditable: false,
          renderSideBySide: true,
          useInlineViewWhenSpaceIsLimited: false,
          renderOverviewRuler: false,
          ignoreTrimWhitespace: false,
          diffAlgorithm: 'advanced',
          wordWrap: language === 'markdown' ? 'on' : 'off',
          ariaLabel: label,
        });
        const sub = editor.onDidUpdateDiff(() => {
          let additions = 0;
          let deletions = 0;
          for (const c of editor.getLineChanges() ?? []) {
            if (c.modifiedEndLineNumber >= c.modifiedStartLineNumber && c.modifiedEndLineNumber > 0)
              additions += c.modifiedEndLineNumber - c.modifiedStartLineNumber + 1;
            if (c.originalEndLineNumber >= c.originalStartLineNumber && c.originalEndLineNumber > 0)
              deletions += c.originalEndLineNumber - c.originalStartLineNumber + 1;
          }
          statsRef.current?.({ additions, deletions });
        });
        editorRef.current = { monaco, editor };
        setState('ready');
        cleanup = () => {
          sub.dispose();
          const m = editor.getModel();
          editor.dispose();
          m?.original.dispose();
          m?.modified.dispose();
          editorRef.current = null;
        };
      })
      .catch((err) => {
        console.warn('[artifacts] diff failed to load', err);
        if (!disposed) setState('error');
      });
    return () => {
      disposed = true;
      cleanup();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [language]);

  useEffect(() => {
    const r = editorRef.current;
    if (!r) return;
    const prev = r.editor.getModel();
    r.editor.setModel({
      original: r.monaco.editor.createModel(original, language),
      modified: r.monaco.editor.createModel(modified, language),
    });
    prev?.original.dispose();
    prev?.modified.dispose();
  }, [original, modified, language, state]);

  return (
    <div className="relative flex-1 min-w-0 min-h-0 rounded-lg border border-line-3 bg-ground overflow-hidden">
      {state === 'loading' && (
        <div className="absolute inset-0 flex items-center justify-center">
          <Spinner label="Loading the comparison" />
        </div>
      )}
      {state === 'error' && <div className="p-4 text-[12.5px] text-bad">The comparison could not load.</div>}
      <div ref={host} className="absolute inset-0" data-testid="artifact-version-diff" />
    </div>
  );
}
