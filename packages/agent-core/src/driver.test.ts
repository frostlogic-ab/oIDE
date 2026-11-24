import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AgentSpec, type AgentEvent } from '@oide/protocol';
import { fakeCli, tempDir, testSettings, waitFor } from '../test/helpers.js';
import { buildLaunch } from './args.js';
import { ClaudeCliDriver, rawJsonOf, type AgentHandle } from './driver.js';

const spec = AgentSpec.parse({ projectId: 'p1', title: 'Driver test', goal: 'Say hello.', mode: 'default', strategy: { kind: 'single', lead: { model: 'haiku' } } });

async function start(extraFlags: string, opts: { controlTimeoutMs?: number; resume?: boolean; sessionId?: string } = {}) {
  const cwd = tempDir();
  const sessionId = opts.sessionId ?? '9c1d2b3a-0000-4000-8000-000000000001';
  const launch = buildLaunch(spec, { agentId: 'drv-1', sessionId, cwd, cli: fakeCli, settings: testSettings({ extraFlags }), ...(opts.resume ? { resume: true } : {}) });
  const handle = await new ClaudeCliDriver().start(spec, { agentId: 'drv-1', sessionId, cwd, launch, controlTimeoutMs: opts.controlTimeoutMs ?? 2000, disposeGraceMs: 500 });
  const events: AgentEvent[] = [];
  const done = (async () => {
    for await (const e of handle.events) events.push(e);
  })();
  return { handle, events, done, cwd };
}

const results = (events: AgentEvent[]) => events.filter((e) => e.type === 'result');

describe('ClaudeCliDriver against fake-claude', () => {
  it('runs a turn, numbers events monotonically, keeps raw JSON, exits on dispose', async () => {
    const { handle, events, done } = await start('--fake-scenario basic');
    await waitFor(() => results(events).length === 1, 10_000, 'first result');
    expect(events[0]!.type).toBe('init');
    expect(handle.sessionId).toBe('9c1d2b3a-0000-4000-8000-000000000001');
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i));
    expect(rawJsonOf(events[0]!)).toMatch(/"subtype":"init"/);
    expect(events.some((e) => e.type === 'assistant-text' && e.text.includes('Say hello.'))).toBe(true);
    handle.send({ kind: 'text', text: 'second turn' });
    await waitFor(() => results(events).length === 2, 10_000, 'second result');
    await handle.dispose();
    await done;
    expect(events.at(-1)).toMatchObject({ type: 'exit', code: 0 });
    expect(handle.alive).toBe(false);
  });

  it('interrupt via control request ends the turn; setMode via control request', async () => {
    const { handle, events, done } = await start('--fake-scenario slow');
    await waitFor(() => events.some((e) => e.type === 'partial'), 10_000, 'partials');
    await handle.interrupt();
    await waitFor(() => results(events).length === 1, 10_000, 'interrupted result');
    expect(results(events)[0]).toMatchObject({ subtype: 'error_during_execution' });
    await handle.setMode('acceptEdits');
    await waitFor(() => events.some((e) => e.type === 'mode-changed' && e.mode === 'acceptEdits'), 5000, 'mode change');
    await handle.dispose();
    await done;
  });

  it('falls back when control requests are ignored: setMode rejects, interrupt sends SIGINT', async () => {
    const { handle, events, done } = await start('--fake-scenario slow --fake-no-control', { controlTimeoutMs: 300 });
    await waitFor(() => events.some((e) => e.type === 'partial'), 10_000, 'partials');
    await expect(handle.setMode('plan')).rejects.toThrow(/timed out/);
    await handle.interrupt();
    await done;
    expect(events.at(-1)!.type).toBe('exit');
  });

  it('reports crashes with exit code and stderr', async () => {
    const { events, done } = await start('--fake-scenario crash --fake-exit-code 7');
    await done;
    expect(events.some((e) => e.type === 'stderr' && e.text.includes('simulated crash'))).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'exit', code: 7 });
  });

  it('resume passes --resume and the CLI echoes the session id', async () => {
    const { handle, events, done } = await start('--fake-scenario basic', { resume: true, sessionId: '9c1d2b3a-0000-4000-8000-0000000000aa' });
    handle.send({ kind: 'text', text: 'continue' });
    await waitFor(() => results(events).length === 1, 10_000, 'result');
    expect(events.find((e) => e.type === 'init')).toMatchObject({ sessionId: '9c1d2b3a-0000-4000-8000-0000000000aa' });
    expect(events.some((e) => e.type === 'assistant-text' && e.text === 'Resumed session 9c1d2b3a-0000-4000-8000-0000000000aa.')).toBe(true);
    await handle.dispose();
    await done;
  });

  it('passes only allow-listed env to the CLI and sends review feedback with file:line refs', async () => {
    const dir = tempDir();
    const rec = join(dir, 'rec.jsonl');
    process.env.OIDE_TEST_SECRET_VALUE = 'should-not-leak';
    let h: AgentHandle | undefined;
    try {
      const s = await start(`--fake-scenario basic --fake-record ${JSON.stringify(rec)}`);
      h = s.handle;
      await waitFor(() => results(s.events).length === 1, 10_000, 'result');
      h.send({ kind: 'review-feedback', comments: [{ path: 'src/a.ts', line: 12, body: 'Rename this' }, { path: 'README.md', body: 'Typo' }], note: 'Nice work' });
      await waitFor(() => results(s.events).length === 2, 10_000, 'second result');
      await h.dispose();
      await s.done;
    } finally {
      delete process.env.OIDE_TEST_SECRET_VALUE;
    }
    const lines = readFileSync(rec, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const keys: string[] = lines[0].envKeys;
    expect(keys).not.toContain('OIDE_TEST_SECRET_VALUE');
    expect(keys).toContain('OIDE_AGENT_ID');
    const feedback = lines.find((l) => l.stdin?.message?.content?.[0]?.text?.includes('Review feedback'));
    expect(feedback.stdin.message.content[0].text).toMatch(/- src\/a\.ts:12: Rename this\n- README\.md: Typo/);
  });
});
