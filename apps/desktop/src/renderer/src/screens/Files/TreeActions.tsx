/**
 * Files tree management: the right-click menu (New file / New folder, Cut / Copy / Paste, Copy path,
 * Reveal, Rename, Delete), the same actions from the keyboard, the inline name field and the delete
 * confirmation. State lives in `filesStore` (`edit`, `clipboard`); main does the work (`files.create`,
 * `files.rename`, `files.copy`, `files.delete`).
 */
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Button, Dialog, type ContextMenuEntry } from '@oide/ui';
import { ipcErrorMessage, isMac, oide } from '../../lib/bridge';
import { toast } from '../../stores/ui';
import { joinPath, useFiles, type TreeRow } from './filesStore';
import { baseName, isUnder, parentDir, stemLength, validateName } from './treeOps';

const mod = (key: string) => (isMac() ? `⌘${key}` : `Ctrl+${key}`);

const revealLabel = () => (isMac() ? 'Reveal in Finder' : oide.platform === 'win32' ? 'Reveal in File Explorer' : 'Open containing folder');
export const trashName = () => (isMac() ? 'Trash' : oide.platform === 'win32' ? 'Recycle Bin' : 'trash');

/** The folder a row's New / Paste goes into: the folder itself (its last compacted folder), or a file's folder. */
export const targetDir = (r?: TreeRow): string => (!r ? '' : r.kind === 'dir' ? r.contentPath : parentDir(r.path));
/** The entry a row's Rename / Delete / Copy acts on (a compacted folder chain: its last folder). */
const entryOf = (r: TreeRow) => r.contentPath;

async function copyText(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast(`Copied ${what}`, 'success', { duration: 2000 });
  } catch (err) {
    toast(`Couldn't copy ${what}: ${ipcErrorMessage(err)}`, 'error');
  }
}

export interface TreeActions {
  /** Context menu entries for a row, or for the checkout root when `row` is undefined. */
  menu(row?: TreeRow): ContextMenuEntry[];
  /** Tree keyboard shortcuts on a row; true when handled. */
  onKey(e: ReactKeyboardEvent, row: TreeRow): boolean;
  /** Row waiting for the delete confirmation. */
  confirming?: TreeRow;
  setConfirming(r?: TreeRow): void;
}

export function useTreeActions(projectId: string, root: string): TreeActions {
  const s = useFiles();
  const [confirming, setConfirming] = useState<TreeRow>();

  const newEntry = (r: TreeRow | undefined, kind: 'file' | 'dir') => s.startCreate(projectId, root, targetDir(r), kind, r?.kind === 'dir' ? r.path : undefined);
  const rename = (r: TreeRow) => s.startRename(projectId, root, entryOf(r), r.kind);
  const clip = (r: TreeRow, cut: boolean) => s.setClipboard({ root, path: entryOf(r), kind: r.kind, cut });
  const paste = async (r?: TreeRow) => {
    const res = await s.paste(projectId, root, targetDir(r));
    if (res.error) toast(`Couldn't paste: ${res.error}`, 'error');
  };
  const reveal = (rel: string) => {
    oide.invoke('shell.revealPath', { path: rel ? joinPath(root, rel) : root }).catch((err: unknown) => toast(ipcErrorMessage(err), 'error'));
  };

  const menu = (r?: TreeRow): ContextMenuEntry[] => {
    const rel = r ? entryOf(r) : '';
    const canPaste = !!s.clipboard;
    const items: ContextMenuEntry[] = [
      { id: 'new-file', label: 'New file…', icon: 'file-plus', onSelect: () => newEntry(r, 'file') },
      { id: 'new-folder', label: 'New folder…', icon: 'folder-plus', onSelect: () => newEntry(r, 'dir') },
      { id: 'sep-1', separator: true },
    ];
    if (r) {
      items.push(
        { id: 'cut', label: 'Cut', icon: 'scissors', hint: mod('X'), onSelect: () => clip(r, true) },
        { id: 'copy', label: 'Copy', icon: 'copy', hint: mod('C'), onSelect: () => clip(r, false) },
      );
    }
    items.push(
      {
        id: 'paste',
        label: 'Paste',
        icon: 'clipboard',
        hint: mod('V'),
        disabled: !canPaste,
        title: canPaste ? undefined : 'Copy or cut a file or folder first',
        onSelect: () => void paste(r),
      },
      { id: 'sep-2', separator: true },
      { id: 'copy-path', label: 'Copy path', icon: 'link', onSelect: () => void copyText(rel ? joinPath(root, rel) : root, 'path') },
    );
    if (r) items.push({ id: 'copy-rel', label: 'Copy relative path', onSelect: () => void copyText(rel, 'relative path') });
    items.push({ id: 'reveal', label: revealLabel(), icon: 'external-link', onSelect: () => reveal(rel) });
    if (r) {
      items.push(
        { id: 'sep-3', separator: true },
        { id: 'rename', label: 'Rename…', icon: 'pencil', hint: 'F2', onSelect: () => rename(r) },
        { id: 'delete', label: 'Delete', icon: 'trash', hint: isMac() ? '⌘⌫' : 'Del', danger: true, onSelect: () => setConfirming(r) },
      );
    }
    return items;
  };

  const onKey = (e: ReactKeyboardEvent, r: TreeRow): boolean => {
    if (r.draft) return false;
    const cmd = isMac() ? e.metaKey : e.ctrlKey;
    const k = e.key.toLowerCase();
    if (e.key === 'F2' && !cmd) rename(r);
    else if ((e.key === 'Delete' && !cmd) || (isMac() && e.metaKey && e.key === 'Backspace')) setConfirming(r);
    else if (cmd && !e.altKey && !e.shiftKey && k === 'c') clip(r, false);
    else if (cmd && !e.altKey && !e.shiftKey && k === 'x') clip(r, true);
    else if (cmd && !e.altKey && !e.shiftKey && k === 'v') void paste(r);
    else return false;
    return true;
  };

  return { menu, onKey, confirming, setConfirming };
}

/** Confirm before moving a file or folder to the trash (unsaved edits in its open tabs are lost). */
export function DeleteDialog({ root, row, onClose, onDeleted }: { root: string; row?: TreeRow; onClose: () => void; onDeleted: (r: TreeRow) => void }) {
  const s = useFiles();
  const [busy, setBusy] = useState(false);
  const path = row ? entryOf(row) : '';
  const name = baseName(path);
  const unsaved = row ? s.tabs.filter((t) => t.root === root && isUnder(t.path, path) && s.dirty[t.id]).length : 0;
  const what = row?.kind === 'dir' ? `The folder ${name} and everything in it` : name;
  return (
    <Dialog
      open={!!row}
      onClose={() => !busy && onClose()}
      title={`Delete ${name}?`}
      description={`${what} will be moved to the ${trashName()}.${unsaved ? ` Unsaved changes in ${unsaved} open ${unsaved === 1 ? 'file' : 'files'} will be lost.` : ''}`}
      footer={
        <>
          <Button size={32} disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            size={32}
            variant="danger"
            disabled={busy}
            onClick={async () => {
              if (!row) return;
              setBusy(true);
              const res = await s.deleteEntry(root, path);
              setBusy(false);
              if (res.error) toast(`Couldn't delete ${name}: ${res.error}`, 'error');
              else onDeleted(row);
              onClose();
            }}
          >
            Move to {trashName()}
          </Button>
        </>
      }
    />
  );
}

/**
 * The inline name field of a New file / New folder / Rename row. Enter commits, Esc cancels, leaving
 * the field commits a valid changed name (else cancels). Problems show under the field as you type.
 */
export function NameInput({ row, root, onDone }: { row: TreeRow; root: string; /** The field closed from the keyboard: focus goes back to the tree. */ onDone: () => void }) {
  const s = useFiles();
  const edit = s.edit;
  const renaming = edit?.mode === 'rename';
  const dir = edit ? (edit.mode === 'create' ? edit.dir : parentDir(edit.path)) : '';
  const initial = renaming ? baseName(edit.path) : '';
  const [value, setValue] = useState(initial);
  const [errorFor, setErrorFor] = useState<string>();
  const input = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  const siblings = (s.nodes[root]?.[dir] ?? []).map((n) => n.name);
  const problem = validateName(value, siblings, renaming ? initial : undefined) ?? (edit?.error && errorFor === value ? edit.error : undefined);
  const kind = edit?.kind ?? 'file';
  const msgId = `${row.key}-name-problem`;

  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.focus();
    if (initial) el.setSelectionRange(0, stemLength(initial, kind));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A refused name (taken meanwhile, a disk error) keeps the field open: show why and focus it again.
  useEffect(() => {
    if (!edit?.error) return;
    setErrorFor(value);
    done.current = false;
    input.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edit]);

  if (!edit) return null;

  const commit = async (viaKeyboard: boolean) => {
    if (done.current) return;
    const unchanged = renaming && value === initial;
    if (!value.trim() || unchanged) {
      done.current = true;
      s.cancelEdit();
      if (viaKeyboard) onDone();
      return;
    }
    if (problem) {
      if (!viaKeyboard) {
        done.current = true;
        s.cancelEdit();
      }
      return;
    }
    done.current = true;
    if (await s.commitEdit(value)) {
      if (viaKeyboard) onDone();
    }
  };

  const label = renaming ? `Rename ${initial}` : kind === 'dir' ? 'New folder name' : 'New file name';
  return (
    <span className="relative flex-1 min-w-0 ml-1.5 flex">
      <input
        ref={input}
        aria-label={label}
        aria-invalid={!!problem}
        aria-describedby={problem ? msgId : undefined}
        spellCheck={false}
        autoComplete="off"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') {
            e.preventDefault();
            void commit(true);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            done.current = true;
            s.cancelEdit();
            onDone();
          }
        }}
        onBlur={() => void commit(false)}
        className={`w-full min-w-0 h-[18px] px-1 -ml-1 rounded-none border bg-ground text-ink text-[13px] font-[inherit] outline-none ${problem ? 'border-bad' : 'border-accent'}`}
      />
      {problem && (
        <span id={msgId} role="alert" className="absolute left-[-4px] right-0 top-[19px] z-10 px-1.5 py-1 border border-bad bg-bad-bg text-ink text-[11.5px] leading-[1.35] whitespace-normal">
          {problem}
        </span>
      )}
    </span>
  );
}
