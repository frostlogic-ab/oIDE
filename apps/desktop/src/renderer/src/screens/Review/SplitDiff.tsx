import { useEffect, useRef, useState } from 'react';
import { Spinner } from '@oide/ui';
import type { FileDiff } from '@oide/protocol';
import { oide } from '../../lib/bridge';
import { parseHunks, reverseApply, sidesFromHunks } from './diff';

type MonacoModule = typeof import('../Files/monaco/setup');

/**
 * Split view: Monaco's diff editor (lazy-loaded, read only). Whole files when the worktree copy can
 * be read (original = modified with the patch reverse-applied); otherwise both sides are rebuilt
 * from the hunks with blank padding so line numbers still match.
 */
export default function SplitDiff({ file, root }: { file: FileDiff; root?: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [partial, setPartial] = useState(false);

  useEffect(() => {
    let disposed = false;
    let cleanup = () => {};
    (async () => {
      try {
        const [m, sides] = await Promise.all([import('../Files/monaco/setup') as Promise<MonacoModule>, loadSides(file, root)]);
        if (disposed || !host.current) return;
        const { monaco, BASE_OPTIONS, languageFor } = m;
        const lang = languageFor(file.path);
        const original = monaco.editor.createModel(sides.original, lang);
        const modified = monaco.editor.createModel(sides.modified, lang);
        const editor = monaco.editor.createDiffEditor(host.current, {
          ...BASE_OPTIONS,
          readOnly: true,
          originalEditable: false,
          renderSideBySide: true,
          useInlineViewWhenSpaceIsLimited: false,
          renderOverviewRuler: false,
          hideUnchangedRegions: { enabled: true, contextLineCount: 3, minimumLineCount: 4, revealLineCount: 20 },
          ignoreTrimWhitespace: false,
          diffAlgorithm: 'advanced',
        });
        editor.setModel({ original, modified });
        setPartial(sides.partial);
        setState('ready');
        cleanup = () => {
          editor.dispose();
          original.dispose();
          modified.dispose();
        };
      } catch (err) {
        console.warn('[review] split view failed', err);
        if (!disposed) setState('error');
      }
    })();
    return () => {
      disposed = true;
      cleanup();
    };
  }, [file, root]);

  return (
    <div className="flex-1 min-h-0 flex flex-col relative">
      {partial && state === 'ready' && (
        <div className="px-5 py-1.5 text-[11.5px] text-ink-3 border-b border-line">Showing the changed parts only: the worktree copy of this file could not be read.</div>
      )}
      {state === 'loading' && (
        <div className="absolute inset-0 flex items-center justify-center">
          <Spinner label="Loading the split view" />
        </div>
      )}
      {state === 'error' && <div className="px-5 py-6 text-[12.5px] text-bad">The split view could not load. Switch back to Unified.</div>}
      <div ref={host} className="flex-1 min-h-0" data-testid="split-diff" />
    </div>
  );
}

async function loadSides(file: FileDiff, root: string | undefined): Promise<{ original: string; modified: string; partial: boolean }> {
  const hunks = parseHunks(file.patch);
  if (file.status === 'added') return { original: '', modified: hunks.flatMap((h) => h.lines.filter((l) => l.kind === 'add').map((l) => l.text)).join('\n') + '\n', partial: false };
  if (file.status === 'deleted') return { original: hunks.flatMap((h) => h.lines.filter((l) => l.kind === 'del').map((l) => l.text)).join('\n') + '\n', modified: '', partial: false };
  if (root) {
    try {
      const { content, binary } = await oide.invoke('files.read', { root, path: file.path });
      if (!binary) {
        const original = reverseApply(content, hunks);
        if (original !== undefined) return { original, modified: content, partial: false };
      }
    } catch {
      /* fall back to the hunks */
    }
  }
  return { ...sidesFromHunks(hunks), partial: true };
}
