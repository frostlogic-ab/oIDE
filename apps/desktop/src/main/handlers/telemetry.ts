import type { TelemetryStatus } from '@oide/protocol';
import type { MainContext } from '../context.js';
import type { IpcRouter } from '../ipc/router.js';
import type { Services } from '../services/index.js';

const OK = { ok: true as const };
/** Without a telemetry service (plain-Node harness, tests) nothing can be sent and nothing is asked. */
const OFF: TelemetryStatus = {
  available: false,
  reason: 'test',
  usageAnalytics: false,
  errorReports: false,
  showPrompt: false,
};
/** Renderer reports accepted per minute; more are dropped (the queues are capped as well). */
export const TRACK_PER_MINUTE = 120;

/** telemetry.* (ADR 0011). Main decides; the renderer only reports. */
export function registerTelemetryHandlers(router: IpcRouter, _services: Services, ctx: MainContext): void {
  router.register('telemetry.status', () => ctx.telemetry?.service.status() ?? OFF);
  router.register('telemetry.consent', ({ choice }) => ctx.telemetry?.service.consent(choice) ?? OFF);
  let budget = { start: 0, n: 0 };
  router.register('telemetry.track', (input) => {
    const t = ctx.telemetry?.service;
    if (!t) return OK;
    const now = Date.now();
    if (now - budget.start >= 60_000) budget = { start: now, n: 0 };
    if (++budget.n > TRACK_PER_MINUTE) return OK;
    switch (input.type) {
      case 'pageview':
        t.pageview(input.screen, input.section);
        break;
      case 'event':
        t.trackFromRenderer(input.name, input.props);
        break;
      case 'error':
        t.error(
          { name: input.name, message: input.message, stack: input.stack },
          { source: input.source, process: 'renderer' },
        );
        break;
      case 'vitals': {
        const { type: _t, screen, section, ...v } = input;
        t.vitals(screen, section, v);
        break;
      }
    }
    return OK;
  });
}
