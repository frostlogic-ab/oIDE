/**
 * Dropping one file on the Artifacts screen or the Import dialog. The page cannot read a dropped
 * file's path, so the file goes through preload's `attachDropped` (the bridge Attachments uses):
 * preload reads the real path, main registers it as picked, and a non-image file comes back as
 * `{ kind: 'file', path }`. That path is what `artifacts.import({ filePath })` accepts. No new IPC.
 */
import { useRef, useState, type DragEvent } from 'react';
import { rejectedMessages } from '../../lib/attachments';
import { ipcErrorMessage } from '../../lib/bridge';

export type DroppedFile = { path: string; name: string } | { error: string };

/** Resolves a drop to a picked file path, or a short message for the user. */
export async function resolveDroppedFiles(files: readonly File[]): Promise<DroppedFile> {
  if (files.length !== 1) return { error: 'Drop one file at a time.' };
  const bridge = typeof window !== 'undefined' ? window.oide : undefined;
  if (!bridge?.attachDropped) return { error: 'Dropping a file needs the desktop app. Use Choose a file instead.' };
  try {
    const r = await bridge.attachDropped(files);
    const file = r.attachments.find((a) => a.kind === 'file');
    if (file && file.kind === 'file') return { path: file.path, name: file.name };
    if (r.rejected.length) return { error: rejectedMessages(r.rejected).join(' ') };
    // Images come back inline (no path), and a file the page made itself has no path at all.
    if (r.attachments.length) return { error: "Images can't be imported as artifacts. Drop an .html, .jsx, .svg, .md or .excalidraw file." };
    return { error: "That file couldn't be read from disk. Use Choose a file instead." };
  } catch (err) {
    return { error: ipcErrorMessage(err) };
  }
}

const hasFiles = (e: DragEvent<HTMLElement>) => Array.from(e.dataTransfer?.types ?? []).includes('Files');

/** Drag-over state and handlers for a drop target that takes one file. */
export function useFileDrop(onFile: (file: DroppedFile) => void, disabled = false) {
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);
  return {
    dragging,
    dropProps: {
      onDragEnter: (e: DragEvent<HTMLElement>) => {
        if (disabled || !hasFiles(e)) return;
        e.preventDefault();
        depth.current++;
        setDragging(true);
      },
      onDragOver: (e: DragEvent<HTMLElement>) => {
        if (disabled || !hasFiles(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      },
      onDragLeave: () => {
        depth.current = Math.max(0, depth.current - 1);
        if (!depth.current) setDragging(false);
      },
      onDrop: (e: DragEvent<HTMLElement>) => {
        depth.current = 0;
        setDragging(false);
        if (disabled || !hasFiles(e)) return;
        e.preventDefault();
        void resolveDroppedFiles(Array.from(e.dataTransfer.files)).then(onFile);
      },
    },
  };
}
