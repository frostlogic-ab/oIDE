import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { auth, type OAuthClientProvider, type OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { FetchFn, OpenExternal, SecretStore } from './interfaces.js';

/**
 * MCP authorization for remote custom servers (build brief, Add custom › MCP server URL):
 * protected-resource metadata, dynamic client registration (or a pasted client id), PKCE in the
 * system browser with a loopback redirect on 127.0.0.1. Tokens live only in the SecretStore and
 * the main process; agents reach the server through the loopback proxy.
 */

export const oauthKeys = {
  tokens: (id: string) => `custom/${id}/oauth/tokens`,
  client: (id: string) => `custom/${id}/oauth/client`,
  discovery: (id: string) => `custom/${id}/oauth/discovery`,
  header: (id: string) => `custom/${id}/header`,
  /** The origin (`https://host:port`) the tokens above were entered or issued for (SEC-09). */
  origin: (id: string) => `custom/${id}/origin`,
};

/** Every keychain key that holds a remote server's credentials. */
export function credentialKeys(id: string): string[] {
  return [oauthKeys.tokens(id), oauthKeys.client(id), oauthKeys.discovery(id), oauthKeys.header(id), oauthKeys.origin(id)];
}

/** `https://host:port` of a URL, or null when it does not parse. */
export function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** Bind the stored credentials of `serverId` to the origin of `url`. */
export async function bindCredentialOrigin(secrets: SecretStore, serverId: string, url: string): Promise<void> {
  const o = originOf(url);
  if (o) await secrets.set(oauthKeys.origin(serverId), o);
}

/**
 * Whether stored credentials may be sent to `url`: only when they were bound to its origin. A
 * record whose URL moved to another host must sign in again (SEC-09).
 */
export async function credentialsMatch(secrets: SecretStore, serverId: string, url: string): Promise<boolean> {
  const bound = await secrets.get(oauthKeys.origin(serverId));
  return bound !== undefined && bound === originOf(url);
}

interface StoredTokens extends OAuthTokens {
  /** ms since epoch; computed from expires_in when saved. */
  expires_at?: number;
}

export interface ProviderOptions {
  serverId: string;
  secrets: SecretStore;
  redirectUrl?: string;
  /** Open question 13: a client id the user pasted for servers without dynamic registration. */
  clientId?: string;
  clientSecret?: string;
  scope?: string;
  onRedirect?: (url: URL) => void | Promise<void>;
  now?: () => number;
}

/**
 * The authorization URL comes from a remote server's metadata. Only open https URLs (or http on
 * loopback for local servers) without embedded credentials, never `file:` or custom protocol handlers.
 */
export function assertSafeAuthorizationUrl(u: URL): void {
  const loopback = ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(u.hostname);
  if (!(u.protocol === 'https:' || (u.protocol === 'http:' && loopback))) throw new Error(`Refusing to open a non-https authorization URL (${u.protocol})`);
  if (u.username || u.password) throw new Error('Refusing an authorization URL with embedded credentials');
}

async function readJson<T>(s: SecretStore, key: string): Promise<T | undefined> {
  const raw = await s.get(key);
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

/** OAuthClientProvider backed by the keychain. */
export class SecretOAuthProvider implements OAuthClientProvider {
  private verifier: string | undefined;
  private readonly stateValue = randomBytes(16).toString('base64url');

  constructor(private readonly o: ProviderOptions) {}

  get redirectUrl(): string | undefined {
    return this.o.redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    const m: OAuthClientMetadata = {
      client_name: 'oIDE',
      redirect_uris: this.o.redirectUrl ? [this.o.redirectUrl] : [],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: this.o.clientSecret ? 'client_secret_post' : 'none',
    };
    if (this.o.scope) m.scope = this.o.scope;
    return m;
  }

  state(): string {
    return this.stateValue;
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    if (this.o.clientId) {
      const info: OAuthClientInformationMixed = { client_id: this.o.clientId };
      if (this.o.clientSecret) info.client_secret = this.o.clientSecret;
      return info;
    }
    const stored = await readJson<OAuthClientInformationMixed & { redirect_uris?: string[] }>(this.o.secrets, oauthKeys.client(this.o.serverId));
    // A dynamically registered client is bound to its redirect URI (the loopback port changes).
    if (stored && this.o.redirectUrl && stored.redirect_uris && !stored.redirect_uris.includes(this.o.redirectUrl)) return undefined;
    return stored;
  }

  async saveClientInformation(info: OAuthClientInformationMixed): Promise<void> {
    if (this.o.clientId) return;
    await this.o.secrets.set(oauthKeys.client(this.o.serverId), JSON.stringify(info));
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    const t = await readJson<StoredTokens>(this.o.secrets, oauthKeys.tokens(this.o.serverId));
    if (!t) return undefined;
    const { expires_at: _e, ...rest } = t;
    return rest;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    const now = (this.o.now ?? Date.now)();
    const prev = await readJson<StoredTokens>(this.o.secrets, oauthKeys.tokens(this.o.serverId));
    const stored: StoredTokens = { ...tokens };
    if (!stored.refresh_token && prev?.refresh_token) stored.refresh_token = prev.refresh_token;
    if (tokens.expires_in !== undefined) stored.expires_at = now + tokens.expires_in * 1000;
    await this.o.secrets.set(oauthKeys.tokens(this.o.serverId), JSON.stringify(stored));
  }

  async redirectToAuthorization(url: URL): Promise<void> {
    if (!this.o.onRedirect) throw new NeedsSignInError();
    await this.o.onRedirect(url);
  }

  saveCodeVerifier(v: string): void {
    this.verifier = v;
  }

  codeVerifier(): string {
    if (!this.verifier) throw new Error('no PKCE code verifier');
    return this.verifier;
  }

  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    await this.o.secrets.set(oauthKeys.discovery(this.o.serverId), JSON.stringify(state));
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    return readJson<OAuthDiscoveryState>(this.o.secrets, oauthKeys.discovery(this.o.serverId));
  }

  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): Promise<void> {
    const s = this.o.secrets;
    const id = this.o.serverId;
    if (scope === 'all' || scope === 'tokens') await s.delete(oauthKeys.tokens(id));
    if (scope === 'all' || scope === 'client') await s.delete(oauthKeys.client(id));
    if (scope === 'all' || scope === 'discovery') await s.delete(oauthKeys.discovery(id));
    if (scope === 'all' || scope === 'verifier') this.verifier = undefined;
  }
}

export class NeedsSignInError extends Error {
  constructor() {
    super('This server needs you to sign in again');
    this.name = 'NeedsSignInError';
  }
}

/** A one-shot loopback HTTP listener for the OAuth redirect. */
export async function startLoopback(opts: { port?: number; path?: string } = {}): Promise<{ redirectUrl: string; waitForCode(state: string, timeoutMs: number): Promise<string>; close(): void }> {
  const pathName = opts.path ?? '/callback';
  let deliver: ((r: { code?: string; state?: string; error?: string }) => void) | null = null;
  const early: Array<{ code?: string; state?: string; error?: string }> = [];
  const server: Server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (u.pathname !== pathName) {
      res.writeHead(404).end();
      return;
    }
    const r: { code?: string; state?: string; error?: string } = {};
    const code = u.searchParams.get('code');
    const state = u.searchParams.get('state');
    const error = u.searchParams.get('error');
    if (code) r.code = code;
    if (state) r.state = state;
    if (error) r.error = error;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(`<!doctype html><meta charset="utf-8"><title>oIDE</title><body style="font-family:system-ui;background:#0E1013;color:#E6E8EB;padding:40px">${r.error ? 'Sign-in failed. You can close this window.' : 'Signed in. You can close this window and return to oIDE.'}</body>`);
    if (deliver) deliver(r);
    else early.push(r);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return {
    redirectUrl: `http://127.0.0.1:${port}${pathName}`,
    waitForCode(state, timeoutMs) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Sign-in timed out')), timeoutMs);
        const handle = (r: { code?: string; state?: string; error?: string }) => {
          if (r.state !== state) return; // ignore stray requests
          clearTimeout(timer);
          if (r.error || !r.code) reject(new Error(`Sign-in failed: ${r.error ?? 'no code'}`));
          else resolve(r.code);
        };
        deliver = handle;
        for (const r of early.splice(0)) handle(r);
      });
    },
    close() {
      server.close();
      server.closeAllConnections?.();
    },
  };
}

export interface AuthorizeOptions {
  serverId: string;
  url: string;
  secrets: SecretStore;
  openExternal: OpenExternal;
  clientId?: string;
  clientSecret?: string;
  scope?: string;
  timeoutMs?: number;
  fetch?: FetchFn;
  /** Fixed loopback port, for pre-registered clients whose redirect URI names one. */
  port?: number;
}

/** Run the MCP authorization flow in the system browser. Tokens go to the SecretStore. */
export async function authorize(o: AuthorizeOptions): Promise<{ ok: boolean; error?: string }> {
  const loop = await startLoopback(o.port !== undefined ? { port: o.port } : {});
  try {
    let redirected = false;
    const providerOpts: ProviderOptions = {
      serverId: o.serverId,
      secrets: o.secrets,
      redirectUrl: loop.redirectUrl,
      onRedirect: async (u) => {
        assertSafeAuthorizationUrl(u);
        redirected = true;
        await o.openExternal(u.toString());
      },
    };
    if (o.clientId) providerOpts.clientId = o.clientId;
    if (o.clientSecret) providerOpts.clientSecret = o.clientSecret;
    if (o.scope) providerOpts.scope = o.scope;
    const provider = new SecretOAuthProvider(providerOpts);
    const base = { serverUrl: o.url, ...(o.fetch ? { fetchFn: o.fetch } : {}), ...(o.scope ? { scope: o.scope } : {}) };
    const first = await auth(provider, base);
    if (first === 'AUTHORIZED' && !redirected) {
      await bindCredentialOrigin(o.secrets, o.serverId, o.url);
      return { ok: true };
    }
    const code = await loop.waitForCode(provider.state(), o.timeoutMs ?? 5 * 60_000);
    const second = await auth(provider, { ...base, authorizationCode: code });
    if (second === 'AUTHORIZED') await bindCredentialOrigin(o.secrets, o.serverId, o.url);
    return second === 'AUTHORIZED' ? { ok: true } : { ok: false, error: 'Authorization did not complete' };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    loop.close();
  }
}

/**
 * Supplies the auth header for a remote server (used by the MCP proxy): a pasted header token,
 * or the OAuth access token, refreshed when it expires or the server answers 401.
 */
export class TokenSource {
  constructor(
    private readonly o: { serverId: string; url: string; secrets: SecretStore; fetch?: FetchFn; now?: () => number; clientId?: string },
  ) {}

  async headers(): Promise<Record<string, string>> {
    // Never attach a token to an upstream other than the one it was entered for (SEC-09).
    if (!(await credentialsMatch(this.o.secrets, this.o.serverId, this.o.url))) return {};
    const header = await readJson<{ header: string; value: string }>(this.o.secrets, oauthKeys.header(this.o.serverId));
    if (header) return { [header.header]: header.value };
    const t = await readJson<StoredTokens>(this.o.secrets, oauthKeys.tokens(this.o.serverId));
    if (!t) return {};
    const now = (this.o.now ?? Date.now)();
    if (t.expires_at !== undefined && t.expires_at - 60_000 < now && t.refresh_token) {
      if (await this.refresh()) return this.headers();
    }
    return { authorization: `${/^bearer$/i.test(t.token_type) ? 'Bearer' : t.token_type} ${t.access_token}` };
  }

  /** Refresh with the stored refresh token. False when the user has to sign in again. */
  async refresh(): Promise<boolean> {
    if (!(await credentialsMatch(this.o.secrets, this.o.serverId, this.o.url))) return false;
    const t = await readJson<StoredTokens>(this.o.secrets, oauthKeys.tokens(this.o.serverId));
    if (!t?.refresh_token) return false;
    // The SDK only refreshes in interactive mode, so reuse the registered client's redirect URI;
    // with no onRedirect, a failed refresh ends in NeedsSignInError instead of opening a browser.
    const client = await readJson<{ redirect_uris?: string[] }>(this.o.secrets, oauthKeys.client(this.o.serverId));
    const providerOpts: ProviderOptions = { serverId: this.o.serverId, secrets: this.o.secrets, redirectUrl: client?.redirect_uris?.[0] ?? 'http://127.0.0.1/callback' };
    if (this.o.clientId) providerOpts.clientId = this.o.clientId;
    if (this.o.now) providerOpts.now = this.o.now;
    const provider = new SecretOAuthProvider(providerOpts);
    try {
      const r = await auth(provider, { serverUrl: this.o.url, ...(this.o.fetch ? { fetchFn: this.o.fetch } : {}) });
      return r === 'AUTHORIZED';
    } catch {
      return false;
    }
  }
}

/** Open question 13 fallback: store a token to send as a header. */
export async function saveHeaderToken(secrets: SecretStore, serverId: string, header: string, token: string, url: string): Promise<void> {
  if (!/^[A-Za-z0-9-]+$/.test(header)) throw new Error('Invalid header name');
  await secrets.set(oauthKeys.header(serverId), JSON.stringify({ header, value: token }));
  await bindCredentialOrigin(secrets, serverId, url);
}
