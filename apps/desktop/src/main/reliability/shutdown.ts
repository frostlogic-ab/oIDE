/**
 * Graceful shutdown. Quit hooks run one after another in registration order (terminals, then
 * services: pending permission prompts denied and the MCP server closed, agents stopped with their
 * sessions left resumable, git watchers and in-flight git work, extension host, database), each
 * with its own timeout, under an overall cap. A hook that throws or times out is logged and the
 * next one still runs, so the database is always closed last and the app always exits.
 */

export interface QuitStep {
  name: string;
  fn: () => void | Promise<void>;
  /** Per-step timeout (default `stepMs`). */
  timeoutMs?: number;
}

export interface ShutdownResult {
  name: string;
  outcome: 'ok' | 'error' | 'timeout' | 'skipped';
  ms: number;
}

export async function runShutdown(
  steps: QuitStep[],
  o: { stepMs?: number; totalMs?: number; log?: { info(...a: unknown[]): void; warn(...a: unknown[]): void }; now?: () => number } = {},
): Promise<ShutdownResult[]> {
  const now = o.now ?? Date.now;
  const start = now();
  const total = o.totalMs ?? 10_000;
  const results: ShutdownResult[] = [];
  for (const step of steps) {
    const t0 = now();
    const left = total - (t0 - start);
    if (left <= 0) {
      results.push({ name: step.name, outcome: 'skipped', ms: 0 });
      o.log?.warn('quit step skipped (out of time)', step.name);
      continue;
    }
    const limit = Math.min(step.timeoutMs ?? o.stepMs ?? 6000, left);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((r) => {
      timer = setTimeout(() => r('timeout'), limit);
    });
    let outcome: ShutdownResult['outcome'];
    try {
      outcome = await Promise.race([Promise.resolve().then(step.fn).then(() => 'ok' as const), timeout]);
    } catch (err) {
      outcome = 'error';
      o.log?.warn('quit step failed', step.name, err);
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (outcome === 'timeout') o.log?.warn('quit step timed out', step.name, { ms: limit });
    results.push({ name: step.name, outcome, ms: now() - t0 });
  }
  o.log?.info('shutdown finished', results);
  return results;
}
