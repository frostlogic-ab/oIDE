import { app, session, shell, type WebContents } from 'electron';
import { isAllowedExternalUrl } from './external.js';
import { buildCsp } from './csp.js';

/**
 * Process-wide Electron hardening: every webContents (current and future) refuses navigation away
 * from the app, refuses window.open and <webview>, and opens allow-listed https links in the
 * system browser. Permissions are denied except clipboard writes.
 */
export function hardenApp(opts: { isAppUrl: (url: string) => boolean; dev: boolean }): void {
  const openIfAllowed = (url: string) => {
    if (isAllowedExternalUrl(url)) void shell.openExternal(url);
  };

  const guard = (contents: WebContents) => {
    // SEC-18: CSP's connect-src does not cover WebRTC; an artifact preview could otherwise leak
    // data to a STUN/TURN host. oIDE uses no WebRTC, so UDP and non-proxied candidates are off.
    contents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
    contents.setWindowOpenHandler(({ url }) => {
      openIfAllowed(url);
      return { action: 'deny' };
    });
    const onNavigate = (event: Electron.Event, url: string) => {
      if (opts.isAppUrl(url)) return;
      event.preventDefault();
      openIfAllowed(url);
    };
    contents.on('will-navigate', onNavigate);
    contents.on('will-redirect', onNavigate);
    contents.on('will-attach-webview', (event) => event.preventDefault());
  };

  app.on('web-contents-created', (_e, contents) => guard(contents));

  const ses = session.defaultSession;
  const allowed = new Set(['clipboard-sanitized-write']);
  ses.setPermissionRequestHandler((_wc, permission, callback) => callback(allowed.has(permission)));
  ses.setPermissionCheckHandler((_wc, permission) => allowed.has(permission));

  // Header CSP for http(s) responses (the dev server). Packaged builds load file:// where the
  // <meta> tag injected at build time applies.
  const csp = buildCsp({ dev: opts.dev });
  ses.webRequest.onHeadersReceived((details, callback) => {
    const headers = { ...details.responseHeaders };
    if (details.resourceType === 'mainFrame' && opts.isAppUrl(details.url)) {
      headers['Content-Security-Policy'] = [csp];
    }
    callback({ responseHeaders: headers });
  });
}
