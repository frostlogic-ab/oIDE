import { HTML_DESIGN_ENTRY, REACT_DESIGN_ENTRY } from '@oide/protocol';
import type { ArtifactStore } from '@oide/store';
import { ARTIFACT_SCHEME, resolveArtifactUrl } from './core.js';

/**
 * React designs (ADR 0013). A claude.ai design is usually a React component (`App.jsx`), which a
 * browser cannot run as is. The preview iframe loads `oide-artifact://<id>/index.html`; for a React
 * design main answers with a generated page that holds the source as JSON and loads the bundled
 * offline runtime (apps/desktop/src/artifact-runtime) from `/__oide/react-runtime.js`. The runtime
 * compiles the JSX in the sandboxed frame and renders it. The artifact CSP stays as it is: no network.
 */

/** The only path under `__oide/`; anything else there is refused. */
export const REACT_RUNTIME_PATH = '__oide/react-runtime.js';

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
  if (first === '__oide') return rel === REACT_RUNTIME_PATH && runtimeFile ? { file: runtimeFile, mime: JS_MIME } : null;
  if (meta.kind === 'design' && meta.entry === REACT_DESIGN_ENTRY && rel === HTML_DESIGN_ENTRY) {
    try {
      const { content } = await artifacts.read(id);
      return { body: reactPreviewPage(content), mime: HTML_MIME };
    } catch {
      return null;
    }
  }
  return resolveArtifactUrl(artifacts, url);
}
