import { app, session, shell, type WebContents } from 'electron';
import { isAllowedExternalUrl } from './external.js';
import { buildCsp } from './csp.js';
import { permissionAllowed } from './permissions.js';

/**
 * Process-wide Electron hardening: every webContents (current and future) refuses navigation away
 * from the app, refuses window.open and <webview>, and opens allow-listed https links in the
 * system browser. Permissions are denied except clipboard writes (and clipboard reads by the app page).
 */
/**
 * Proxy of the default session (the app window, artifact previews and extension panels; the
 * updater has its own session). SEC-33: `disable_non_proxied_udp` still lets WebRTC reach a TURN
 * server over TCP (checked on Electron 45: a sandboxed iframe connected to `turn:…?transport=tcp`),
 * and CSP does not cover WebRTC, so a preview or panel could send data anywhere. Every non-loopback
 * connection of this session therefore goes to a proxy that does not exist and fails. Loopback
 * (the dev server, Browser preview's localhost frames) is bypassed implicitly by Chromium. Nothing
 * the window shows may load remote content anyway (CSP), so this blocks no feature.
 */
export const NO_NETWORK_PROXY = { mode: 'fixed_servers', proxyRules: 'http://127.0.0.1:9', proxyBypassRules: '' } as const;

export async function hardenApp(opts: { isAppUrl: (url: string) => boolean; dev: boolean }): Promise<void> {
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
  ses.setPermissionRequestHandler((_wc, permission, callback, details) =>
    callback(permissionAllowed(permission, details, opts.isAppUrl)),
  );
  ses.setPermissionCheckHandler((_wc, permission, _origin, details) => permissionAllowed(permission, details, opts.isAppUrl));
  await ses.setProxy({ ...NO_NETWORK_PROXY });

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
