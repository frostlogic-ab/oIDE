import { useState } from 'react';
import { Button, Dialog } from '@oide/ui';
import { ipcErrorMessage, oide } from '../../lib/bridge';
import { restartWarning, useUpdateStatus } from '../../lib/useUpdateStatus';
import { toast } from '../../stores/ui';

/**
 * The header's Update button, right of the logo. Hidden until there is an update to act on:
 * - downloaded: "Update" asks once (agents stop) and restarts into the new version;
 * - available, not downloading by itself (Download automatically off): "Update" starts the download;
 * - downloading: shows progress, not clickable;
 * - available but this build cannot install itself (unsigned macOS): opens the release page.
 */
export function UpdateButton() {
  const [status, setStatus] = useUpdateStatus();
  const [confirming, setConfirming] = useState(false);
  if (!status?.available) return null;
  const version = status.available.version;

  if (status.state === 'downloaded') {
    const install = async () => {
      try {
        await oide.invoke('updates.install', { consent: true, from: 'header' });
      } catch (err) {
        setConfirming(false);
        toast(`Could not install the update: ${ipcErrorMessage(err)}`, 'error');
      }
    };
    return (
      <>
        <Button variant="primary" icon="download" title={`oIDE ${version} is ready. Restart to update.`} onClick={() => setConfirming(true)}>
          Update
        </Button>
        <Dialog
          open={confirming}
          onClose={() => setConfirming(false)}
          title={`Restart to update to oIDE ${version}?`}
          description={restartWarning(version)}
          footer={
            <>
              <Button variant="secondary" size={32} onClick={() => setConfirming(false)}>
                Cancel
              </Button>
              <Button variant="primary" size={32} onClick={() => void install()}>
                Restart now
              </Button>
            </>
          }
        />
      </>
    );
  }

  if (status.state === 'downloading') {
    const pct = Math.round((status.progress ?? 0) * 100);
    return (
      <Button variant="secondary" icon="download" disabled aria-busy="true" title={`Downloading oIDE ${version}`}>
        Downloading {pct}%
      </Button>
    );
  }

  if (status.state === 'available') {
    if (!status.canInstall) {
      const url = status.releaseUrl;
      if (!url) return null;
      return (
        <Button variant="secondary" icon="external-link" title={`oIDE ${version} is available. Open the release page to download it.`} onClick={() => void oide.invoke('shell.openExternal', { url }).catch(() => undefined)}>
          Update
        </Button>
      );
    }
    const download = async () => {
      try {
        setStatus(await oide.invoke('updates.download', undefined));
      } catch (err) {
        toast(`Download failed: ${ipcErrorMessage(err)}`, 'error');
      }
    };
    return (
      <Button variant="secondary" icon="download" title={`oIDE ${version} is available. Download it.`} onClick={() => void download()}>
        Update
      </Button>
    );
  }

  return null;
}
