import { execFile } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentEvent, AgentStatus, AgentSummary } from '../../packages/protocol/src/index.js';
import { BUILTIN_PRESETS } from '../../packages/store/src/index.js';
import { makeRepo, tempDir, waitFor } from '../integration/harness.js';
import { closeHarness, driveTo, gateHarness, single, track, useGateCleanup } from './helpers.js';

/**
 * M2 gate, compressed: "Six agents across three projects run for a working day without a restart."
 *
 * Six agents in three projects (two each, single and routed strategies) under Max running 3. Each
 * agent loops through a day's worth of interactions until the time is up: tool turns with a
 * permission prompt, allowed and denied prompts, routed and background subagents (with a subagent's
 * own prompt), review + feedback, `/compact`, a plan limit hit followed by Stop and Resume (a
 * respawn with `--resume`), plain replies. Duration: `OIDE_SOAK_MS` (default 60 s);
 * `OIDE_SOAK_DEBUG=<file>` appends a line per process sample and the run summary to that file.
 *
 * Checked throughout: no launch out of the queue beyond Max running; live CLI processes (read
 * from the OS) never exceed one per agent and none outlives its `--resume` replacement.
 * Checked at the end: every event the renderer got is in the store and vice versa (same seqs, no
 * duplicates), every turn's `result` arrived, store summaries equal the supervisor's, no emitted
 * event failed its schema, bounded heap; after removing the agents and quitting: no CLI process,
 * MCP endpoint, pending prompt, supervisor or process listener, socket, server or child handle left.
 */

useGateCleanup();

const SOAK_MS = Number(process.env.OIDE_SOAK_MS ?? 60_000);
const MAX_RUNNING = 3;
const ACTIVE: ReadonlySet<AgentStatus> = new Set(['starting', 'running', 'needs-permission']);
const ACTIONS = [
  'tools',
  'permission',
  'subagents',
  'compact',
  'review',
  'rate-limit',
  'reply',
  'permission-deny',
] as const;
type Action = (typeof ACTIONS)[number];
const PROCESS_EVENTS = [
  'exit',
  'beforeExit',
  'SIGINT',
  'SIGTERM',
  'uncaughtException',
  'unhandledRejection',
  'warning',
] as const;
const HANDLE_TYPES = ['TCPServerWrap', 'TCPSocketWrap', 'ProcessWrap', 'PipeWrap', 'FSEventWrap', 'Timeout'];

/**
 * Live fake-claude processes of this run, found by a marker in their command line (the unique
 * `--fake-record` folder). PIDs alone are not enough: Windows reuses them within seconds.
 */
async function liveCli(marker: string): Promise<number[]> {
  const run = (cmd: string, args: string[]) =>
    new Promise<string>((resolve) =>
      execFile(cmd, args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (_err, stdout) =>
        resolve(String(stdout ?? '')),
      ),
    );
  if (process.platform === 'win32') {
    // Command lines hold the multi-line system prompt: flatten them to one line per process.
    const out = await run('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | ForEach-Object { \"$($_.ProcessId) $($_.CommandLine -replace '[\\r\\n]+', ' ')\" }",
    ]);
    return out
      .split(/\r?\n/)
      .filter((l) => l.includes(marker) && l.includes('fake-claude'))
      .map((l) => Number(l.split(' ')[0]));
  }
  const out = await run('ps', ['-eo', 'pid=,args=']);
  return out
    .split('\n')
    .filter((l) => l.includes(marker) && l.includes('fake-claude'))
    .map((l) => Number(l.trim().split(/\s+/)[0]));
}
const handleCounts = () => {
  const out: Record<string, number> = {};
  for (const t of process.getActiveResourcesInfo()) out[t] = (out[t] ?? 0) + 1;
  return out;
};
const processListeners = () => Object.fromEntries(PROCESS_EVENTS.map((e) => [e, process.listenerCount(e)]));

interface Launch {
  pid: number;
  session: string;
  resume: boolean;
}

function readLaunches(record: string): Launch[] {
  if (!existsSync(record)) return [];
  const out: Launch[] = [];
  for (const line of readFileSync(record, 'utf8').split('\n')) {
    if (!line.startsWith('{"argv"')) continue;
    try {
      const l = JSON.parse(line) as { argv: string[]; pid: number };
      const resume = l.argv.includes('--resume');
      out.push({
        pid: l.pid,
        resume,
        session: l.argv[l.argv.indexOf(resume ? '--resume' : '--session-id') + 1]!,
      });
    } catch {
      /* a line interleaved by concurrent writers */
    }
  }
  return out;
}

describe('M2 gate: six agents, three projects, a compressed working day', () => {
  it(
    `runs ${Math.round(SOAK_MS / 1000)} s of cycles without leaks or lost events`,
    { timeout: SOAK_MS + 180_000 },
    async () => {
      const baseHandles = handleCounts();
      const baseProcess = processListeners();
      const recDir = tempDir('oide-soak-rec-');
      track(recDir);
      const record = join(recDir, 'launch.jsonl');

      // ---------------------------------------------------------------- renderer-side bookkeeping
      const delivered = new Map<string, Set<number>>();
      const duplicates: string[] = [];
      const results = new Map<string, number>();
      const onEvent = (event: string, payload: unknown) => {
        if (event !== 'agents.batch') return;
        for (const e of (payload as { events: AgentEvent[] }).events) {
          if (e.type === 'partial') continue;
          let seqs = delivered.get(e.agentId);
          if (!seqs) delivered.set(e.agentId, (seqs = new Set()));
          if (seqs.has(e.seq)) duplicates.push(`${e.agentId}#${e.seq}`);
          seqs.add(e.seq);
          if (e.type === 'result') results.set(e.agentId, (results.get(e.agentId) ?? 0) + 1);
        }
      };

      const h = await gateHarness({ keepEvents: false, onEvent });
      const sup = h.services.agents.supervisor;
      const supListeners = () =>
        Object.fromEntries(
          Object.entries((sup as unknown as { listeners: Record<string, Set<unknown>> }).listeners).map(
            ([k, v]) => [k, v.size],
          ),
        );
      const mcpState = () => {
        const m = h.services.mcp as unknown as {
          agents: Map<string, unknown>;
          pending: Map<string, unknown>;
        };
        return { agents: m.agents.size, pending: m.pending.size };
      };
      const baseSup = supListeners();
      await h.call('settings.update', {
        patch: {
          claude: { extraFlags: `--fake-scenario basic --fake-record ${JSON.stringify(record)}` },
          agents: { maxRunning: MAX_RUNNING, cleanup: 'never' },
        },
      });

      // Invariants sampled as they happen.
      let launchesOverMax = 0;
      let sawQueueWhileFull = false;
      // A launch out of the queue (queued → starting) never makes more than Max running. (Replies to an
      // idle agent whose process is alive go straight to it, like the CLI's own session, so the
      // running count itself may exceed Max between launches.)
      const prevStatus = new Map<string, AgentStatus>();
      const onSummary = (s: AgentSummary) => {
        if (s.status === 'starting' && prevStatus.get(s.id) === 'queued' && sup.runningCount() > MAX_RUNNING)
          launchesOverMax++;
        if (s.status === 'queued' && sup.runningCount() >= MAX_RUNNING) sawQueueWhileFull = true;
        prevStatus.set(s.id, s.status);
      };
      sup.on('summary', onSummary);
      // CLI processes, sampled from the OS: never more than one per agent, and a process replaced by
      // a `--resume` respawn is gone (stale = alive although its session has a newer launch).
      const marker = basename(recDir);
      let maxLive = 0;
      let stale = 0;
      let samples = 0;
      let sampling = true;
      let staleBefore = new Set<number>();
      const processSampler = (async () => {
        while (sampling) {
          const live = await liveCli(marker);
          const latest = new Map<string, number>();
          for (const l of readLaunches(record)) latest.set(l.session, l.pid);
          const current = new Set(latest.values());
          // Stale in two samples in a row (≥ 1.5 s apart): one sample can race a stop → resume.
          const nowStale = new Set(live.filter((p) => !current.has(p)));
          stale += [...nowStale].filter((p) => staleBefore.has(p)).length;
          staleBefore = nowStale;
          maxLive = Math.max(maxLive, live.length);
          samples++;
          if (process.env.OIDE_SOAK_DEBUG)
            appendFileSync(
              process.env.OIDE_SOAK_DEBUG,
              `[soak-debug] live ${live.length} stale ${stale} ${sup
                .list()
                .map((a) => a.status)
                .join(',')}\n`,
            );
          await new Promise((r) => setTimeout(r, 1500));
        }
      })();
      const heap: number[] = [];
      const sampler = setInterval(() => heap.push(process.memoryUsage().heapUsed), 1000);

      // ---------------------------------------------------------------- six agents, three projects
      const projects = [];
      for (let i = 0; i < 3; i++) {
        const repo = makeRepo();
        track(repo);
        projects.push((await h.call('projects.open', { path: repo }))!);
      }
      const routed = BUILTIN_PRESETS.find((p) => p.id === 'balanced')!.strategy;
      const ids: string[] = [];
      for (let i = 0; i < 6; i++) {
        const [a] = await h.call('agents.spawn', {
          projectId: projects[i % 3]!.id,
          title: `Day agent ${i + 1}`,
          goal: '[fake-scenario:basic] Start the day',
          mode: 'acceptEdits',
          strategy: i % 2 ? routed : single,
        });
        ids.push(a!.id);
      }
      expect(
        (await h.call('agents.list', undefined)).filter((a) => a.status === 'queued').length,
      ).toBeGreaterThanOrEqual(3);

      const expected = new Map<string, number>(ids.map((id) => [id, 1]));
      const counts: Record<Action, number> = Object.fromEntries(ACTIONS.map((a) => [a, 0])) as Record<
        Action,
        number
      >;
      const deadline = Date.now() + SOAK_MS;
      const resultsOf = (id: string) => results.get(id) ?? 0;
      const idleAfter = (id: string, n: number, status?: AgentStatus) => (a: AgentSummary) =>
        resultsOf(id) >= n &&
        !ACTIVE.has(a.status) &&
        a.status !== 'queued' &&
        (!status || a.status === status);
      const send = (id: string, text: string) =>
        h.call('agents.send', { agentId: id, message: { kind: 'text', text } });

      async function act(id: string, action: Action): Promise<void> {
        const n = resultsOf(id);
        const turns = action === 'subagents' ? 2 : action === 'review' ? 2 : 1;
        expected.set(id, expected.get(id)! + turns);
        switch (action) {
          case 'tools':
            await send(id, '[fake-scenario:tools] Write the output file and run the tests');
            await driveTo(h, id, idleAfter(id, n + 1, 'has-question'), { timeoutMs: 60_000 });
            break;
          case 'permission':
          case 'permission-deny':
            await send(id, '[fake-scenario:permission] Run the tests');
            await driveTo(h, id, idleAfter(id, n + 1, 'has-question'), {
              timeoutMs: 60_000,
              answer: action === 'permission' ? 'allow' : 'deny',
            });
            break;
          case 'subagents':
            await send(id, '[fake-scenario:subagents] Split the work');
            await driveTo(h, id, idleAfter(id, n + 2, 'has-question'), { timeoutMs: 60_000 });
            break;
          case 'compact':
            await h.call('agents.compact', { agentId: id });
            await driveTo(h, id, idleAfter(id, n + 1), { timeoutMs: 60_000 });
            break;
          case 'review': {
            await send(id, '[fake-scenario:review] Add the feature');
            await driveTo(h, id, idleAfter(id, n + 1, 'ready-for-review'), { timeoutMs: 60_000 });
            await h.call('review.addComment', {
              agentId: id,
              path: 'feature.txt',
              line: 1,
              body: 'Looks fine',
            });
            await h.call('review.sendFeedback', { agentId: id });
            await driveTo(h, id, idleAfter(id, n + 2, 'has-question'), { timeoutMs: 60_000 });
            break;
          }
          case 'rate-limit':
            await send(id, '[fake-scenario:rate-limit] Keep going');
            await driveTo(h, id, idleAfter(id, n + 1, 'rate-limited'), { timeoutMs: 60_000 });
            // The plan limit: the user stops it and resumes later (respawn with --resume, same session).
            await h.call('agents.stop', { agentId: id });
            await driveTo(h, id, 'stopped');
            await h.call('agents.resume', { agentId: id });
            await driveTo(h, id, 'has-question', { timeoutMs: 60_000 });
            break;
          case 'reply':
            await send(id, '[fake-scenario:basic] Thanks, carry on');
            await driveTo(h, id, idleAfter(id, n + 1, 'has-question'), { timeoutMs: 60_000 });
            break;
        }
        counts[action]++;
      }

      await Promise.all(
        ids.map(async (id, k) => {
          await driveTo(h, id, idleAfter(id, 1, 'has-question'), { timeoutMs: 60_000 });
          for (let i = k; Date.now() < deadline; i++) await act(id, ACTIONS[i % ACTIONS.length]!);
        }),
      );
      clearInterval(sampler);
      sup.off('summary', onSummary);
      await new Promise((r) => setTimeout(r, 200)); // let the event batcher flush

      // ---------------------------------------------------------------- invariants
      const cycles = Object.values(counts).reduce((a, b) => a + b, 0);
      expect(cycles).toBeGreaterThanOrEqual(ACTIONS.length * 6);
      for (const a of ACTIONS) expect(counts[a], a).toBeGreaterThan(0);
      expect(launchesOverMax).toBe(0);
      expect(sawQueueWhileFull).toBe(true);
      sampling = false;
      await processSampler;
      expect(samples).toBeGreaterThan(3);
      expect(maxLive).toBeGreaterThan(0);
      expect(maxLive).toBeLessThanOrEqual(6);
      expect(stale).toBe(0);
      const launches = readLaunches(record);
      expect(launches.filter((l) => l.resume).length).toBeGreaterThanOrEqual(counts['rate-limit']);
      // Every agent kept one session all day (resumes reuse it).
      expect(new Set(launches.map((l) => l.session)).size).toBe(6);
      expect(duplicates).toEqual([]);
      expect(h.emitErrors).toEqual([]);

      let storedEvents = 0;
      for (const id of ids) {
        const stored: AgentEvent[] = [];
        for (
          let page = h.services.store.events.list(id, { afterSeq: -1, limit: 5000 });
          page.length;
          page = h.services.store.events.list(id, { afterSeq: page.at(-1)!.seq, limit: 5000 })
        )
          stored.push(...page);
        storedEvents += stored.length;
        const seqs = stored.map((e) => e.seq);
        expect(new Set(seqs).size, `${id} unique seqs`).toBe(seqs.length);
        expect(
          [...seqs].sort((x, y) => x - y),
          `${id} ordered`,
        ).toEqual(seqs);
        expect(new Set(seqs), `${id} store = renderer`).toEqual(delivered.get(id));
        expect(stored.filter((e) => e.type === 'result').length, `${id} results`).toBe(expected.get(id));
        expect(resultsOf(id)).toBe(expected.get(id));
        const live = sup.get(id)!;
        const row = h.services.store.agents.get(id)!;
        expect(row.summary?.status, `${id} stored status`).toBe(live.status);
        expect(row.summary?.sessionId).toBe(live.sessionId);
        expect(row.sessionId ?? row.summary?.sessionId).toBe(live.sessionId);
      }
      const routedIds = ids.filter((_, i) => i % 2);
      for (const id of routedIds)
        expect(h.services.store.subagents.list(id).length, `${id} subagents`).toBeGreaterThan(0);
      expect((await h.call('usage.summary', undefined)).tokensToday).toBeGreaterThan(0);

      // Heap: the second half of the day does not keep growing (generous bound; no forced GC here).
      const warm = heap[Math.floor(heap.length / 4)] ?? heap[0]!;
      const peak = Math.max(...heap.slice(Math.floor(heap.length / 4)));
      expect(peak - warm).toBeLessThan(160 * 1024 * 1024);

      // ---------------------------------------------------------------- end of day: remove, quit
      for (const id of ids) await h.call('agents.remove', { agentId: id, deleteWorktree: true });
      expect(sup.list()).toEqual([]);
      expect(mcpState()).toEqual({ agents: 0, pending: 0 });
      expect(supListeners()).toEqual(baseSup);
      await waitFor(async () => (await liveCli(marker)).length === 0, 'every CLI process exited', 15_000);
      await closeHarness(h);
      await new Promise((r) => setTimeout(r, 300));
      expect(processListeners()).toEqual(baseProcess);
      const after = handleCounts();
      for (const t of HANDLE_TYPES)
        expect(after[t] ?? 0, `${t} handles`).toBeLessThanOrEqual(baseHandles[t] ?? 0);

      const summary =
        `[soak] ${Math.round(SOAK_MS / 1000)} s: ${cycles} cycles (${ACTIONS.map((a) => `${a} ${counts[a]}`).join(', ')}), ` +
        `${launches.length} CLI launches (${launches.filter((l) => l.resume).length} with --resume), at most ${maxLive} alive in ${samples} samples, ${storedEvents} stored events, heap ${Math.round(warm / 1e6)} → ${Math.round(peak / 1e6)} MB peak`;
      console.log(summary);
      if (process.env.OIDE_SOAK_DEBUG) appendFileSync(process.env.OIDE_SOAK_DEBUG, `${summary}\n`);
    },
  );
});
