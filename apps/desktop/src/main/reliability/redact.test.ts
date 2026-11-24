import { describe, expect, it } from 'vitest';
import { REDACTED, Redactor } from './redact.js';

const HOME = 'C:\\Users\\Jane Doe';
const USERDATA = 'C:\\Users\\Jane Doe\\AppData\\Roaming\\oIDE';
const r = new Redactor({ home: HOME, paths: { [USERDATA]: '<userData>' } });

describe('Redactor', () => {
  it('removes well-known token shapes', () => {
    const s = r.string('keys sk-ant-api03-abcdefghijklmnop ghp_abcdefghijklmnopqrstuvwxyz0123 github_pat_11ABCDEFG0123456789_abcdefghij xoxb-1234567890-abcdef AKIAABCDEFGHIJKLMNOP eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk');
    expect(s).not.toMatch(/sk-ant|ghp_|github_pat_|xoxb-|AKIA|eyJhbGci/);
    expect(s.split(REDACTED).length - 1).toBe(6);
  });

  it('removes bearer tokens, secret key/value pairs and URL credentials', () => {
    expect(r.string('Authorization: Bearer abc.def.ghi-123')).not.toContain('abc.def');
    expect(r.string('api_key=supersecretvalue next')).toBe(`api_key=${REDACTED} next`);
    expect(r.string('{"password": "hunter2hunter2"}')).toBe(`{"password": "${REDACTED}"}`);
    expect(r.string('https://user:pa55word@example.com/repo.git')).toBe(`https://${REDACTED}@example.com/repo.git`);
    expect(r.string('https://x.test/cb?code=abc123&state=1')).toBe(`https://x.test/cb?code=${REDACTED}&state=1`);
    // Counts that merely mention tokens stay readable.
    expect(r.string('input_tokens=1200')).toBe('input_tokens=1200');
  });

  it('replaces home and userData paths in both slash styles, case-insensitively, with spaces', () => {
    expect(r.string(`opened ${USERDATA}\\oide.db`)).toBe('opened <userData>\\oide.db');
    expect(r.string('c:/users/jane doe/projects/app')).toBe('~/projects/app');
    expect(r.string('file:///C:/Users/Jane%20Doe/x.txt')).toBe('file:///~/x.txt');
  });

  it('handles unicode home folders', () => {
    const u = new Redactor({ home: '/home/zoë 文' });
    expect(u.string('/home/zoë 文/proj/ünï.ts')).toBe('~/proj/ünï.ts');
  });

  it('removes registered secret values and env secrets', () => {
    const x = new Redactor({ home: '/nowhere' });
    x.addSecret('per-agent-secret-0001');
    x.addEnvSecrets({ MY_API_TOKEN: 'tok-value-123456', PATH: '/usr/bin' });
    expect(x.string('header per-agent-secret-0001 and tok-value-123456 in /usr/bin')).toBe(`header ${REDACTED} and ${REDACTED} in /usr/bin`);
  });

  it('deep-redacts objects: secret keys, every env value, errors, cycles', () => {
    const obj: Record<string, unknown> = { token: 'abcdef123456', inputTokens: 12, env: { PATH: '/bin', HOME: HOME }, nested: { path: `${HOME}\\a` }, err: new Error(`failed in ${HOME}\\x`) };
    obj.self = obj;
    const v = r.value(obj) as Record<string, unknown>;
    expect(v.token).toBe(REDACTED);
    expect(v.inputTokens).toBe(12);
    expect(v.env).toEqual({ PATH: REDACTED, HOME: REDACTED });
    expect((v.nested as { path: string }).path).toBe('~\\a');
    expect((v.err as { message: string }).message).toBe('failed in ~\\x');
    expect(v.self).toBe('[circular]');
  });

  it('formats log arguments into one line and caps long strings', () => {
    const x = new Redactor({ home: '/h', maxString: 20 });
    expect(x.format(['a', { b: 1 }])).toBe('a {"b":1}');
    expect(x.string('x'.repeat(50))).toMatch(/^x{20}… \[30 more chars]$/);
  });
});
