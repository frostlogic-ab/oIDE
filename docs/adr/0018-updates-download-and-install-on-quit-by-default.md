# ADR 0018: Updates download in the background and install on quit by default

- Status: accepted
- Date: 2026-11-27
- Departs from: the M7 updater design (packaging page, "Consent"), where a check only found an
  update and both downloading and installing waited for a click in Settings › Updates. The build
  brief only asks for electron-updater on GitHub Releases with stable and beta channels.

## Context
People rarely open Settings › Updates, so found updates sat undownloaded and users stayed on old
versions. The product now asks for updates that download by themselves, install when oIDE closes,
and an Update button next to the logo to restart into the new version, with both automatic steps as
Settings checkboxes that are on by default.

## Decision
1. **Download automatically** (`settings.updates.downloadAutomatically`, default on): when a check
   finds an update this build can install, main calls `download()` itself. electron-updater's own
   `autoDownload` stays off, so the status, the progress and the unsigned-macOS rule (no install, so
   no download) stay in one place. Turning the setting on while an update waits starts its download.
2. **Install when oIDE closes** (`settings.updates.installOnQuit`, default on): electron-updater's
   `autoInstallOnAppQuit`. It installs on the app's `quit` event, which fires after every oIDE quit
   hook (pending permissions denied, agents stopped and resumable) when main calls `app.exit(0)`. On
   Windows the installer runs silently and oIDE is not started again. On Windows and Linux the flag
   stays on until electron-updater has registered its quit handler (right after a download) and then
   follows the setting, which the handler reads again at quit. On macOS the flag decides at download
   time whether Squirrel.Mac takes the update, so turning it off after a macOS download applies from
   the next update.
3. **Restarting now is still a click**: the header Update button (right of the logo) or Restart to
   update in Settings, each behind a confirm because it stops running agents. With Download
   automatically off, the header button starts the download; for a build that cannot install itself
   it opens the release page.
4. Telemetry gets `update_install_started` (`trigger` header / settings / quit, `channel`) to learn
   how updates are applied.

## Consequences
- Updates use bandwidth and disk without a click. Both settings are visible and can be turned off.
- Quitting oIDE with a downloaded update now installs it; the Settings state line says so.
- The off cases (development builds, no release feed, portable zip, deb/rpm, `OIDE_DISABLE_UPDATES`)
  are unchanged: nothing downloads there.
