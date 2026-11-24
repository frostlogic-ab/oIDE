import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { removeSync } from './fs-safe.js';
import { LogManager, parseLevel } from './logger.js';
import { REDACTED, Redactor } from './redact.js';

const dirs: string[] = [];
function tmp(prefix = 'oide-logs-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) removeSync(d);
});

describe('LogManager', () => {
  it('writes main, extension host and per-agent logs with levels, redacted', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const dir = tmp();
    const logs = new LogManager({ dir, level: 'info', redactor: new Redactor({ home: '/home/me' }) });
    logs.main.debug('hidden');
    logs.main.info('opened /home/me/proj', { apiKey: 'abcdefghijkl' });
    logs.channel('extension-host').warn('host crashed', { code: 7 });
    logs.agent('a-1').info('status running → error');
    logs.close();
    const main = readFileSync(join(dir, 'main.log'), 'utf8');
    expect(main).not.toContain('hidden');
    expect(main).toMatch(/INFO {2}\[main] opened ~\/proj \{"apiKey":"\[redacted]"}/);
    expect(main).not.toContain('abcdefghijkl');
    expect(readFileSync(join(dir, 'extension-host.log'), 'utf8')).toContain('WARN  [extension-host] host crashed');
    expect(readFileSync(join(dir, 'agents', 'a-1.log'), 'utf8')).toContain('status running → error');
    expect(REDACTED).toBe('[redacted]');
  });

  it('rotates by size and keeps maxFiles', () => {
    const dir = tmp();
    const logs = new LogManager({ dir, maxBytes: 200, maxFiles: 2, flushMs: 1 });
    for (let i = 0; i < 30; i++) {
      logs.main.info(`line ${i} ${'x'.repeat(40)}`);
      logs.flush();
    }
    logs.close();
    const files = readdirSync(dir).sort();
    expect(files).toEqual(['main.1.log', 'main.2.log', 'main.log']);
    expect(readFileSync(join(dir, 'main.log'), 'utf8')).toContain('line 29');
  });

  it('prunes files older than the retention, also under agents/', () => {
    const dir = tmp();
    mkdirSync(join(dir, 'agents'));
    const old = join(dir, 'agents', 'gone.log');
    writeFileSync(old, 'x');
    writeFileSync(join(dir, 'main.log'), 'y');
    const t = (Date.now() - 30 * 86400_000) / 1000;
    utimesSync(old, t, t);
    const logs = new LogManager({ dir, retentionDays: 14 });
    expect(logs.prune()).toEqual([old]);
    expect(existsSync(join(dir, 'main.log'))).toBe(true);
  });

  it('never throws when the folder cannot be written; pauses file logging', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const base = tmp();
    const blocker = join(base, 'not-a-dir');
    writeFileSync(blocker, 'file in the way');
    const logs = new LogManager({ dir: blocker });
    expect(() => logs.main.error('boom')).not.toThrow();
    expect(logs.fileLoggingDisabled).toBe(true);
  });

  it('works in folders with spaces and unicode', () => {
    const dir = join(tmp('oide logs ünï 文-'), 'logs');
    const logs = new LogManager({ dir });
    logs.main.info('hello');
    logs.close();
    expect(readFileSync(join(dir, 'main.log'), 'utf8')).toContain('hello');
  });

  it('sanitises channel names', () => {
    const dir = tmp();
    const logs = new LogManager({ dir });
    logs.channel('../../evil').info('x');
    logs.close();
    // `..` segments become `_`, at most two segments: the file stays inside the logs folder.
    expect(existsSync(join(dir, '_', '_.log'))).toBe(true);
    expect(existsSync(join(dir, '..', 'evil.log'))).toBe(false);
  });

  it('parseLevel', () => {
    expect(parseLevel('DEBUG', 'info')).toBe('debug');
    expect(parseLevel('nope', 'warn')).toBe('warn');
    expect(parseLevel(undefined, 'info')).toBe('info');
  });
});
