import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authorize, oauthKeys, saveHeaderToken, TokenSource } from '../src/oauth.js';
import { memorySecrets } from './helpers.js';

/** A fake MCP authorization server + protected resource (RFC 9728, RFC 8414, RFC 7591, PKCE). */
let server: Server;
let base = '';
const challenges = new Map<string, string>();
const log: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', base);
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      log.push(`${req.method} ${u.pathname}`);
      if (u.pathname.startsWith('/.well-known/oauth-protected-resource')) return json(200, { resource: `${base}/mcp`, authorization_servers: [base] });
      if (u.pathname.startsWith('/.well-known/oauth-authorization-server'))
        return json(200, {
          issuer: base,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          registration_endpoint: `${base}/register`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['none'],
        });
      if (u.pathname === '/register') {
        const meta = JSON.parse(body) as Record<string, unknown>;
        return json(201, { ...meta, client_id: 'cid-dyn' });
      }
      if (u.pathname === '/authorize') {
        const code = `code-${challenges.size + 1}`;
        challenges.set(code, u.searchParams.get('code_challenge') ?? '');
        const back = new URL(u.searchParams.get('redirect_uri') ?? '');
        back.searchParams.set('code', code);
        back.searchParams.set('state', u.searchParams.get('state') ?? '');
        res.writeHead(302, { location: back.toString() }).end();
        return;
      }
      if (u.pathname === '/token') {
        const p = new URLSearchParams(body);
        if (p.get('grant_type') === 'authorization_code') {
          const challenge = challenges.get(p.get('code') ?? '');
          const verifier = p.get('code_verifier') ?? '';
          if (!challenge || createHash('sha256').update(verifier).digest('base64url') !== challenge) return json(400, { error: 'invalid_grant' });
          return json(200, { access_token: `at-${p.get('client_id')}`, token_type: 'Bearer', expires_in: 3600, refresh_token: 'rt-1' });
        }
        if (p.get('grant_type') === 'refresh_token' && p.get('refresh_token') === 'rt-1') return json(200, { access_token: 'at-refreshed', token_type: 'Bearer', expires_in: 3600 });
        return json(400, { error: 'invalid_grant' });
      }
      json(404, {});
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.closeAllConnections();
  server.close();
});

/** Stands in for the system browser: follows the authorize redirect to the loopback callback. */
const browser = async (url: string) => {
  void fetch(url, { redirect: 'follow' });
};

describe('MCP authorization', () => {
  it('discovers, registers a client, runs PKCE through the loopback redirect and stores tokens in the keychain', async () => {
    const secrets = memorySecrets();
    const opened: string[] = [];
    const r = await authorize({ serverId: 's1', url: `${base}/mcp`, secrets, openExternal: (u) => (opened.push(u), browser(u)), timeoutMs: 10_000 });
    expect(r).toEqual({ ok: true });
    expect(opened[0]).toMatch(/\/authorize\?/);
    expect(opened[0]).toContain('code_challenge_method=S256');
    expect(log).toContain('POST /register');
    const tokens = JSON.parse(secrets.data.get(oauthKeys.tokens('s1')) ?? '{}');
    expect(tokens.access_token).toBe('at-cid-dyn');
    expect(typeof tokens.expires_at).toBe('number');

    let now = Date.now();
    const src = new TokenSource({ serverId: 's1', url: `${base}/mcp`, secrets, now: () => now });
    expect(await src.headers()).toEqual({ authorization: 'Bearer at-cid-dyn' });
    now += 2 * 3600 * 1000; // expired: refresh with the stored refresh token
    expect(await src.headers()).toEqual({ authorization: 'Bearer at-refreshed' });
    expect(JSON.parse(secrets.data.get(oauthKeys.tokens('s1')) ?? '{}').refresh_token).toBe('rt-1');
  });

  it('uses a pasted client id instead of dynamic registration', async () => {
    const secrets = memorySecrets();
    log.length = 0;
    const r = await authorize({ serverId: 's2', url: `${base}/mcp`, secrets, clientId: 'pasted-id', openExternal: browser, timeoutMs: 10_000 });
    expect(r).toEqual({ ok: true });
    expect(log).not.toContain('POST /register');
    expect(JSON.parse(secrets.data.get(oauthKeys.tokens('s2')) ?? '{}').access_token).toBe('at-pasted-id');
  });

  it('falls back to a header token', async () => {
    const secrets = memorySecrets();
    await saveHeaderToken(secrets, 's3', 'X-Api-Key', 'k');
    expect(await new TokenSource({ serverId: 's3', url: `${base}/mcp`, secrets }).headers()).toEqual({ 'X-Api-Key': 'k' });
    await expect(saveHeaderToken(secrets, 's3', 'bad header\n', 'k')).rejects.toThrow();
  });
});
