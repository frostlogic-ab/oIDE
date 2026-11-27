import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { net, session } from 'electron';
import type { TelemetryTarget } from '@oide/protocol';
import { stableUserAgent, type Transport } from './umami.js';

/**
 * The network side of telemetry (Electron only). Requests go through a dedicated in-memory session
 * (`oide-telemetry`, no cache, no cookies kept, no permissions) whose request filter lets through
 * only the Umami origin compiled into this build. The window's session cannot reach the network at
 * all (security/hardening.ts), and nothing here touches it.
 */

/** A session that can reach only `target.origin` (https). */
export function telemetrySession(target: TelemetryTarget): Electron.Session {
  const ses = session.fromPartition('oide-telemetry', { cache: false });
  // Error reports cannot carry `userAgent` in the payload; the header keeps them version-free too.
  ses.setUserAgent(stableUserAgent(process.platform));
  ses.setPermissionRequestHandler((_wc, _p, cb) => cb(false));
  ses.setPermissionCheckHandler(() => false);
  ses.webRequest.onBeforeRequest((details, cb) => {
    let ok: boolean;
    try {
      const u = new URL(details.url);
      ok = u.protocol === 'https:' && u.origin === target.origin;
    } catch {
      ok = false;
    }
    cb({ cancel: !ok });
  });
  return ses;
}

/** `session.fetch` to the Umami host: POST, no credentials, no redirects. */
export function electronTransport(target: TelemetryTarget): Transport {
  const ses = telemetrySession(target);
  return async (url, init) => {
    const res = await ses.fetch(url, {
      method: 'POST',
      body: init.body,
      headers: init.headers,
      signal: init.signal,
      credentials: 'omit',
      redirect: 'error',
      cache: 'no-store',
    });
    return { status: res.status, headers: res.headers, json: () => res.json() };
  };
}

export const isOnline = (): boolean => {
  try {
    return net.isOnline();
  } catch {
    return true;
  }
};

/**
 * E2E only (unpackaged builds, `OIDE_TELEMETRY_SINK=<file>`): every request is appended to the file
 * as one JSON line `{ url, headers, body }` instead of going to the network, and answered with 200.
 */
export function fileSinkTransport(file: string): Transport {
  mkdirSync(dirname(file), { recursive: true });
  return async (url, init) => {
    appendFileSync(
      file,
      JSON.stringify({ url, headers: init.headers, body: JSON.parse(init.body) as unknown }) + '\n',
      'utf8',
    );
    return { status: 200, headers: { get: () => null }, json: async () => ({ cache: 'sink' }) };
  };
}
