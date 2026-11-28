/**
 * Usage (status bar › Tokens today): tokens and agent sessions over the last 7 days, 30 days or
 * year, per project and model, when you start sessions, and a few facts about how you work. All of
 * it is measured locally by oIDE (`usage.stats`); see docs/wiki/pages/screen-usage.md.
 */
import { useEffect, useId, useMemo, useState } from 'react';
import { tokenSum, type UsageRange, type UsageStats } from '@oide/protocol';
import { Button, EmptyState, SegmentedControl, Spinner, cn } from '@oide/ui';
import { ipcErrorMessage, oide } from '../../lib/bridge';
import { formatTokens, plural } from '../../lib/format';
import { navigate, useRouter } from '../../stores/router';
import { RANGE_LABEL, changeText, dayBars, facts, hourBars, niceMax, percent, weekdayBars, type Bar } from './model';

const RANGES: Array<{ value: UsageRange; label: string }> = [
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: '1y', label: '1 year' },
];

function useUsageStats(range: UsageRange) {
  const [state, setState] = useState<{ stats?: UsageStats; loading: boolean; error?: string }>({ loading: true });
  /** Bumped by Try again to rerun the load for the same range. */
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setState((s) => ({ stats: s.stats, loading: true }));
    oide
      .invoke('usage.stats', { range })
      .then((stats) => live && setState({ stats, loading: false }))
      .catch((err: unknown) => live && setState((s) => ({ ...s, loading: false, error: ipcErrorMessage(err) })));
    return () => {
      live = false;
    };
  }, [range, attempt]);
  return { ...state, retry: () => setAttempt((n) => n + 1) };
}

export default function UsageScreen() {
  // The range is a route param, so Back returns to it; switching replaces the route (no history).
  const range = useRouter((s) => (s.route.screen === 'usage' ? s.route.params.range : undefined)) ?? '7d';
  const setRange = (r: UsageRange) => useRouter.getState().replace('usage', { range: r });
  const { stats, loading, error, retry } = useUsageStats(range);
  // After a failed switch the previous range's numbers stay on screen: keep them dimmed so they are
  // not read as the range the selector shows.
  const stale = loading || (!!stats && stats.range !== range);

  return (
    <div className="flex-1 min-w-0 h-full overflow-y-auto bg-ground">
      <div className="max-w-[1120px] mx-auto px-6 py-5 flex flex-col gap-4">
        <div className="flex items-center gap-3 flex-wrap">
          <SegmentedControl label="Time range" options={RANGES} value={range} onChange={setRange} variant="inset" size={28} />
          {loading && stats && <Spinner size={14} label="Updating" />}
          <div className="flex-1" />
          <span className="text-[11.5px] text-ink-3">Measured on this computer by oIDE, from what the Claude Code CLI reports.</span>
        </div>

        {error && !stats && (
          <EmptyState
            icon="alert-circle"
            role="alert"
            title="Usage could not be loaded"
            description={error}
            action={
              <Button size={32} onClick={retry}>
                Try again
              </Button>
            }
          />
        )}
        {error && stats && (
          <div role="alert" className="flex items-center gap-3 px-3 py-2 rounded-lg border border-bad-line bg-bad-bg text-[12.5px] text-ink">
            <span className="flex-1 min-w-0">
              Couldn't load {RANGE_LABEL[range].toLowerCase()}: {error}
              {stats.range !== range ? ` Showing ${RANGE_LABEL[stats.range].toLowerCase()}.` : ''}
            </span>
            <Button size={28} onClick={retry}>
              Try again
            </Button>
          </div>
        )}
        {!stats && !error && (
          <div className="flex justify-center py-16">
            <Spinner size={20} label="Loading usage" />
          </div>
        )}
        {/* Refetch keeps the frame: the previous range stays, dimmed, until the new one arrives. */}
        {stats && <Stats stats={stats} stale={stale} />}
      </div>
    </div>
  );
}

function Stats({ stats, stale }: { stats: UsageStats; stale: boolean }) {
  const total = tokenSum(stats.totals);
  const tokenBars = useMemo(() => dayBars(stats.range, stats.days, (d) => tokenSum(d.tokens)), [stats]);
  const sessionBars = useMemo(() => dayBars(stats.range, stats.days, (d) => d.sessions), [stats]);
  const per = stats.range === '1y' ? 'week' : 'day';
  const empty = total === 0 && stats.sessions.total === 0;
  const list = facts(stats);

  return (
    <div className={cn('flex flex-col gap-4 transition-opacity', stale && 'opacity-60')} aria-busy={stale}>
      <h1 className="sr-only">Usage, {RANGE_LABEL[stats.range].toLowerCase()}</h1>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Tile label="Tokens" value={formatTokens(total)} detail={changeText(stats) ?? `${formatTokens(stats.totals.output)} output`} />
        <Tile label="Agent sessions" value={String(stats.sessions.total)} detail={stats.sessions.subagents ? `${plural(stats.sessions.subagents, 'subagent')} spawned` : RANGE_LABEL[stats.range]} />
        <Tile label="Active days" value={`${stats.activeDays} / ${stats.days.length}`} detail={stats.currentStreak > 1 ? `${stats.currentStreak}-day streak` : RANGE_LABEL[stats.range]} />
        <Tile label="Projects" value={String(stats.projects.length)} detail={stats.projects[0] ? `Most: ${stats.projects[0].name}` : 'None yet'} />
      </div>

      {empty ? (
        <Card title="Nothing yet">
          <EmptyState
            icon="agents"
            title="No agent sessions in this range"
            description="Spawn an agent and its tokens and sessions show up here."
            action={
              <Button variant="primary" size={32} onClick={() => navigate('spawn', {})}>
                Spawn an agent
              </Button>
            }
          />
        </Card>
      ) : (
        <>
          <Card title={`Tokens per ${per}`} aside={`${formatTokens(total)} total`}>
            <BarChart bars={tokenBars} name="Tokens" format={formatTokens} height={180} />
          </Card>
          <Card title={`Agent sessions per ${per}`} aside={plural(stats.sessions.total, 'session')}>
            <BarChart bars={sessionBars} name="Sessions" format={String} height={120} />
          </Card>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Card title="By project">
              <MeterList
                caption="Sessions and tokens per project"
                rows={stats.projects.map((p) => ({ key: p.projectId ?? 'unknown', name: p.name, value: p.tokens, cells: [plural(p.sessions, 'session'), formatTokens(p.tokens)] }))}
                headers={['Sessions', 'Tokens']}
                empty="No projects in this range."
              />
            </Card>
            <Card title="Token mix">
              <MeterList
                caption="Tokens by kind"
                rows={[
                  { key: 'input', name: 'Input', value: stats.totals.input },
                  { key: 'output', name: 'Output', value: stats.totals.output },
                  { key: 'cache-read', name: 'Cache read', value: stats.totals.cacheRead },
                  { key: 'cache-write', name: 'Cache write', value: stats.totals.cacheCreation },
                ].map((r) => ({ ...r, cells: [formatTokens(r.value), percent(r.value, total)] }))}
                headers={['Tokens', 'Share']}
                empty="No tokens in this range."
              />
              {stats.models.length > 0 && (
                <>
                  <h3 className="mt-4 mb-2 text-[11px] font-semibold uppercase tracking-[0.04em] text-ink-3">Models</h3>
                  <MeterList
                    caption="Tokens per model"
                    rows={stats.models.slice(0, 6).map((m) => ({ key: m.model, name: m.model, mono: true, value: m.tokens, cells: [formatTokens(m.tokens), percent(m.tokens, total)] }))}
                    headers={['Tokens', 'Share']}
                    empty=""
                  />
                </>
              )}
            </Card>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Card title="When you start sessions" aside="Local time">
              <BarChart bars={hourBars(stats.hours)} name="Sessions" format={String} height={110} />
            </Card>
            <Card title="Sessions by weekday">
              <BarChart bars={weekdayBars(stats.weekdays)} name="Sessions" format={String} height={110} />
            </Card>
          </div>

          {list.length > 0 && (
            <Card title="How you work">
              <dl className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-6 gap-y-3">
                {list.map((f) => (
                  <div key={f.id} className="flex flex-col gap-0.5 min-w-0" data-testid={`fact-${f.id}`}>
                    <dt className="text-[11.5px] text-ink-3">{f.label}</dt>
                    <dd className="m-0 text-[14px] font-semibold text-ink truncate">{f.value}</dd>
                    {f.detail && <dd className="m-0 text-[11.5px] text-ink-3 truncate">{f.detail}</dd>}
                  </div>
                ))}
              </dl>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

function Tile({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="flex flex-col gap-1 px-4 py-3 rounded-[10px] bg-card border border-line min-w-0">
      <span className="text-[11.5px] text-ink-3">{label}</span>
      <span className="text-[22px] leading-7 font-semibold text-ink font-mono truncate">{value}</span>
      <span className="text-[11.5px] text-ink-3 truncate">{detail}</span>
    </div>
  );
}

function Card({ title, aside, children }: { title: string; aside?: string; children: React.ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="rounded-[12px] bg-panel border border-line px-4 py-3.5 min-w-0">
      <div className="flex items-baseline gap-2 mb-3">
        <h2 id={id} className="m-0 text-[13px] font-semibold text-ink">
          {title}
        </h2>
        <div className="flex-1" />
        {aside && <span className="text-[11.5px] text-ink-3">{aside}</span>}
      </div>
      {children}
    </section>
  );
}

/**
 * A single-series column chart in HTML: accent bars on a recessive grid, a tooltip on hover and
 * keyboard focus (each column, wider than its bar, is the hit target), and a table for screen readers.
 */
export function BarChart({ bars, name, format, height }: { bars: Bar[]; name: string; format: (n: number) => string; height: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = niceMax(Math.max(0, ...bars.map((b) => b.value)));
  const ticks = [max, max / 2, 0];
  const active = hover !== null ? bars[hover] : undefined;

  return (
    <div className="flex flex-col gap-1.5" onMouseLeave={() => setHover(null)}>
      <div className="relative flex" style={{ height }}>
        {/* y axis + grid */}
        <div className="absolute inset-0 pointer-events-none" aria-hidden="true">
          {ticks.map((t, i) => (
            <div key={i} className="absolute left-0 right-0 flex items-center gap-2" style={{ top: `${(i / (ticks.length - 1)) * 100}%`, transform: 'translateY(-50%)' }}>
              <span className="w-10 shrink-0 text-right text-[10.5px] font-mono text-ink-3">{format(t)}</span>
              <span className={cn('flex-1 h-px', t === 0 ? 'bg-line-3' : 'bg-line')} />
            </div>
          ))}
        </div>
        <div className="absolute top-0 bottom-0 left-12 right-0 flex items-end" role="presentation">
          {bars.map((b, i) => {
            const pct = (b.value / max) * 100;
            return (
              <div
                key={b.key}
                tabIndex={0}
                role="img"
                aria-label={`${b.label}: ${format(b.value)} ${name.toLowerCase()}`}
                onMouseEnter={() => setHover(i)}
                onFocus={() => setHover(i)}
                onBlur={() => setHover((h) => (h === i ? null : h))}
                className="relative flex-1 h-full flex items-end justify-center outline-none focus-visible:bg-selected rounded-[4px]"
                data-testid="bar"
              >
                <div
                  className={cn('w-[calc(100%-2px)] max-w-[28px] rounded-t-[4px] bg-accent transition-opacity', hover !== null && hover !== i && 'opacity-55')}
                  style={{ height: b.value > 0 ? `max(${pct}%, 2px)` : 0 }}
                />
                {hover === i && active && (
                  <div
                    role="tooltip"
                    className={cn(
                      'absolute z-10 px-2 py-1.5 rounded-md bg-raised border border-line-3 shadow-lg whitespace-nowrap pointer-events-none',
                      i < bars.length / 3 ? 'left-0' : i > (bars.length * 2) / 3 ? 'right-0' : 'left-1/2 -translate-x-1/2',
                    )}
                    style={{ bottom: `calc(${Math.min(pct, 100)}% + 6px)` }}
                  >
                    <div className="text-[12.5px] font-semibold text-ink font-mono">{format(active.value)}</div>
                    <div className="text-[11px] text-ink-3">
                      {active.label} · {name}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
      <div className="flex pl-12" aria-hidden="true">
        {bars.map((b) => (
          <div key={b.key} className="flex-1 min-w-0 relative h-3.5">
            {b.tick && <span className="absolute left-1/2 -translate-x-1/2 text-[10.5px] text-ink-3 whitespace-nowrap">{b.tick}</span>}
          </div>
        ))}
      </div>
      <table className="sr-only">
        <caption>{name}</caption>
        <thead>
          <tr>
            <th scope="col">Period</th>
            <th scope="col">{name}</th>
          </tr>
        </thead>
        <tbody>
          {bars.map((b) => (
            <tr key={b.key}>
              <th scope="row">{b.label}</th>
              <td>{format(b.value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface MeterRow {
  key: string;
  name: string;
  value: number;
  cells: string[];
  mono?: boolean;
}

/** Rows with a name, a thin single-hue meter (share of the largest row) and values: a table. */
function MeterList({ rows, headers, caption, empty }: { rows: MeterRow[]; headers: string[]; caption: string; empty: string }) {
  const max = Math.max(0, ...rows.map((r) => r.value));
  if (!rows.length) return empty ? <p className="m-0 text-[12px] text-ink-3">{empty}</p> : null;
  return (
    <table className="w-full border-collapse text-[12.5px]">
      <caption className="sr-only">{caption}</caption>
      <thead className="sr-only">
        <tr>
          <th scope="col">Name</th>
          {headers.map((h) => (
            <th key={h} scope="col">
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key} className="align-middle">
            <th scope="row" className="py-1.5 pr-3 text-left font-normal w-[45%] max-w-0">
              <div className={cn('text-ink-2 truncate', r.mono && 'font-mono text-[11.5px]')} title={r.name}>
                {r.name}
              </div>
              <div className="mt-1 h-1 rounded-full bg-line overflow-hidden" aria-hidden="true">
                <div className="h-full rounded-full bg-accent" style={{ width: `${max > 0 ? (r.value / max) * 100 : 0}%` }} />
              </div>
            </th>
            {r.cells.map((c, i) => (
              <td key={i} className="py-1.5 pl-3 text-right font-mono text-[11.5px] text-ink-2 whitespace-nowrap">
                {c}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
