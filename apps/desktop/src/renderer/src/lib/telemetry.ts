/**
 * Renderer side of opt-in telemetry (ADR 0011, docs/wiki/pages/telemetry.md). The renderer never
 * talks to the network: it reports to main over `telemetry.track`, and main validates every report
 * against the catalogue (packages/protocol/src/telemetry.ts), applies consent and may drop it.
 *
 * What it reports, only while the matching switch is on (main checks again):
 * - screen views as pageviews (screen id and, for Settings, the section id; never agent ids or paths);
 * - web vitals per screen visit (FCP, LCP and TTFB of the first screen; CLS and INP of every visit);
 * - a perf summary every 30 minutes: sampled IPC round trips (p50 / p95), long tasks, JS heap bucket,
 *   and Wall render time with the number of agents on it;
 * - built-in command bar commands (never extension commands);
 * - messages to an artifact agent (kind, number of preview comments, whether text was typed);
 * - uncaught errors and unhandled rejections (main scrubs them before anything leaves).
 *   Screen error boundaries already report through `app.reportError`.
 */
import {
  BUILTIN_COMMAND_IDS,
  countBucket,
  memoryBucket,
  TELEMETRY_SCREENS,
  type ArtifactKind,
  type TelemetryScreen,
  type TelemetryTrackInput,
} from '@oide/protocol';
import { useAgents } from '../stores/agents';
import { useRouter, type Route } from '../stores/router';
import { useSettings } from '../stores/settings';
import { oide, setInvokeTimer } from './bridge';

const usageOn = (): boolean => !!useSettings.getState().settings?.privacy?.usageAnalytics;
const errorsOn = (): boolean => !!useSettings.getState().settings?.privacy?.errorReports;

function send(input: TelemetryTrackInput): void {
  try {
    void oide.invoke('telemetry.track', input).catch(() => undefined);
  } catch {
    /* no bridge */
  }
}

// ------------------------------------------------------------------------------- sampling

/** One in this many IPC round trips is timed. */
export const IPC_SAMPLE_EVERY = 10;
const MAX_SAMPLES = 2000;
let ipcCounter = 0;
const ipcSamples: number[] = [];
const wallSamples: number[] = [];
let wallAgentsMax = 0;
let longTasks = 0;

/** Timer for every `oide.invoke` (lib/bridge.ts; telemetry commands are excluded there). */
export function recordIpc(ms: number): void {
  if (++ipcCounter % IPC_SAMPLE_EVERY !== 0 || !Number.isFinite(ms) || ms < 0) return;
  if (ipcSamples.length < MAX_SAMPLES) ipcSamples.push(ms);
}

export function percentile(sorted: readonly number[], p: number): number | undefined {
  if (!sorted.length) return undefined;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}

/** The perf summary for the last window, then reset (exported for tests). */
export function takePerfSummary(windowMin: number): Record<string, number | string> {
  const ipc = [...ipcSamples].sort((a, b) => a - b);
  const wall = [...wallSamples].sort((a, b) => a - b);
  const out: Record<string, number | string> = {
    window_min: Math.max(1, Math.min(1440, Math.round(windowMin))),
    ipc_samples: Math.min(ipc.length, 10_000),
    long_tasks: Math.min(longTasks, 10_000),
  };
  const p50 = percentile(ipc, 50);
  const p95 = percentile(ipc, 95);
  if (p50 !== undefined) out.ipc_p50_ms = Math.round(p50);
  if (p95 !== undefined) out.ipc_p95_ms = Math.round(p95);
  const heap = (performance as unknown as { memory?: { usedJSHeapSize?: number } }).memory?.usedJSHeapSize;
  if (typeof heap === 'number') out.memory = memoryBucket(heap);
  const w50 = percentile(wall, 50);
  if (w50 !== undefined) {
    out.wall_render_ms = Math.round(w50);
    out.wall_agents = countBucket(wallAgentsMax);
  }
  ipcSamples.length = 0;
  wallSamples.length = 0;
  wallAgentsMax = 0;
  longTasks = 0;
  return out;
}

/** A built-in command bar command ran. Extension commands are never reported. */
export function trackCommand(id: string, source: 'core' | 'extension' | undefined): void {
  if (source !== 'core' || !usageOn() || !(BUILTIN_COMMAND_IDS as readonly string[]).includes(id)) return;
  send({ type: 'event', name: 'command_palette_used', props: { command: id } });
}

/**
 * A message to an artifact agent (Artifacts › open view): the artifact's kind, how many preview
 * comments went with it and whether the user typed text too. Never the text or the comments.
 */
export function trackArtifactAgentMessage(kind: ArtifactKind, feedback: number, hasText: boolean): void {
  if (!usageOn()) return;
  send({ type: 'event', name: 'artifact_agent_message', props: { kind, feedback: Math.max(0, Math.min(10_000, Math.round(feedback))), has_text: hasText } });
}

/** A Markdown tab in Files switched between its preview and editing beside it. Never the file. */
export function trackMarkdownView(view: 'preview' | 'edit', via: 'button' | 'shortcut'): void {
  if (!usageOn()) return;
  send({ type: 'event', name: 'files_markdown_view', props: { view, via } });
}

/** Install or No for a language server that is not installed (the Files toast, or the tab bar's server menu). Never the server or its command. */
export function trackLanguageServerInstall(choice: 'install' | 'declined', via: 'prompt' | 'menu'): void {
  if (!usageOn()) return;
  send({ type: 'event', name: 'language_server_install', props: { choice, via } });
}

/** A changed file's tab in Files switched between its changes (unified, side by side) and the plain editor. Never the file. */
export function trackDiffView(view: 'off' | 'unified' | 'split'): void {
  if (!usageOn()) return;
  send({ type: 'event', name: 'files_diff_view', props: { view } });
}

/** Files › package.json: a newer-version hint opened Spawn with an upgrade goal. */
export function trackDependencyUpgrade(bump: 'major' | 'minor' | 'patch' | 'prerelease', via: 'click' | 'menu'): void {
  if (!usageOn()) return;
  send({ type: 'event', name: 'files_dependency_upgrade', props: { bump, via } });
}

// ----------------------------------------------------------------------------- vitals

interface Visit {
  screen: TelemetryScreen;
  section?: string;
  first: boolean;
  cls: number;
  clsWindow: { start: number; last: number; value: number };
  inp: Map<number, number>;
}

function screenOf(route: Route): { screen: TelemetryScreen; section?: string } | null {
  if (!(TELEMETRY_SCREENS as readonly string[]).includes(route.screen)) return null;
  const section = route.screen === 'settings' ? route.params.section : undefined;
  return { screen: route.screen as TelemetryScreen, ...(section ? { section } : {}) };
}

function observe(
  type: string,
  fn: (e: PerformanceEntry) => void,
  extra: Record<string, unknown> = {},
): () => void {
  try {
    const po = new PerformanceObserver((list) => list.getEntries().forEach(fn));
    po.observe({ type, buffered: true, ...extra } as PerformanceObserverInit);
    return () => po.disconnect();
  } catch {
    return () => undefined;
  }
}

/**
 * Starts the renderer's telemetry. Called once from `startStores` (lib/boot.ts). Cheap when the
 * switches are off: observers only count in memory and nothing is sent.
 */
export function connectTelemetry(
  opts: { summaryEveryMs?: number; firstSummaryMs?: number } = {},
): () => void {
  const offs: Array<() => void> = [];
  setInvokeTimer(recordIpc);
  offs.push(() => setInvokeTimer(null));
  const page = {
    fcp: undefined as number | undefined,
    lcp: undefined as number | undefined,
    ttfb: undefined as number | undefined,
  };
  let visit: Visit | null = null;

  offs.push(observe('paint', (e) => void (e.name === 'first-contentful-paint' && (page.fcp = e.startTime))));
  offs.push(observe('largest-contentful-paint', (e) => void (page.lcp = e.startTime)));
  offs.push(
    observe(
      'navigation',
      (e) => void (page.ttfb = Math.max(0, (e as PerformanceNavigationTiming).responseStart)),
    ),
  );
  offs.push(observe('longtask', () => void longTasks++));
  offs.push(
    observe('layout-shift', (e) => {
      const ls = e as PerformanceEntry & { value: number; hadRecentInput: boolean };
      if (!visit || ls.hadRecentInput) return;
      const w = visit.clsWindow;
      // Session windows as in Umami's tracker: gaps under 1 s, windows under 5 s; the largest wins.
      if (w.value > 0 && e.startTime - w.last < 1000 && e.startTime - w.start < 5000) {
        w.value += ls.value;
        w.last = e.startTime;
      } else visit.clsWindow = { start: e.startTime, last: e.startTime, value: ls.value };
      visit.cls = Math.max(visit.cls, visit.clsWindow.value);
    }),
  );
  offs.push(
    observe(
      'event',
      (e) => {
        const ev = e as PerformanceEntry & { interactionId?: number };
        if (!visit || !ev.interactionId) return;
        visit.inp.set(ev.interactionId, Math.max(visit.inp.get(ev.interactionId) ?? 0, e.duration));
      },
      { durationThreshold: 40 },
    ),
  );

  const endVisit = () => {
    const v = visit;
    visit = null;
    if (!v || !usageOn()) return;
    const durations = [...v.inp.values()].sort((a, b) => b - a);
    const inp = durations.length
      ? durations[Math.min(durations.length - 1, Math.floor(0.02 * Math.max(durations.length, 10)))]
      : undefined;
    const vitals: Record<string, number> = {};
    if (v.first) {
      if (page.fcp !== undefined) vitals.fcp = page.fcp;
      if (page.lcp !== undefined) vitals.lcp = page.lcp;
      if (page.ttfb !== undefined) vitals.ttfb = page.ttfb;
    }
    if (v.cls > 0) vitals.cls = v.cls;
    if (inp !== undefined) vitals.inp = inp;
    if (!Object.keys(vitals).length) return;
    send({ type: 'vitals', screen: v.screen, ...(v.section ? { section: v.section } : {}), ...vitals });
  };

  let first = true;
  let lastKey = '';
  const onRoute = (route: Route) => {
    const s = screenOf(route);
    if (!s) return;
    const key = `${s.screen}/${s.section ?? ''}`;
    if (key === lastKey) return;
    lastKey = key;
    endVisit();
    visit = { ...s, first, cls: 0, clsWindow: { start: 0, last: 0, value: 0 }, inp: new Map() };
    first = false;
    if (usageOn()) send({ type: 'pageview', ...s });
    if (s.screen === 'wall') {
      const t0 = performance.now();
      const n = useAgents.getState().order.length;
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          if (wallSamples.length < MAX_SAMPLES) wallSamples.push(performance.now() - t0);
          wallAgentsMax = Math.max(wallAgentsMax, n);
        }),
      );
    }
  };
  // The first pageview waits for settings, so a user who already opted in is counted on launch.
  let sentInitial = false;
  const initial = () => {
    if (sentInitial || !useSettings.getState().settings) return;
    sentInitial = true;
    onRoute(useRouter.getState().route);
  };
  initial();
  offs.push(useSettings.subscribe(initial));
  offs.push(
    useRouter.subscribe((s, prev) => {
      if (s.route !== prev.route && sentInitial) onRoute(s.route);
    }),
  );
  const onHidden = () => {
    if (document.visibilityState === 'hidden') endVisit();
  };
  document.addEventListener('visibilitychange', onHidden);
  offs.push(() => document.removeEventListener('visibilitychange', onHidden));

  // Uncaught errors and unhandled rejections (main scrubs them; dropped unless error reports are on).
  const onError = (e: ErrorEvent) => {
    if (!errorsOn() || !e.message) return;
    const err = e.error as { name?: unknown; stack?: unknown } | undefined;
    send({
      type: 'error',
      source: 'window',
      name: String(err?.name ?? 'Error').slice(0, 120),
      message: e.message.slice(0, 2000),
      ...(typeof err?.stack === 'string' ? { stack: err.stack.slice(0, 8000) } : {}),
    });
  };
  const onRejection = (e: PromiseRejectionEvent) => {
    if (!errorsOn()) return;
    const r = e.reason as { name?: unknown; message?: unknown; stack?: unknown } | undefined;
    const message =
      typeof r?.message === 'string'
        ? r.message
        : typeof e.reason === 'string'
          ? e.reason
          : 'Unhandled rejection';
    send({
      type: 'error',
      source: 'unhandledrejection',
      name: String(r?.name ?? 'Error').slice(0, 120),
      message: message.slice(0, 2000),
      ...(typeof r?.stack === 'string' ? { stack: r.stack.slice(0, 8000) } : {}),
    });
  };
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
  offs.push(() => window.removeEventListener('error', onError));
  offs.push(() => window.removeEventListener('unhandledrejection', onRejection));

  // Perf summary: first after 10 minutes, then every 30 (aggregated, never per call).
  const every = opts.summaryEveryMs ?? 30 * 60_000;
  let since = performance.now();
  const summary = () => {
    const now = performance.now();
    const props = takePerfSummary((now - since) / 60_000);
    since = now;
    if (usageOn()) send({ type: 'event', name: 'perf_summary', props });
  };
  let interval: ReturnType<typeof setInterval> | undefined;
  const firstTimer = setTimeout(
    () => {
      summary();
      interval = setInterval(summary, every);
    },
    opts.firstSummaryMs ?? 10 * 60_000,
  );
  offs.push(() => {
    clearTimeout(firstTimer);
    if (interval) clearInterval(interval);
  });

  return () => offs.forEach((off) => off());
}
