import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { removeSync } from './fs-safe.js';
import { CrashReports, readCrashReportsPref, reduceStack, stripContent, stripPaths, writeCrashReportsPref } from './crash-reports.js';
import { Redactor } from './redact.js';

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'oide crash ü-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) removeSync(d);
});

function reports(enabled: boolean) {
  const userData = tmp();
  return { userData, cr: new CrashReports({ dir: join(userData, 'crash-reports'), userDataDir: userData, enabled, redactor: new Redactor({ home: '/home/me' }), appVersion: '1.2.3' }) };
}

describe('crash reports', () => {
  it('are off by default and write nothing', () => {
    const { userData, cr } = reports(readCrashReportsPref(tmp()));
    expect(cr.enabled).toBe(false);
    expect(cr.record('renderer-gone', { reason: 'crashed', exitCode: 1 })).toBeNull();
    expect(existsSync(join(userData, 'crash-reports'))).toBe(false);
  });

  it('strip paths, prompts and code from the summary', () => {
    const { cr } = reports(true);
    const err = new Error('Failed on "please refactor the billing module and keep tests" in C:\\Users\\me\\secret-proj\\src\\billing.ts with key sk-ant-api03-abcdefghijkl');
    err.stack = `Error: x\n    at handle (C:\\Users\\me\\secret-proj\\src\\billing.ts:10:5)\n    at /home/me/app/out/main/index.js:3:1\n    const code = "do not leak"`;
    const file = cr.record('main-exception', { process: 'main', error: err });
    expect(file).toBeTruthy();
    const text = readFileSync(file!, 'utf8');
    expect(text).not.toMatch(/secret-proj|please refactor|sk-ant|Users|home\/me|do not leak/);
    const s = JSON.parse(text);
    expect(s).toMatchObject({ kind: 'main-exception', process: 'main', app: { version: '1.2.3' } });
    expect(s.error.stack).toEqual(['at handle (billing.ts:10:5)', 'at <anonymous> (index.js:3:1)']);
    expect(s.error.message).toContain('<path>/billing.ts');
  });

  it('keep only the newest summaries', () => {
    const { cr } = reports(true);
    const c2 = new CrashReports({ dir: cr.dir, userDataDir: tmp(), enabled: true, redactor: new Redactor(), appVersion: '1', keep: 3, now: (() => { let t = Date.now(); return () => (t += 1000); })() });
    for (let i = 0; i < 6; i++) c2.record('renderer-gone', { reason: `r${i}` });
    expect(readdirSync(cr.dir).filter((f) => f.endsWith('.json'))).toHaveLength(3);
    expect(c2.list()[0]!.reason).toBe('r5');
  });

  it('turning off deletes local reports and minidumps and updates the preference file', () => {
    const { userData, cr } = reports(true);
    cr.record('renderer-gone', { reason: 'oom' });
    mkdirSync(cr.nativeDir, { recursive: true });
    writeFileSync(join(cr.nativeDir, 'x.dmp'), 'MDMP');
    cr.setEnabled(false);
    expect(existsSync(cr.dir)).toBe(false);
    expect(readCrashReportsPref(userData)).toBe(false);
    writeCrashReportsPref(userData, true);
    expect(readCrashReportsPref(userData)).toBe(true);
  });

  it('helpers', () => {
    expect(stripPaths('see /Users/bob/x/y.txt and file:///home/bob/z.md')).toBe('see <path>/y.txt and <path>/z.md');
    expect(stripPaths('at C:\\work\\repo\\file.ts:1')).toBe('at <path>/file.ts:1');
    expect(stripContent('Unexpected token in `const a = 1`')).toBe('Unexpected token in `…`');
    expect(reduceStack(undefined)).toEqual([]);
  });
});
