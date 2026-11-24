import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { LogManager, Redactor } from '../../apps/desktop/src/main/reliability/index.js';

/**
 * Security round 2, SEC-35 (low). `app.reportError` lets the renderer put any `screen` name,
 * message and stack (up to ~18 KB, no rate limit) into `main.log`/`renderer.log`, and the logger
 * wrote strings with their line breaks as they were: a report could add lines that look like
 * genuine entries ("2026-… ERROR [main] update signature check passed"), which a user then pastes
 * into a bug report or a maintainer trusts. The formatter also printed only `stack` for any object
 * that had one, so the redacted error name and message of a report were dropped.
 * Secure behaviour: continuation lines are indented (no entry can be forged), the message is kept,
 * and reports are rate-limited (REPORTS_PER_MINUTE in handlers/app.ts).
 */
const dir = mkdtempSync(join(tmpdir(), 'oide-sec-logs-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('SEC-35 log lines cannot be forged', () => {
  it('indents every continuation line and keeps the report message', () => {
    const logs = new LogManager({ dir, redactor: new Redactor({ home: 'C:\\Users\\nobody' }) });
    const forged = '2026-11-25T00:00:00.000Z ERROR [main] forged entry';
    logs.channel('renderer').error(`screen "Wall\n${forged}" crashed`, {
      name: 'TypeError',
      message: 'boom',
      stack: `TypeError: boom\r\n${forged}\u2028${forged}`,
    });
    logs.close();
    const text = readFileSync(join(dir, 'renderer.log'), 'utf8');
    const lines = text.split('\n').filter(Boolean);
    expect(lines.filter((l) => /^\d{4}-\d\d-\d\dT/.test(l))).toHaveLength(1);
    expect(lines.some((l) => l.startsWith(forged))).toBe(false);
    expect(text).toContain('boom');
    expect(text).toContain('TypeError');
  });
});
