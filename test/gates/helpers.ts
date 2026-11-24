import { afterEach } from 'vitest';
import type { AgentStatus, AgentSummary } from '../../packages/protocol/src/index.js';
import { cleanup, startHarness, waitFor, type Harness, type HarnessOptions } from '../integration/harness.js';

/**
 * Shared bits for the milestone gate tests (test/gates/*). Each gate drives the plain-Node services
 * layer through the real IPC router against tools/fake-claude, like test/integration does.
 */

const open: Harness[] = [];
const dirs: string[] = [];

/** Call once per test file: closes every harness and removes temp dirs after each test. */
export function useGateCleanup(): void {
  afterEach(async () => {
    while (open.length)
      await open
        .pop()!
        .close()
        .catch(() => undefined);
    for (const d of dirs.splice(0)) {
      try {
        cleanup(d);
      } catch {
        // Windows may still hold a handle in a just-killed agent's worktree; a temp dir left behind is not a gate failure.
        await new Promise((r) => setTimeout(r, 1000));
        try {
          cleanup(d);
        } catch (err) {
          console.warn('[gates] could not remove temp dir', d, (err as Error).message);
        }
      }
    }
  });
}

/**
 * A harness that plays the user's part in main's native gates: it accepts the confirmation that
 * extra CLI flags need (SEC-07; the gates use `--fake-scenario`), and every `projects.open({ path })`
 * counts as a folder-picker pick (SEC-08).
 */
export async function gateHarness(opts: HarnessOptions = {}): Promise<Harness> {
  const h = await startHarness({ confirm: 'accept', ...opts });
  const call = h.call.bind(h);
  h.call = ((command: string, input: unknown) => {
    if (command === 'projects.open' && input && typeof (input as { path?: unknown }).path === 'string') h.allowOpen((input as { path: string }).path);
    return call(command as never, input as never);
  }) as Harness['call'];
  open.push(h);
  dirs.push(h.userData);
  return h;
}

/** Close a harness early (simulated quit); it is no longer closed by the cleanup hook. */
export async function closeHarness(h: Harness): Promise<void> {
  const i = open.indexOf(h);
  if (i >= 0) open.splice(i, 1);
  await h.close();
}

export function track(...paths: string[]): void {
  dirs.push(...paths);
}

export const single = { kind: 'single' as const, lead: { model: 'sonnet' } };

export async function agentOf(h: Harness, id: string): Promise<AgentSummary | undefined> {
  return (await h.call('agents.list', undefined)).find((a) => a.id === id);
}

/**
 * Wait until the agent reaches `want`, allowing every permission prompt on the way (the user
 * clicking "Allow once"). Returns the summary and the prompts that were answered.
 */
export async function driveTo(
  h: Harness,
  id: string,
  want: AgentStatus | ((a: AgentSummary) => boolean | Promise<boolean>),
  opts: { timeoutMs?: number; answer?: 'allow' | 'deny' } = {},
): Promise<{ agent: AgentSummary; prompts: Array<NonNullable<AgentSummary['pendingPermission']>> }> {
  const prompts: Array<NonNullable<AgentSummary['pendingPermission']>> = [];
  const done = typeof want === 'function' ? want : (a: AgentSummary) => a.status === want;
  const agent = await waitFor(
    async () => {
      const a = await agentOf(h, id);
      if (!a) return false;
      if (await done(a)) return a;
      const p = a.pendingPermission;
      if (a.status === 'needs-permission' && p && !prompts.some((x) => x.requestId === p.requestId)) {
        prompts.push(p);
        await h
          .call('agents.answerPermission', {
            agentId: id,
            answer: {
              requestId: p.requestId,
              behavior: opts.answer ?? 'allow',
              ...(opts.answer === 'deny' ? { message: 'Denied in the gate test' } : {}),
            },
          })
          .catch(() => undefined);
      }
      return false;
    },
    `${id} → ${typeof want === 'function' ? 'condition' : want}`,
    opts.timeoutMs ?? 30_000,
  );
  return { agent, prompts };
}
