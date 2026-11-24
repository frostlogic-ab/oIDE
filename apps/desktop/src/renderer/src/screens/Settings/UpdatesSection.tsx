/**
 * Settings › Updates (M7). Main owns the updater (apps/desktop/src/main/services/updater.ts): a
 * check only finds out whether a newer version exists; Download and Restart to update are separate
 * clicks, and the restart asks once more because it stops running agents.
 */
import { useEffect, useState } from 'react';
import type { Settings, UpdateChannel, UpdateStatus } from '@oide/protocol';
import { invokeOr, ipcErrorMessage, oide } from '../../lib/bridge';
import { toast } from '../../stores/ui';
import { H1, Pills, Rd, Row, Sec, outlineBtn, savePatch } from './ui';

const CHANNELS: ReadonlyArray<{ value: UpdateChannel; label: string }> = [
  { value: 'stable', label: 'Stable' },
  { value: 'beta', label: 'Beta' },
];

const primaryBtn =
  'inline-flex items-center justify-center h-[30px] px-3 rounded-[7px] border-0 bg-accent text-ground text-[12.5px] font-semibold hover:opacity-90 disabled:opacity-50 whitespace-nowrap';

export function formatChecked(at: number | undefined, now = Date.now()): string {
  if (!at) return 'Never checked';
  const mins = Math.round((now - at) / 60_000);
  if (mins < 1) return 'Last checked just now';
  if (mins < 60) return `Last checked ${mins} min ago`;
  const d = new Date(at);
  return `Last checked ${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

function stateLine(s: UpdateStatus): string {
  switch (s.state) {
    case 'disabled':
      return s.disabledReason ?? 'Updates are off for this build.';
    case 'idle':
      return 'Not checked yet this session.';
    case 'checking':
      return 'Checking for updates…';
    case 'not-available':
      return 'oIDE is up to date.';
    case 'available':
      return `oIDE ${s.available?.version ?? ''} is available.`;
    case 'downloading':
      return `Downloading oIDE ${s.available?.version ?? ''}… ${Math.round((s.progress ?? 0) * 100)}%`;
    case 'downloaded':
      return `oIDE ${s.available?.version ?? ''} is ready to install.`;
    case 'error':
      return `Update failed: ${s.error ?? 'unknown error'}`;
  }
}

export function UpdatesSection({ settings }: { settings: Settings }) {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

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

  const run = async (command: 'updates.check' | 'updates.download') => {
    setBusy(true);
    try {
      setStatus(await oide.invoke(command, undefined));
    } catch (err) {
      toast(`${command === 'updates.check' ? 'Check' : 'Download'} failed: ${ipcErrorMessage(err)}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  const install = async () => {
    try {
      await oide.invoke('updates.install', { consent: true });
    } catch (err) {
      setConfirming(false);
      toast(`Could not install the update: ${ipcErrorMessage(err)}`, 'error');
    }
  };

  const disabled = !status || status.state === 'disabled';
  const working = status?.state === 'checking' || status?.state === 'downloading';
  const openRelease = () => {
    if (status?.releaseUrl) void oide.invoke('shell.openExternal', { url: status.releaseUrl }).catch(() => undefined);
  };

  return (
    <>
      <H1>Updates</H1>
      <Rd>oIDE looks for new versions on GitHub Releases. Nothing is downloaded or installed until you click.</Rd>

      <Sec>Version</Sec>
      <Row title="Current version" desc={status ? stateLine(status) : 'Loading…'}>
        {() => (
          <span className="font-mono text-[12.5px] text-ink-2" data-testid="current-version">
            {status?.currentVersion ?? '…'}
          </span>
        )}
      </Row>
      <Row title="Channel" desc="Beta gets prereleases first, plus every stable release. Moving back to Stable keeps your version until a newer stable release ships.">
        {() => (
          <Pills
            label="Update channel"
            options={CHANNELS}
            value={settings.updates.channel}
            onChange={(channel) => {
              if (channel !== settings.updates.channel) void savePatch({ updates: { channel } });
            }}
          />
        )}
      </Row>
      <Row title="Check automatically" desc="At startup and every 6 hours. Downloading and installing still wait for you.">
        {({ titleId }) => (
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              className="accent-accent"
              aria-describedby={titleId}
              checked={settings.updates.checkAutomatically}
              onChange={(e) => void savePatch({ updates: { checkAutomatically: e.target.checked } })}
            />
            Check
          </label>
        )}
      </Row>
      <Row title="Check for updates" desc={formatChecked(status?.lastCheckedAt)}>
        {() => (
          <button type="button" className={outlineBtn} disabled={disabled || busy || working} onClick={() => void run('updates.check')}>
            {status?.state === 'checking' ? 'Checking…' : 'Check now'}
          </button>
        )}
      </Row>

      {status?.state === 'error' && (
        <div role="alert" className="mt-3 p-3 rounded-lg border border-bad-line bg-bad-bg text-[12.5px] text-bad">
          {stateLine(status)}
        </div>
      )}

      {status && status.available && (status.state === 'available' || status.state === 'downloading' || status.state === 'downloaded') && (
        <section aria-label="Available update" className="mt-4 p-4 rounded-[10px] border border-line-3 bg-card flex flex-col gap-2.5">
          <div className="flex items-center gap-3 flex-wrap">
            <span className="font-semibold">
              oIDE {status.available.version}
              {status.available.releaseName && status.available.releaseName !== status.available.version ? ` · ${status.available.releaseName}` : ''}
            </span>
            <div className="flex-1" />
            {status.state === 'available' &&
              (status.canInstall ? (
                <button type="button" className={primaryBtn} disabled={busy} onClick={() => void run('updates.download')}>
                  Download
                </button>
              ) : (
                <button type="button" className={outlineBtn} onClick={openRelease}>
                  Open release page
                </button>
              ))}
            {status.state === 'downloaded' && !confirming && (
              <button type="button" className={primaryBtn} onClick={() => setConfirming(true)}>
                Restart to update
              </button>
            )}
          </div>
          {status.state === 'available' && !status.canInstall && (
            <Rd>This build is not signed, so it cannot install updates itself. Download the new version from the release page.</Rd>
          )}
          {status.state === 'downloading' && (
            <div
              role="progressbar"
              aria-label="Download progress"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round((status.progress ?? 0) * 100)}
              className="h-1.5 rounded-full bg-chrome overflow-hidden"
            >
              <div className="h-full bg-accent" style={{ width: `${Math.round((status.progress ?? 0) * 100)}%` }} />
            </div>
          )}
          {status.state === 'downloaded' && confirming && (
            <div role="group" aria-label="Confirm restart" className="flex items-center gap-2 flex-wrap text-[12.5px]">
              <span className="text-ink-2 flex-1 min-w-[240px]">oIDE will quit, stop running agents (they resume after the restart) and install {status.available.version}.</span>
              <button type="button" className={outlineBtn} onClick={() => setConfirming(false)}>
                Cancel
              </button>
              <button type="button" className={primaryBtn} onClick={() => void install()}>
                Restart now
              </button>
            </div>
          )}
          {status.available.releaseNotes && (
            <pre className="m-0 max-h-[220px] overflow-y-auto whitespace-pre-wrap font-sans text-[12.5px] text-ink-2 leading-[1.5]">{status.available.releaseNotes}</pre>
          )}
        </section>
      )}

      {status?.state === 'disabled' && (
        <Rd className="mt-3 block">
          New versions are listed on the{' '}
          <a
            href={status.releaseUrl ?? 'https://github.com/oide-dev/oide/releases'}
            className="text-link"
            onClick={(e) => {
              e.preventDefault();
              void oide.invoke('shell.openExternal', { url: status.releaseUrl ?? 'https://github.com/oide-dev/oide/releases' }).catch(() => undefined);
            }}
          >
            releases page
          </a>
          .
        </Rd>
      )}
    </>
  );
}
