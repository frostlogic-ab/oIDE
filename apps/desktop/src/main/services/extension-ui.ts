import { createHash } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { extname, isAbsolute, relative, resolve } from 'node:path';

/**
 * The extension UI protocol: `oide-ext://<origin>/<path>` serves panel and artifact-viewer files of
 * one extension, only from inside that extension's folder, with a CSP that allows no network. The
 * renderer shows them in `<iframe sandbox="allow-scripts">` (no `allow-same-origin`, so the frame is
 * an opaque origin and can reach neither `window.oide` nor the app's DOM). Its only way out is
 * `postMessage` to the renderer, which forwards it on the validated `extensions.panelMessage` command.
 *
 * Pure module (no Electron imports): `electron-platform.ts` registers the scheme and calls
 * `resolveExtensionUrl` from `protocol.handle`.
 */
export const EXTENSION_SCHEME = 'oide-ext';

/**
 * Host part of an extension's URLs. Package names (`@scope/name`) are not valid host names, so
 * the origin is a hash of the name: stable across launches, different for every extension.
 */
export function extensionOrigin(name: string): string {
  return 'x' + createHash('sha256').update(name).digest('hex').slice(0, 24);
}

/** Loopback frame sources a panel may embed when its manifest declares `network: ["localhost"]`. */
export const LOOPBACK_FRAME_SRC = [
  'http://localhost:*',
  'http://127.0.0.1:*',
  'https://localhost:*',
  'https://127.0.0.1:*',
];

/** `frame-src` for an extension's panels: loopback only, and only when the manifest asks for it. */
export function panelFrameSrc(network: readonly string[]): string[] {
  return network.some((h) => ['localhost', '127.0.0.1', '::1', '[::1]'].includes(h.toLowerCase()))
    ? [...LOOPBACK_FRAME_SRC]
    : [];
}

/**
 * CSP of every file the protocol serves. Scripts and styles of the extension itself (inline or from
 * its folder), no fetch/XHR/WebSocket (`connect-src 'none'`), no forms, no workers, no plugins. The
 * only frames allowed are loopback dev servers for extensions that declare them (Browser preview).
 */
export function extensionPanelCsp(frameSrc: readonly string[] = []): string {
  return [
    "default-src 'none'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "media-src 'self' data: blob:",
    "connect-src 'none'",
    `frame-src ${frameSrc.length ? frameSrc.join(' ') : "'none'"}`,
    "worker-src 'none'",
    "object-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join('; ');
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
};

export interface ExtensionUiSite {
  name: string;
  /** The extension's folder. */
  dir: string;
  /** `frame-src` for its panels (see `panelFrameSrc`). */
  frameSrc: string[];
}

/** Looks up an extension by URL origin; only extensions that are on somewhere are served. */
export type ExtensionUiLookup = (origin: string) => ExtensionUiSite | undefined;

/** Path of an entry file as a URL path (`dist/panel.html`), or null when it is outside `dir`. */
export function entryUrlPath(dir: string, entry: string): string | null {
  const rel = relative(resolve(dir), resolve(entry));
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
  return rel
    .split(/[\\/]+/)
    .map(encodeURIComponent)
    .join('/');
}

export function extensionUrl(name: string, dir: string, entry: string): string | null {
  const p = entryUrlPath(dir, entry);
  return p ? `${EXTENSION_SCHEME}://${extensionOrigin(name)}/${p}` : null;
}

/**
 * Resolve `oide-ext://<origin>/<path>` to a file inside that extension's folder, or null. Refuses
 * `..`, dot files and folders (`.git`, `.env`), `node_modules`, symlinks out of the folder and any
 * file type outside the MIME table (so source maps, keys or databases are never served).
 */
export function resolveExtensionUrl(
  lookup: ExtensionUiLookup,
  url: string,
): { file: string; mime: string; csp: string; extension: string } | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== `${EXTENSION_SCHEME}:`) return null;
  const site = lookup(u.hostname.toLowerCase());
  if (!site) return null;
  let rel: string;
  try {
    rel = decodeURIComponent(u.pathname).replace(/^\/+/, '');
  } catch {
    return null;
  }
  // SEC-17: case-insensitive file systems, and Windows ignores trailing dots and spaces.
  const fold = (s: string) => s.toLowerCase().replace(/[. ]+$/, '');
  const denied = (p: string) =>
    p
      .split(/[\\/]/)
      .filter(Boolean)
      .some((seg) => seg === '..' || seg.startsWith('.') || fold(seg) === 'node_modules' || fold(seg) === '');
  // SEC-32: `%5C` decodes to a backslash, so `/%5C%5Chost%5Cshare` would be a UNC path. Refuse
  // backslashes and anything not lexically inside the folder before the file system is touched
  // (realpath of `\\host\share` is an SMB connection that hands over the user's NTLM hash).
  if (!rel || rel.includes('\0') || rel.includes(':') || rel.includes('\\') || denied(rel)) return null;
  const lexical = relative(resolve(site.dir), resolve(site.dir, rel));
  if (!lexical || lexical.startsWith('..') || isAbsolute(lexical)) return null;
  let root: string;
  let real: string;
  try {
    root = realpathSync(site.dir);
    real = realpathSync(resolve(root, rel));
  } catch {
    return null;
  }
  const inside = relative(root, real);
  if (!inside || inside.startsWith('..') || isAbsolute(inside) || denied(inside)) return null;
  try {
    if (!statSync(real).isFile()) return null;
  } catch {
    return null;
  }
  const mime = MIME[extname(real).toLowerCase()];
  if (!mime) return null;
  return { file: real, mime, csp: extensionPanelCsp(site.frameSrc), extension: site.name };
}

/** Largest panel message (JSON length) the bridge forwards in either direction. */
export const MAX_PANEL_MESSAGE = 256 * 1024;

/** JSON copy of a panel message, or an error when it is not JSON data or too large. */
export function clonePanelMessage(
  data: unknown,
): { ok: true; value: unknown } | { ok: false; error: string } {
  let json: string | undefined;
  try {
    json = JSON.stringify(data);
  } catch {
    return { ok: false, error: 'panel messages must be JSON data' };
  }
  if (json === undefined) return { ok: true, value: null };
  if (json.length > MAX_PANEL_MESSAGE)
    return { ok: false, error: `panel messages are limited to ${MAX_PANEL_MESSAGE / 1024} KB` };
  return { ok: true, value: JSON.parse(json) as unknown };
}
