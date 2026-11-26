import { useEffect, useRef, useState } from 'react';
import { Button, Checkbox, Dialog } from '@oide/ui';
import { ipcErrorMessage, oide } from '../../lib/bridge';
import { toast } from '../../stores/ui';
import { useGit } from './gitStore';

/**
 * "Revert…" on "Your changes on main": pick files → git.discard. Changed files go back to the last
 * commit, new files are deleted. Destructive, so Cancel has the initial focus.
 */
export function RevertDialog({
  open,
  onClose,
  projectId,
  projectName,
  branch,
  files,
}: {
  open: boolean;
  onClose: () => void;
  projectId: string;
  projectName: string;
  branch: string;
  files: string[];
}) {
  const [picked, setPicked] = useState<Set<string>>(() => new Set(files));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const filesKey = files.join('\n');

  useEffect(() => {
    if (open) {
      setPicked(new Set(filesKey ? filesKey.split('\n') : []));
      setError(undefined);
    }
  }, [open, filesKey]);

  const all = picked.size === files.length;

  const submit = async () => {
    if (!picked.size) return;
    setBusy(true);
    setError(undefined);
    try {
      const r = await oide.invoke('git.discard', { projectId, files: all ? undefined : [...picked] });
      toast(`Reverted ${r.reverted} ${r.reverted === 1 ? 'file' : 'files'} on ${branch}`, 'success');
      onClose();
    } catch (err) {
      setError(ipcErrorMessage(err));
    } finally {
      setBusy(false);
      void useGit.getState().load(projectId);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      width={480}
      title={`Revert changes on ${branch}?`}
      description={`In ${projectName}. Changed files go back to the last commit and new files are deleted. This can't be undone.`}
      initialFocus={cancelRef}
      footer={
        <>
          <Button ref={cancelRef} variant="secondary" size={32} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" size={32} disabled={busy || !picked.size} onClick={() => void submit()}>
            {busy ? 'Reverting…' : all ? `Revert ${files.length === 1 ? 'file' : `${files.length} files`}` : `Revert ${picked.size} of ${files.length}`}
          </Button>
        </>
      }
    >
      <fieldset className="m-0 p-0 border-0 flex flex-col gap-1.5 min-w-0">
        <legend className="text-[12px] font-semibold text-ink-2 mb-1.5 p-0">Files to revert</legend>
        <div className="flex flex-col gap-1 max-h-[220px] overflow-auto">
          {files.map((f) => (
            <Checkbox
              key={f}
              checked={picked.has(f)}
              onChange={(on) => {
                const next = new Set(picked);
                if (on) next.add(f);
                else next.delete(f);
                setPicked(next);
              }}
              label={<span className="font-mono text-[12px] text-ink-2 break-all">{f}</span>}
            />
          ))}
        </div>
      </fieldset>
      {error && (
        <p role="alert" className="mt-3 mb-0 text-[12px] text-bad">
          {error}
        </p>
      )}
    </Dialog>
  );
}
