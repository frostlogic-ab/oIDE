import { useEffect, useState } from 'react';
import type { UpdateStatus } from '@oide/protocol';
import { invokeOr, oide } from './bridge';

/**
 * The updater's status from main (`updates.status`, then every `updates.changed` event), or null
 * until the first answer. Shared by Settings › Updates and the header Update button.
 */
export function useUpdateStatus(): [UpdateStatus | null, (s: UpdateStatus) => void] {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  useEffect(() => {
    let live = true;
    void invokeOr('updates.status', undefined, null)
      .then((s) => {
        if (live && s) setStatus(s);
      })
      .catch(() => undefined);
    const off = oide.on('updates.changed', (s) => setStatus(s));
    return () => {
      live = false;
      off();
    };
  }, []);
  return [status, setStatus];
}

/** "oIDE will quit, stop …": what Restart to update does, said before the user confirms. */
export function restartWarning(version: string | undefined): string {
  return `oIDE will quit, stop running agents (they resume after the restart) and install ${version ?? 'the update'}.`;
}
