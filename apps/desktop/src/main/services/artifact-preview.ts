import { HTML_DESIGN_ENTRY, type ArtifactMeta } from '@oide/protocol';
import { isReactEntry, safeEntry, type ArtifactStore } from '@oide/store';
import { readFile } from 'node:fs/promises';
import { ARTIFACT_SCHEME, resolveArtifactUrl } from './core.js';

/**
 * React designs (ADR 0013). A claude.ai design is usually a React component (`App.jsx`), which a
 * browser cannot run as is. The preview iframe loads `oide-artifact://<id>/index.html`; for a React
 * design main answers with a generated page that holds the source as JSON and loads the bundled
 * offline runtime (apps/desktop/src/artifact-runtime) from `/__oide/react-runtime.js`. The runtime
 * compiles the JSX in the sandboxed frame and renders it. The artifact CSP stays as it is: no network.
 */

/** The paths under `__oide/`; anything else there is refused. */
export const REACT_RUNTIME_PATH = '__oide/react-runtime.js';
/** The point-and-comment picker, loaded by every HTML page main serves (see PICKER_SOURCE). */
export const PICKER_PATH = '__oide/picker.js';
const PICKER_TAG = `<script src="/${PICKER_PATH}"></script>`;

/**
 * Point and comment (Artifacts › open view › Comment). Inert until the Artifacts screen (the frame's
 * parent, and only it) posts `{ type: 'oide-pick-mode', on: true }`: then it outlines the element under
 * the pointer, swallows the click and posts `oide-picked` (a CSS selector, tag, the start of its text,
 * the page, its box) to the parent; Esc posts `oide-pick-cancel`. `{ type: 'oide-pins', pins }` draws
 * numbered markers on the elements already commented. It reads only the page's own DOM, makes no
 * requests (the artifact CSP blocks them anyway) and posts only to the parent, which treats every
 * message as untrusted (PreviewPickerMessage in @oide/protocol).
 */
export const PICKER_SOURCE = String.raw`(function () {
  'use strict';
  if (window.__oidePicker) return;
  window.__oidePicker = true;
  var host = window.parent;
  if (!host || host === window) return;
  var on = false;
  var hover = null;
  var pins = [];
  var marks = [];
  function post(m) { try { host.postMessage(m, '*'); } catch (e) { /* parent gone */ } }
  function page() { try { return decodeURIComponent(location.pathname.replace(/^\/+/, '')).slice(0, 500); } catch (e) { return ''; } }
  function esc(v) { return window.CSS && CSS.escape ? CSS.escape(v) : String(v).replace(/[^a-zA-Z0-9_-]/g, '\\$&'); }
  function ours(el) { return !!(el && el.closest && el.closest('[data-oide-picker]')); }
  function selectorOf(el) {
    var parts = [];
    while (el && el.nodeType === 1 && el !== document.documentElement && parts.length < 6) {
      if (el.id) {
        var byId = '#' + esc(el.id);
        try { if (document.querySelectorAll(byId).length === 1) { parts.unshift(byId); break; } } catch (e) { /* odd id */ }
      }
      var tag = el.tagName.toLowerCase();
      var part = tag;
      var cls = String(el.getAttribute('class') || '').trim().split(/\s+/).filter(function (c) { return c && c.length < 40; }).slice(0, 2);
      if (cls.length) part += '.' + cls.map(esc).join('.');
      var p = el.parentElement;
      if (p) {
        var same = 0;
        var at = 0;
        for (var i = 0; i < p.children.length; i++) {
          if (p.children[i].tagName === el.tagName) { same++; if (p.children[i] === el) at = same; }
        }
        if (same > 1) part += ':nth-of-type(' + at + ')';
      }
      parts.unshift(part);
      if (tag === 'body') break;
      el = p;
    }
    return parts.join(' > ').slice(0, 500);
  }
  function textOf(el) { return String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 300); }
  function layer(css) {
    var d = document.createElement('div');
    d.setAttribute('data-oide-picker', '');
    d.setAttribute('aria-hidden', 'true');
    d.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;box-sizing:border-box;' + css;
    (document.body || document.documentElement).appendChild(d);
    return d;
  }
  function place(d, el, pad) {
    var r = el.getBoundingClientRect();
    d.style.left = (r.left - pad) + 'px';
    d.style.top = (r.top - pad) + 'px';
    d.style.width = (r.width + pad * 2) + 'px';
    d.style.height = (r.height + pad * 2) + 'px';
    d.style.display = 'block';
  }
  function target(e) { var el = e.target; return el && el.nodeType === 1 && !ours(el) && el !== document.documentElement ? el : null; }
  function onMove(e) {
    if (!on) return;
    var el = target(e);
    if (!el) return;
    if (!hover) hover = layer('border:2px solid #7AA2F7;border-radius:4px;background:rgba(122,162,247,0.12);');
    place(hover, el, 2);
  }
  function swallow(e) {
    if (!on || !target(e)) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.stopImmediatePropagation) e.stopImmediatePropagation();
  }
  function onClick(e) {
    if (!on) return;
    var el = target(e);
    if (!el) return;
    swallow(e);
    var r = el.getBoundingClientRect();
    post({ type: 'oide-picked', selector: selectorOf(el), tag: el.tagName.toLowerCase().slice(0, 40), text: textOf(el), page: page(), rect: { x: r.left, y: r.top, w: r.width, h: r.height }, viewport: { w: window.innerWidth || 1, h: window.innerHeight || 1 } });
  }
  function onKey(e) {
    if (on && e.key === 'Escape') { e.preventDefault(); post({ type: 'oide-pick-cancel' }); }
  }
  function setOn(v) {
    on = v === true;
    document.documentElement.style.cursor = on ? 'crosshair' : '';
    if (!on && hover) hover.style.display = 'none';
  }
  function drawPins() {
    marks.forEach(function (m) { if (m.box.parentNode) m.box.parentNode.removeChild(m.box); if (m.badge.parentNode) m.badge.parentNode.removeChild(m.badge); });
    marks = [];
    pins.forEach(function (p) {
      var el = null;
      try { el = document.querySelector(p.selector); } catch (e) { el = null; }
      if (!el) return;
      var box = layer('border:2px dashed #F2C078;border-radius:4px;');
      var badge = layer('min-width:18px;height:18px;padding:0 5px;border-radius:9px;background:#F2C078;color:#0E1013;font:600 11px/18px Inter,system-ui,sans-serif;text-align:center;');
      badge.textContent = String(p.n);
      marks.push({ el: el, box: box, badge: badge });
    });
    reposition();
  }
  function reposition() {
    marks.forEach(function (m) {
      place(m.box, m.el, 2);
      var r = m.el.getBoundingClientRect();
      m.badge.style.left = Math.max(0, r.left - 9) + 'px';
      m.badge.style.top = Math.max(0, r.top - 9) + 'px';
      m.badge.style.display = 'block';
    });
  }
  window.addEventListener('message', function (e) {
    if (e.source !== host) return;
    var d = e.data;
    if (!d || typeof d !== 'object') return;
    if (d.type === 'oide-pick-mode') setOn(d.on);
    else if (d.type === 'oide-pins' && Array.isArray(d.pins)) {
      pins = d.pins.filter(function (p) { return p && typeof p.selector === 'string' && p.selector.length <= 500 && typeof p.n === 'number'; }).slice(0, 100);
      drawPins();
    }
  });
  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('pointerdown', swallow, true);
  document.addEventListener('mousedown', swallow, true);
  document.addEventListener('mouseup', swallow, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('scroll', reposition, true);
  window.addEventListener('resize', reposition);
  // React designs render after load: draw the pins again once the page has settled.
  window.addEventListener('load', function () { setTimeout(drawPins, 300); });
  post({ type: 'oide-picker-ready', page: page() });
})();
`;

/** An HTML page with the picker added (before the last `</body>`, else at the end). */
export function withPicker(html: string): string {
  const at = html.toLowerCase().lastIndexOf('</body>');
  return at === -1 ? `${html}\n${PICKER_TAG}\n` : `${html.slice(0, at)}${PICKER_TAG}\n${html.slice(at)}`;
}

/**
 * The page that previews a React design. The source goes in a JSON script block with `<`, U+2028
 * and U+2029 escaped, so no source text can close the block or start markup (`</script>` stays a
 * string); the runtime reads it with JSON.parse. Nothing in the page comes from anywhere else.
 */
export function reactPreviewPage(source: string): string {
  const json = JSON.stringify(source).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  return (
    '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>Preview</title>\n</head>\n<body>\n' +
    '<div id="root"></div>\n' +
    `<script type="application/json" id="oide-src">${json}</script>\n` +
    `<script src="/${REACT_RUNTIME_PATH}"></script>\n` +
    `${PICKER_TAG}\n` +
    '</body>\n</html>\n'
  );
}

export type ArtifactResponse = { file: string; mime: string } | { body: string; mime: string };

const JS_MIME = 'text/javascript; charset=utf-8';
const HTML_MIME = 'text/html; charset=utf-8';

/**
 * What `oide-artifact://<id>/<path>` answers: the runtime (only `__oide/react-runtime.js`, only for
 * an artifact that exists), the generated page for a React design's `index.html`, or a file inside
 * the artifact's folder (resolveArtifactUrl and its checks). Anything else is null (404).
 */
export async function resolveArtifactRequest(artifacts: ArtifactStore, url: string, runtimeFile: string | undefined): Promise<ArtifactResponse | null> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== `${ARTIFACT_SCHEME}:`) return null;
  let id: string;
  let rel: string;
  try {
    id = decodeURIComponent(u.hostname || u.host);
    rel = decodeURIComponent(u.pathname).replace(/^\/+/, '');
  } catch {
    return null;
  }
  let meta;
  try {
    meta = artifacts.metaOf(id);
  } catch {
    return null;
  }
  // `__oide` is oIDE's own namespace (case-folded, as Windows and macOS ignore case): one exact file.
  const first = rel.split(/[\\/]/)[0]?.toLowerCase().replace(/[. ]+$/, '');
  if (first === '__oide') {
    if (rel === PICKER_PATH) return { body: PICKER_SOURCE, mime: JS_MIME };
    return rel === REACT_RUNTIME_PATH && runtimeFile ? { file: runtimeFile, mime: JS_MIME } : null;
  }
  if (meta.version === 0) return null; // nothing retrieved yet
  if (isReactDesign(meta) && rel === HTML_DESIGN_ENTRY) {
    try {
      const { content } = await artifacts.read(id);
      return { body: reactPreviewPage(content), mime: HTML_MIME };
    } catch {
      return null;
    }
  }
  const hit = resolveArtifactUrl(artifacts, url);
  // Every HTML page gets the point-and-comment picker (inert until the Artifacts screen turns it on).
  if (hit && /^text\/html\b/i.test(hit.mime)) {
    try {
      return { body: withPicker(await readFile(hit.file, 'utf8')), mime: hit.mime };
    } catch {
      return null;
    }
  }
  return hit;
}

/** A design that opens on React source (`App.jsx`, or any .jsx / .tsx entry): previewed through the generated page. */
export function isReactDesign(meta: Pick<ArtifactMeta, 'kind' | 'entry'>): boolean {
  return meta.kind === 'design' && isReactEntry(safeEntry(meta));
}

/**
 * `oide-artifact://<id>/<entry>` with each path segment encoded, so relative links in the entry
 * (`site.css`, `shots/home.png`, other pages) resolve against its folder. A React design opens on
 * the generated page at `index.html`.
 */
export function previewUrlOf(meta: Pick<ArtifactMeta, 'id' | 'kind' | 'entry'>): string {
  const path = isReactDesign(meta) ? HTML_DESIGN_ENTRY : safeEntry(meta);
  return `${ARTIFACT_SCHEME}://${encodeURIComponent(meta.id)}/${path.split('/').map(encodeURIComponent).join('/')}`;
}
