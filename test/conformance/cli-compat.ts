import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inTestedRange, parseHelpFeatures, parseLine } from '../../packages/agent-core/src/index.js';
import { TESTED_CLI_RANGE } from '../../packages/protocol/src/index.js';

/**
 * CLI compatibility analysis for the weekly job (.github/workflows/cli-compat.yml): compares a fresh
 * recording from tools/fake-claude/record.mjs with the parser's expectations and the fixtures oIDE
 * was built against (tools/fake-claude/fixtures). Pure functions; the test file does the I/O.
 */

export const FIXTURES = join(import.meta.dirname, '..', '..', 'tools', 'fake-claude', 'fixtures');
export const BASELINE_HELP = 'help-2.1.325.txt';

/** Normalized events a scripted session (record.mjs SESSION_TURNS) must produce. */
export const REQUIRED_SESSION_EVENTS = ['init', 'assistant-text', 'tool-use', 'tool-result', 'usage', 'result'] as const;

export interface Finding {
  level: 'drift' | 'info';
  message: string;
}

const flagsIn = (help: string) => new Set([...help.matchAll(/(?<![\w-])--([A-Za-z][\w-]*)/g)].map((m) => m[1]!));

export function analyzeHelp(help: string, baseline: string): { findings: Finding[]; features: Record<string, boolean> } {
  const now = parseHelpFeatures(help);
  const before = parseHelpFeatures(baseline);
  const findings: Finding[] = [];
  for (const [k, v] of Object.entries(before)) {
    if (v && !now[k]) findings.push({ level: 'drift', message: `\`${k}\` was detected in the baseline help and is missing now (oIDE uses it)` });
  }
  for (const [k, v] of Object.entries(now)) if (v && !before[k]) findings.push({ level: 'info', message: `new detected feature \`${k}\`` });
  const flagsNow = flagsIn(help);
  const flagsBefore = flagsIn(baseline);
  const added = [...flagsNow].filter((f) => !flagsBefore.has(f)).sort();
  const removed = [...flagsBefore].filter((f) => !flagsNow.has(f)).sort();
  if (added.length) findings.push({ level: 'info', message: `new flags: ${added.map((f) => `\`--${f}\``).join(', ')}` });
  if (removed.length) findings.push({ level: 'info', message: `flags gone from help: ${removed.map((f) => `\`--${f}\``).join(', ')}` });
  return { findings, features: now };
}

export function analyzeVersion(version: string | undefined): Finding[] {
  if (!version) return [{ level: 'drift', message: 'no CLI version recorded' }];
  return inTestedRange(version) ? [] : [{ level: 'drift', message: `CLI ${version} is outside the tested range ${TESTED_CLI_RANGE.min} to ${TESTED_CLI_RANGE.max}` }];
}

export interface SessionStats {
  lines: number;
  rawTypes: Record<string, number>;
  eventTypes: Record<string, number>;
  unknownRawTypes: Record<string, number>;
  nonJson: number;
}

function rawType(json: unknown): string {
  if (!json || typeof json !== 'object') return typeof json;
  const o = json as { type?: unknown; subtype?: unknown; event?: { type?: unknown } };
  const sub = o.type === 'stream_event' ? o.event?.type : o.subtype;
  return `${String(o.type ?? '?')}${sub ? `/${String(sub)}` : ''}`;
}

const bump = (m: Record<string, number>, k: string) => {
  m[k] = (m[k] ?? 0) + 1;
};

export function sessionStats(text: string): SessionStats {
  const s: SessionStats = { lines: 0, rawTypes: {}, eventTypes: {}, unknownRawTypes: {}, nonJson: 0 };
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    s.lines++;
    const parsed = parseLine(line);
    if (parsed.json === null) s.nonJson++;
    else bump(s.rawTypes, rawType(parsed.json));
    for (const e of parsed.events) {
      bump(s.eventTypes, e.type);
      if (e.type === 'unknown') bump(s.unknownRawTypes, (e as { rawType?: string }).rawType ?? '?');
    }
  }
  return s;
}

/** Raw event types and unknown types across every recorded real-CLI fixture (`real-*.jsonl`). */
export function baselineStats(dir = FIXTURES): { rawTypes: Set<string>; unknown: Set<string> } {
  const rawTypes = new Set<string>();
  const unknown = new Set<string>();
  for (const f of readdirSync(dir).filter((n) => /^real-.*\.jsonl$/.test(n))) {
    const s = sessionStats(readFileSync(join(dir, f), 'utf8'));
    for (const k of Object.keys(s.rawTypes)) rawTypes.add(k);
    for (const k of Object.keys(s.unknownRawTypes)) unknown.add(k);
  }
  return { rawTypes, unknown };
}

export function analyzeSession(text: string, baseline = baselineStats()): { findings: Finding[]; stats: SessionStats } {
  const stats = sessionStats(text);
  const findings: Finding[] = [];
  if (stats.lines === 0) return { findings: [{ level: 'drift', message: 'the scripted session produced no output' }], stats };
  for (const t of REQUIRED_SESSION_EVENTS) if (!stats.eventTypes[t]) findings.push({ level: 'drift', message: `no \`${t}\` event parsed from the session (expected from the scripted turns)` });
  for (const [t, n] of Object.entries(stats.unknownRawTypes)) {
    if (!baseline.unknown.has(t)) findings.push({ level: 'drift', message: `parser returned \`unknown\` for \`${t}\` (${n}×), not seen in the baseline fixtures` });
  }
  if (stats.nonJson) findings.push({ level: 'drift', message: `${stats.nonJson} non-JSON stdout line(s)` });
  const fresh = Object.keys(stats.rawTypes).filter((t) => !baseline.rawTypes.has(t));
  if (fresh.length) findings.push({ level: 'info', message: `raw event types not in the baseline fixtures: ${fresh.map((t) => `\`${t}\``).join(', ')}` });
  return { findings, stats };
}

export function renderReport(input: { version?: string; meta?: Record<string, unknown>; sections: Array<{ title: string; findings: Finding[]; extra?: string }> }): string {
  const drift = input.sections.some((s) => s.findings.some((f) => f.level === 'drift'));
  const out = [
    `# CLI compatibility: ${input.version ?? 'unknown version'}`,
    '',
    drift ? '**Drift found.** The parser or the flags oIDE relies on no longer match this CLI.' : 'No drift found.',
    '',
    `Tested range in \`packages/protocol\`: ${TESTED_CLI_RANGE.min} to ${TESTED_CLI_RANGE.max}.`,
  ];
  if (input.meta) out.push('', '```json', JSON.stringify(input.meta, null, 2), '```');
  for (const s of input.sections) {
    out.push('', `## ${s.title}`, '');
    if (!s.findings.length) out.push('Nothing to report.');
    for (const f of s.findings) out.push(`- ${f.level === 'drift' ? '**drift**' : 'info'}: ${f.message}`);
    if (s.extra) out.push('', s.extra);
  }
  return out.join('\n') + '\n';
}
