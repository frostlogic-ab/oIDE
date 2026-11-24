import { describe, expect, it, vi } from 'vitest';

/**
 * Security round 2, SEC-33 (medium). SEC-18 turned WebRTC off with
 * `setWebRTCIPHandlingPolicy('disable_non_proxied_udp')`, but that policy only removes UDP: on
 * Electron 45 a sandboxed iframe with `RTCPeerConnection({ iceServers: [{ urls:
 * 'turn:<host>:443?transport=tcp' }], iceTransportPolicy: 'relay' })` still opened TCP connections
 * to the TURN host (5 connections to a listener on a LAN address in the round-2 experiment), and
 * CSP (`connect-src 'none'`, even `webrtc 'block'`) does not stop it. Artifact previews (untrusted
 * repo HTML) and extension panels could send data anywhere.
 * Secure behaviour: the default session routes every non-loopback connection to a proxy that does
 * not exist (`NO_NETWORK_PROXY`), which the same experiment showed blocks TURN over TCP (0
 * connections) while loopback (dev server, Browser preview) stays direct.
 */
const calls = vi.hoisted(() => ({ proxy: [] as unknown[], created: [] as Array<(e: unknown, c: unknown) => void> }));
vi.mock('electron', () => ({
  app: { on: (ev: string, fn: (e: unknown, c: unknown) => void) => void (ev === 'web-contents-created' && calls.created.push(fn)) },
  shell: { openExternal: () => undefined },
  session: {
    defaultSession: {
      setPermissionRequestHandler: () => undefined,
      setPermissionCheckHandler: () => undefined,
      setProxy: async (cfg: unknown) => void calls.proxy.push(cfg),
      webRequest: { onHeadersReceived: () => undefined },
    },
  },
}));

const { hardenApp } = await import('../../apps/desktop/src/main/security/hardening.js');

describe('SEC-33 the window session has no route to the network', () => {
  it('sets a dead fixed proxy with no direct fallback and no bypass beyond loopback', async () => {
    await hardenApp({ isAppUrl: () => true, dev: false });
    expect(calls.proxy).toHaveLength(1);
    const cfg = calls.proxy[0] as { mode: string; proxyRules: string; proxyBypassRules?: string };
    expect(cfg.mode).toBe('fixed_servers');
    expect(cfg.proxyRules).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(cfg.proxyRules.toLowerCase()).not.toContain('direct');
    expect(cfg.proxyBypassRules ?? '').toBe('');
  });

  it('keeps the WebRTC policy on every webContents', () => {
    const policies: string[] = [];
    const contents = {
      setWebRTCIPHandlingPolicy: (p: string) => void policies.push(p),
      setWindowOpenHandler: () => undefined,
      on: () => undefined,
    };
    for (const fn of calls.created) fn({}, contents);
    expect(policies).toEqual(['disable_non_proxied_udp']);
  });
});
