import { describe, expect, it } from 'vitest';
import { assertSafeAuthorizationUrl } from '../src/oauth.js';

describe('assertSafeAuthorizationUrl', () => {
  it('allows https and loopback http only', () => {
    expect(() => assertSafeAuthorizationUrl(new URL('https://auth.example.com/authorize?x=1'))).not.toThrow();
    expect(() => assertSafeAuthorizationUrl(new URL('http://127.0.0.1:8123/authorize'))).not.toThrow();
    for (const bad of ['http://evil.example.com/a', 'file:///C:/Windows/System32/calc.exe', 'ms-msdt:/id', 'javascript:alert(1)', 'https://user:pw@auth.example.com/']) {
      expect(() => assertSafeAuthorizationUrl(new URL(bad))).toThrow();
    }
  });
});
