import type { MainContext } from '../context.js';
import type { IpcRouter } from '../ipc/router.js';
import type { Services } from '../services/index.js';

export function registerAppHandlers(router: IpcRouter, _services: Services, ctx: MainContext): void {
  router.register('app.info', () => ({
    version: ctx.appVersion,
    platform: ctx.platform,
    userData: ctx.userDataDir,
  }));
}
