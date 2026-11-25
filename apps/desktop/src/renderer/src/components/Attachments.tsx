import { useCallback, useRef, useState, type ClipboardEvent, type DragEvent } from 'react';
import { createPortal } from 'react-dom';
import type { MessageAttachment, PickedAttachments } from '@oide/protocol';
import { Dialog, Icon } from '@oide/ui';
import { attachmentBytes, attachmentName, formatSize, imageSrc, isImageType, readImage, rejectedMessages, withinLimits } from '../lib/attachments';
import { ipcErrorMessage, oide } from '../lib/bridge';

let nextKey = 0;

export interface AttachmentsState {
  items: Array<{ key: string; attachment: MessageAttachment }>;
  attachments: MessageAttachment[];
  /** The last refusal(s), shown under the input; cleared by the next add or remove. */
  error: string | null;
  dragging: boolean;
  busy: boolean;
  add(incoming: readonly MessageAttachment[], extraErrors?: string[]): void;
  /** Pasted or dropped files: images are read here, other files go through preload (main registers their paths). */
  addFiles(files: readonly File[]): Promise<void>;
  /** Attach file: the native multi-file picker (`dialog.pickFiles`). */
  pick(): Promise<void>;
  remove(key: string): void;
  clear(): void;
  dismissError(): void;
  onPaste(e: ClipboardEvent<HTMLElement>): void;
  dropProps: {
    onDragEnter(e: DragEvent<HTMLElement>): void;
    onDragOver(e: DragEvent<HTMLElement>): void;
    onDragLeave(e: DragEvent<HTMLElement>): void;
    onDrop(e: DragEvent<HTMLElement>): void;
  };
}

const hasFiles = (e: DragEvent<HTMLElement>) => Array.from(e.dataTransfer?.types ?? []).includes('Files');

/** Paste, drop and Attach file for one prompt input. */
export function useAttachments({ disabled = false }: { disabled?: boolean } = {}): AttachmentsState {
  const [items, setItems] = useState<AttachmentsState['items']>([]);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const depth = useRef(0);

  const add = useCallback((incoming: readonly MessageAttachment[], extraErrors: string[] = []) => {
    const { added, errors } = withinLimits(
      itemsRef.current.map((i) => i.attachment),
      incoming,
    );
    const next = [...itemsRef.current, ...added.map((attachment) => ({ key: `att-${++nextKey}`, attachment }))];
    itemsRef.current = next;
    setItems(next);
    const all = [...extraErrors, ...errors];
    setError(all.length ? all.join(' ') : null);
  }, []);

  const fromMain = useCallback((r: PickedAttachments) => add(r.attachments, rejectedMessages(r.rejected)), [add]);

  const addFiles = useCallback(
    async (files: readonly File[]) => {
      if (disabled || !files.length) return;
      setBusy(true);
      try {
        const images: MessageAttachment[] = [];
        const errors: string[] = [];
        const others: File[] = [];
        for (const f of files) {
          if (isImageType(f.type)) {
            try {
              images.push(await readImage(f));
            } catch (err) {
              errors.push((err as Error).message);
            }
          } else others.push(f);
        }
        let picked: PickedAttachments = { attachments: [], rejected: [] };
        if (others.length) {
          const bridge = typeof window !== 'undefined' ? window.oide : undefined;
          if (bridge?.attachDropped) picked = await bridge.attachDropped(others);
          else errors.push('Dropping files other than images needs the desktop app; use Attach file instead.');
          // A File without a path (made by the page, or a virtual file) is skipped by preload.
          const missing = others.length - picked.attachments.length - picked.rejected.length;
          if (bridge?.attachDropped && missing > 0) errors.push(`${missing === 1 ? 'One item' : `${missing} items`} could not be attached (not a file on this computer).`);
        }
        add([...images, ...picked.attachments], [...errors, ...rejectedMessages(picked.rejected)]);
      } catch (err) {
        setError(ipcErrorMessage(err));
      } finally {
        setBusy(false);
      }
    },
    [add, disabled],
  );

  const pick = useCallback(async () => {
    if (disabled) return;
    setBusy(true);
    try {
      fromMain(await oide.invoke('dialog.pickFiles', { title: 'Attach files' }));
    } catch (err) {
      setError(`Could not attach: ${ipcErrorMessage(err)}`);
    } finally {
      setBusy(false);
    }
  }, [disabled, fromMain]);

  const remove = useCallback((key: string) => {
    const next = itemsRef.current.filter((i) => i.key !== key);
    itemsRef.current = next;
    setItems(next);
    setError(null);
  }, []);

  const clear = useCallback(() => {
    itemsRef.current = [];
    setItems([]);
    setError(null);
  }, []);

  const onPaste = (e: ClipboardEvent<HTMLElement>) => {
    const files = Array.from(e.clipboardData?.files ?? []);
    if (!files.length) return; // plain text paste: let the input handle it
    e.preventDefault();
    void addFiles(files);
  };

  const dropProps: AttachmentsState['dropProps'] = {
    onDragEnter: (e) => {
      if (disabled || !hasFiles(e)) return;
      e.preventDefault();
      depth.current++;
      setDragging(true);
    },
    onDragOver: (e) => {
      if (disabled || !hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    },
    onDragLeave: () => {
      depth.current = Math.max(0, depth.current - 1);
      if (!depth.current) setDragging(false);
    },
    onDrop: (e) => {
      depth.current = 0;
      setDragging(false);
      if (disabled || !hasFiles(e)) return;
      e.preventDefault();
      void addFiles(Array.from(e.dataTransfer.files));
    },
  };

  return {
    items,
    attachments: items.map((i) => i.attachment),
    error,
    dragging,
    busy,
    add,
    addFiles,
    pick,
    remove,
    clear,
    dismissError: () => setError(null),
    onPaste,
    dropProps,
  };
}

/** Paperclip button that opens the native picker. `pill`: the Spawn context row's dashed "Attach file" pill. */
export function AttachFileButton({ state, disabled, size = 30, variant = 'icon' }: { state: AttachmentsState; disabled?: boolean; size?: 28 | 30; variant?: 'icon' | 'pill' }) {
  const common = 'shrink-0 inline-flex items-center justify-center bg-transparent text-ink-2 hover:text-ink disabled:opacity-50';
  return (
    <button
      type="button"
      aria-label={variant === 'icon' ? 'Attach file' : undefined}
      title="Attach file (or paste a screenshot, or drop files here)"
      disabled={disabled || state.busy}
      onClick={() => void state.pick()}
      className={
        variant === 'pill'
          ? `${common} h-[26px] gap-1.5 px-2.5 rounded-[13px] border border-dashed border-line-hover text-[12px] hover:border-ink-4`
          : `${common} rounded-[7px] border border-line-3 hover:bg-raised ${size === 30 ? 'w-[30px] h-[30px]' : 'w-7 h-7'}`
      }
    >
      <Icon name="paperclip" size={variant === 'pill' ? 13 : 15} />
      {variant === 'pill' && 'Attach file'}
    </button>
  );
}

/**
 * Removable chips for pending attachments: a thumbnail for images, a file icon otherwise, with the
 * name (truncated, full name in the tooltip) and the size. `compact` is the Wall tile's one-line row.
 */
export function AttachmentTray({ state, compact = false, className }: { state: AttachmentsState; compact?: boolean; className?: string }) {
  if (!state.items.length && !state.error) return null;
  return (
    <div className={`flex flex-col gap-1 min-w-0 ${className ?? ''}`}>
      {state.items.length > 0 && (
        <ul aria-label="Attachments" className={`flex gap-1.5 min-w-0 list-none m-0 p-0 ${compact ? 'flex-nowrap overflow-x-auto' : 'flex-wrap'}`}>
          {state.items.map(({ key, attachment: a }) => {
            const name = attachmentName(a);
            const size = formatSize(attachmentBytes(a));
            return (
              <li key={key} title={a.kind === 'file' ? `${name} · ${size} · ${a.path}` : `${name} · ${size}`} className={`shrink-0 inline-flex items-center gap-1.5 rounded-[8px] border border-line-3 bg-raised pl-1 pr-0.5 ${compact ? 'h-6 max-w-[160px]' : 'h-[30px] max-w-[240px]'}`}>
                {a.kind === 'image' ? (
                  <img src={imageSrc(a)} alt="" className={`${compact ? 'w-4 h-4' : 'w-[22px] h-[22px]'} rounded-[4px] object-cover bg-chrome`} />
                ) : (
                  <Icon name="file" size={compact ? 12 : 14} className="text-ink-3 mx-0.5" />
                )}
                <span className={`min-w-0 truncate text-ink ${compact ? 'text-[11px]' : 'text-[12px]'}`}>{name}</span>
                {!compact && <span className="shrink-0 font-mono text-[11px] text-ink-3">{size}</span>}
                <button
                  type="button"
                  aria-label={`Remove ${name}`}
                  onClick={() => state.remove(key)}
                  className="shrink-0 w-5 h-5 inline-flex items-center justify-center rounded-full border-0 bg-transparent text-ink-3 hover:text-ink hover:bg-selected"
                >
                  <Icon name="close" size={11} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {state.error && (
        <div role="alert" className="flex items-start gap-1.5 text-[12px] leading-[1.4] text-bad">
          <Icon name="alert-circle" size={13} className="mt-px shrink-0" />
          <span className="min-w-0 flex-1">{state.error}</span>
          <button type="button" aria-label="Dismiss" onClick={state.dismissError} className="shrink-0 w-4 h-4 inline-flex items-center justify-center border-0 bg-transparent text-bad hover:text-ink">
            <Icon name="close" size={10} />
          </button>
        </div>
      )}
    </div>
  );
}

/** Thumbnails and file chips under a sent user message (Focus transcript); images open larger on click. */
export function MessageAttachments({ attachments }: { attachments: readonly MessageAttachment[] }) {
  const [open, setOpen] = useState<number | null>(null);
  const shown = open !== null ? attachments[open] : undefined;
  return (
    <div className="flex flex-wrap items-end justify-end gap-1.5">
      {attachments.map((a, i) =>
        a.kind === 'image' ? (
          <button
            key={i}
            type="button"
            aria-label={`Open ${attachmentName(a)}`}
            title={`${attachmentName(a)} · ${formatSize(attachmentBytes(a))}`}
            onClick={() => setOpen(i)}
            className="p-0 border border-line-3 rounded-[8px] overflow-hidden bg-chrome hover:border-line-hover cursor-zoom-in"
          >
            <img src={imageSrc(a)} alt={attachmentName(a)} className="block max-h-[120px] max-w-[200px] object-contain" />
          </button>
        ) : (
          <span key={i} title={a.path} className="inline-flex items-center gap-1.5 h-[26px] px-2 rounded-[8px] border border-line-3 bg-card text-[12px] text-ink-2 max-w-[260px]">
            <Icon name="file" size={13} className="text-ink-3 shrink-0" />
            <span className="truncate">{a.name}</span>
            <span className="shrink-0 font-mono text-[11px] text-ink-3">{formatSize(a.size)}</span>
          </span>
        ),
      )}
      {/* Portaled: transcript rows sit in a transformed (virtualized) list, which would clip a fixed dialog. */}
      {shown?.kind === 'image' &&
        createPortal(
          <Dialog open onClose={() => setOpen(null)} title={attachmentName(shown)} description={formatSize(attachmentBytes(shown))} width={960} showClose>
            <div className="flex justify-center">
              <img src={imageSrc(shown)} alt={attachmentName(shown)} className="max-w-full max-h-[70vh] object-contain rounded-[6px]" />
            </div>
          </Dialog>,
          document.body,
        )}
    </div>
  );
}
