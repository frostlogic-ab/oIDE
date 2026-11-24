import { z } from 'zod';

/**
 * Auto-update (M7). electron-updater on GitHub Releases, owned by the main process
 * (`apps/desktop/src/main/services/updater.ts`). The renderer only reads this status and asks for a
 * check, a download or an install; nothing is downloaded or installed without the user's click.
 */
export const UpdateChannel = z.enum(['stable', 'beta']);
export type UpdateChannel = z.infer<typeof UpdateChannel>;

export const UpdateState = z.enum([
  /** Updates are off: development build, Linux deb/rpm (package manager), OIDE_DISABLE_UPDATES. */
  'disabled',
  /** Nothing checked yet this session. */
  'idle',
  'checking',
  'not-available',
  /** A newer version exists; waits for the user to click Download. */
  'available',
  'downloading',
  /** Downloaded and verified; waits for the user to click Restart to update. */
  'downloaded',
  'error',
]);
export type UpdateState = z.infer<typeof UpdateState>;

export const UpdateStatus = z.object({
  state: UpdateState,
  currentVersion: z.string(),
  channel: UpdateChannel,
  /** Why updates are off (state `disabled`), in words for the Settings row. */
  disabledReason: z.string().optional(),
  /** The newer version found by the last check (states available / downloading / downloaded). */
  available: z
    .object({
      version: z.string(),
      releaseName: z.string().optional(),
      releaseDate: z.string().optional(),
      /** Release notes as plain text (HTML from GitHub is stripped in main). */
      releaseNotes: z.string().optional(),
    })
    .optional(),
  /** 0..1 while downloading. */
  progress: z.number().min(0).max(1).optional(),
  /** Epoch ms of the last finished check (kept across restarts). */
  lastCheckedAt: z.number().optional(),
  error: z.string().optional(),
  /**
   * False when this build cannot install updates itself (an unsigned macOS build: Squirrel.Mac only
   * installs signed apps). The UI then offers the release page instead of Download.
   */
  canInstall: z.boolean(),
  /** GitHub release page for the available version (or the releases list). */
  releaseUrl: z.string().optional(),
});
export type UpdateStatus = z.infer<typeof UpdateStatus>;
