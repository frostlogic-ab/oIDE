/**
 * Dropping files on the Artifacts grid or the New artifact dialog. The page cannot read a dropped
 * file's path, so the files go through preload's `attachDropped` (the bridge prompt inputs use):
 * preload reads the real paths (at most 50), main registers them as picked, and each non-image file
 * comes back as `{ kind: 'file', path }`, which `artifacts.importFiles({ filePaths })` accepts.
 * Images come back inline (base64, no path), so the dialog adds them to the new artifact with
 * `artifacts.writeFiles` after it is created. Folders are refused by the bridge: "Choose a folder…"
 * takes a whole folder. No new IPC.
 */
import { useRef, useState, type DragEvent } from 'react';
import { isSafeArtifactPath, type ImageMediaType } from '@oide/protocol';
import { ipcErrorMessage } from '../../lib/bridge';

/** The most files preload passes on from one drop. */
export const MAX_DROPPED = 50;

export interface DroppedImage {
  name: string;
  mediaType: ImageMediaType;
  dataBase64: string;
}

export interface DroppedFiles {
  /** Files main registered as picked (by path). */
  files: Array<{ path: string; name: string }>;
  /** Images, inline (the bridge returns no path for them). */
  images: DroppedImage[];
  /** What could not be taken, one line each. */
  problems: string[];
}

export type DropResult = DroppedFiles | { error: string };

/** Resolves a drop to picked file paths and inline images, with a line for anything refused. */
export async function resolveDroppedFiles(files: readonly File[]): Promise<DropResult> {
  if (!files.length) return { error: 'Nothing to add: drop files from your computer.' };
  const bridge = typeof window !== 'undefined' ? window.oide : undefined;
  if (!bridge?.attachDropped) return { error: 'Dropping files needs the desktop app. Use Choose files… instead.' };
  try {
    const r = await bridge.attachDropped(files);
    const out: DroppedFiles = { files: [], images: [], problems: [] };
    for (const a of r.attachments) {
      if (a.kind === 'file') out.files.push({ path: a.path, name: a.name });
      else {
        const name = a.name ?? 'image.png';
        if (isSafeArtifactPath(name)) out.images.push({ name, mediaType: a.mediaType, dataBase64: a.dataBase64 });
        else out.problems.push(`${name}: not a name a file can have in an artifact.`);
      }
    }
    for (const x of r.rejected) {
      out.problems.push(/^Folders cannot be attached/.test(x.reason) ? `${x.name}: folders can't be dropped. Use Choose a folder… instead.` : `${x.name}: ${x.reason}`);
    }
    if (files.length > MAX_DROPPED) out.problems.push(`Only the first ${MAX_DROPPED} files were added. Choose a folder… takes more.`);
    if (!out.files.length && !out.images.length && !out.problems.length) return { error: "Those files couldn't be read from disk. Use Choose files… instead." };
    return out;
  } catch (err) {
    return { error: ipcErrorMessage(err) };
  }
}

const hasFiles = (e: DragEvent<HTMLElement>) => Array.from(e.dataTransfer?.types ?? []).includes('Files');

/** Drag-over state and handlers for a drop target that takes files. */
export function useFileDrop(onDrop: (result: DropResult) => void, disabled = false) {
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
        // The page's own drop handlers (the grid, the dialog) are nested: handle it once.
        e.stopPropagation();
        void resolveDroppedFiles(Array.from(e.dataTransfer.files)).then(onDrop);
      },
    },
  };
}
