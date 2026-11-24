// Shared by the MCP server and tests: fetch a loopback URL and read its status and <title>.

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const MAX_BYTES = 512 * 1024;

/** @param {string} raw */
export function checkLocalUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error('Not a valid URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Only http and https URLs');
  if (!LOOPBACK.has(u.hostname) && !u.hostname.endsWith('.localhost')) throw new Error('Only localhost URLs can be previewed');
  if (u.username || u.password) throw new Error('URLs with credentials are not allowed');
  return u;
}

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };

/** @param {string} html */
export function titleOf(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!m || m[1] === undefined) return undefined;
  return m[1]
    .replace(/\s+/g, ' ')
    .replace(/&(amp|lt|gt|quot|#39);/g, (e) => ENTITIES[/** @type {keyof typeof ENTITIES} */ (e)] ?? e)
    .trim();
}

/**
 * @param {string} url
 * @param {{ timeoutMs?: number, fetch?: typeof fetch }} [opts]
 */
export async function previewUrl(url, opts = {}) {
  const u = checkLocalUrl(url);
  const f = opts.fetch ?? fetch;
  const res = await f(u, { redirect: 'manual', signal: AbortSignal.timeout(opts.timeoutMs ?? 5000), headers: { accept: 'text/html,*/*' } });
  /** @type {{ url: string, status: number, statusText: string, contentType?: string, title?: string, redirectedTo?: string }} */
  const out = { url: u.href, status: res.status, statusText: res.statusText };
  const ct = res.headers.get('content-type');
  if (ct) out.contentType = ct;
  const loc = res.headers.get('location');
  if (res.status >= 300 && res.status < 400 && loc) out.redirectedTo = new URL(loc, u).href;
  if (ct && /html/i.test(ct) && res.body) {
    const reader = res.body.getReader();
    let text = '';
    let size = 0;
    const dec = new TextDecoder();
    while (size < MAX_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      text += dec.decode(value, { stream: true });
      if (/<\/title>/i.test(text)) break;
    }
    await reader.cancel().catch(() => {});
    const title = titleOf(text);
    if (title) out.title = title;
  } else {
    await res.body?.cancel().catch(() => {});
  }
  return out;
}
