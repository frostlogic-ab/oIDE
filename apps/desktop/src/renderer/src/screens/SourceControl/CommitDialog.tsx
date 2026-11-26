import { useEffect, useRef, useState } from 'react';
import { Button, Checkbox, Dialog, TextArea } from '@oide/ui';
import { ipcErrorMessage, oide } from '../../lib/bridge';
import { toast } from '../../stores/ui';
import { useGit } from './gitStore';

/** "Commit…" on "Your changes on main": message + file selection → git.commit. */
export function CommitDialog({
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
  const [message, setMessage] = useState('');
  const [picked, setPicked] = useState<Set<string>>(() => new Set(files));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const messageRef = useRef<HTMLTextAreaElement>(null);
  const filesKey = files.join('\n');

  useEffect(() => {
    if (open) {
      setPicked(new Set(filesKey ? filesKey.split('\n') : []));
      setError(undefined);
    }
  }, [open, filesKey]);

  const submit = async () => {
    if (!message.trim() || !picked.size) return;
    setBusy(true);
    setError(undefined);
    try {
      const all = picked.size === files.length;
      const c = await oide.invoke('git.commit', { projectId, message: message.trim(), files: all ? undefined : [...picked] });
      toast(`Committed ${c.sha.slice(0, 7)} on ${branch}: ${c.message}`, 'success');
      setMessage('');
      onClose();
      void useGit.getState().load(projectId);
    } catch (err) {
      setError(ipcErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  // While the commit is in flight the dialog stays: its result (or error) shows here.
  const close = () => {
    if (!busy) onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      dismissOnScrim={!busy}
      width={480}
      title={`Commit to ${branch}`}
      description={`In ${projectName} · ${files.length} changed ${files.length === 1 ? 'file' : 'files'}`}
      initialFocus={messageRef}
      footer={
        <>
          <Button variant="secondary" size={32} disabled={busy} onClick={close}>
            Cancel
          </Button>
          <Button variant="primary" size={32} disabled={busy || !message.trim() || !picked.size} onClick={() => void submit()}>
            {busy ? 'Committing…' : picked.size === files.length ? 'Commit' : `Commit ${picked.size} of ${files.length}`}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-3.5"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <TextArea
          ref={messageRef}
          label="Commit message"
          rows={3}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              void submit();
            }
          }}
          placeholder="What changed, in one line"
          error={error}
          className="text-[13px]!"
        />
        <fieldset className="m-0 p-0 border-0 flex flex-col gap-1.5 min-w-0">
          <legend className="text-[12px] font-semibold text-ink-2 mb-1.5 p-0">Files to commit</legend>
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
      </form>
    </Dialog>
  );
}
