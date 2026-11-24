import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzeHelp, analyzeSession, analyzeVersion, BASELINE_HELP, baselineStats, FIXTURES, renderReport, type Finding } from './cli-compat.js';

/**
 * Weekly CLI compatibility diff (.github/workflows/cli-compat.yml). The gated part runs only when
 * OIDE_COMPAT_DIR points at a folder written by tools/fake-claude/record.mjs:
 *
 *   node tools/fake-claude/record.mjs --out .compat [--session]
 *   $env:OIDE_COMPAT_DIR = '.compat'; node node_modules/vitest/vitest.mjs run test/conformance/cli-compat.test.ts
 *
 * It writes report.md and drift.json into that folder and fails when it finds drift. The ungated
 * part checks the analysis itself against the recorded baseline fixtures.
 */

const baselineHelp = readFileSync(join(FIXTURES, BASELINE_HELP), 'utf8');

describe('cli-compat analysis (baseline fixtures)', () => {
  it('finds no drift between the baseline help and itself', () => {
    expect(analyzeHelp(baselineHelp, baselineHelp).findings).toEqual([]);
  });

  it('reports a removed flag that oIDE relies on as drift', () => {
    const { findings } = analyzeHelp(baselineHelp.replace(/--forward-subagent-text/g, '--something-else'), baselineHelp);
    expect(findings.filter((f) => f.level === 'drift').map((f) => f.message).join('\n')).toMatch(/forward-subagent-text/);
  });

  it('parses every recorded real-CLI fixture with the expected events', () => {
    const base = baselineStats();
    expect(base.rawTypes.size).toBeGreaterThan(5);
    const multi = readFileSync(join(FIXTURES, 'real-basic-multiturn.jsonl'), 'utf8');
    const { stats, findings } = analyzeSession(multi, base);
    expect(stats.eventTypes.init).toBeGreaterThan(0);
    expect(stats.eventTypes.result).toBeGreaterThan(0);
    expect(findings.filter((f) => f.level === 'drift' && /unknown|non-JSON/.test(f.message))).toEqual([]);
  });

  it('flags an event type the parser does not know', () => {
    const line = JSON.stringify({ type: 'brand_new_event', session_id: 's' });
    const { findings } = analyzeSession(`${line}\n`, { rawTypes: new Set(), unknown: new Set() });
    expect(findings.some((f) => f.level === 'drift' && /brand_new_event/.test(f.message))).toBe(true);
  });

  it('flags a version outside the tested range', () => {
    expect(analyzeVersion('2.1.325')).toEqual([]);
    expect(analyzeVersion('9.0.0')[0]?.level).toBe('drift');
  });
});

const dir = process.env.OIDE_COMPAT_DIR;

describe.skipIf(!dir)('cli-compat: fresh recording in OIDE_COMPAT_DIR', () => {
  it('matches the parser and the flags oIDE relies on', () => {
    const d = dir!;
    const meta = existsSync(join(d, 'meta.json')) ? (JSON.parse(readFileSync(join(d, 'meta.json'), 'utf8')) as Record<string, unknown>) : {};
    const version = typeof meta.version === 'string' ? meta.version : /(\d+\.\d+\.\d+)/.exec(existsSync(join(d, 'version.txt')) ? readFileSync(join(d, 'version.txt'), 'utf8') : '')?.[1];
    const sections: Array<{ title: string; findings: Finding[]; extra?: string }> = [{ title: 'Version', findings: analyzeVersion(version) }];

    if (existsSync(join(d, 'help.txt'))) {
      const { findings, features } = analyzeHelp(readFileSync(join(d, 'help.txt'), 'utf8'), baselineHelp);
      const on = Object.entries(features).filter(([, v]) => v).map(([k]) => k);
      sections.push({ title: `\`claude --help\` against ${BASELINE_HELP}`, findings, extra: `Detected features: ${on.map((k) => `\`${k}\``).join(', ')}` });
    } else {
      sections.push({ title: '`claude --help`', findings: [{ level: 'drift', message: 'help.txt missing' }] });
    }

    const sessionFile = join(d, 'session-basic.jsonl');
    if (existsSync(sessionFile)) {
      const { findings, stats } = analyzeSession(readFileSync(sessionFile, 'utf8'));
      const table = ['| Raw type | Count |', '| --- | --- |', ...Object.entries(stats.rawTypes).sort().map(([k, n]) => `| \`${k}\` | ${n} |`)].join('\n');
      sections.push({ title: 'Scripted stream-json session', findings, extra: table });
    } else {
      sections.push({ title: 'Scripted stream-json session', findings: [{ level: 'info', message: 'not recorded (needs a signed-in CLI on the opt-in self-hosted runner)' }] });
    }

    const report = renderReport({ ...(version ? { version } : {}), meta, sections });
    const drift = sections.flatMap((s) => s.findings).filter((f) => f.level === 'drift');
    writeFileSync(join(d, 'report.md'), report);
    writeFileSync(join(d, 'drift.json'), JSON.stringify({ version, drift: drift.length > 0, findings: drift }, null, 2) + '\n');
    expect(drift, report).toEqual([]);
  });
});
