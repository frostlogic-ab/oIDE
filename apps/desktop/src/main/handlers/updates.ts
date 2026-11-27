import type { UpdateStatus } from '@oide/protocol';
import type { MainContext } from '../context.js';
import type { IpcRouter } from '../ipc/router.js';
import type { Services } from '../services/index.js';

/**
 * Settings › Updates. `services.updates` exists only in the Electron app (services/index.ts); in
 * plain Node (integration tests) every command answers with a `disabled` status.
 */
export function registerUpdateHandlers(router: IpcRouter, services: Services, ctx: MainContext): void {
  const off = (): UpdateStatus => ({
    state: 'disabled',
    currentVersion: ctx.appVersion,
    channel: services.store.settings.get().updates.channel,
    disabledReason: 'Updates are not available in this build.',
    canInstall: false,
  });
  router.register('updates.status', () => services.updates?.getStatus() ?? off());
  router.register('updates.check', async () => (services.updates ? services.updates.check() : off()));
  router.register('updates.download', async () => (services.updates ? services.updates.download() : off()));
  router.register('updates.install', ({ consent, from }) => {
    if (!services.updates) throw new Error('Updates are not available in this build.');
    services.updates.install(consent, from);
    return { ok: true as const };
  });
}
