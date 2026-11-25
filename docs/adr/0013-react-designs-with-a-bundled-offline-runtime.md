# ADR 0013: React designs run in a bundled offline runtime

- Status: accepted
- Date: 2026-11-25
- Departs from: build brief, "Artifacts integration" (a design is an HTML page, previewed in a
  sandboxed iframe), and the earlier import rule that refused React source as a design.

## Context
Most designs people make on claude.ai are React components (JSX or TSX, `export default`, Tailwind
utility classes, lucide-react icons, sometimes recharts), not HTML pages. oIDE previews a design at
`oide-artifact://<id>/index.html` in `<iframe sandbox="allow-scripts">` under a CSP with no network
(`connect-src 'none'`, `script-src 'unsafe-inline' 'self'`, no `'unsafe-eval'`). A React component
can't run as is in that frame: a browser doesn't understand JSX, and loading React or a compiler
from a CDN is blocked. So pasting a claude.ai design was refused ("isn't an HTML page"), or it was
stored as a doc that shows source text.

oIDE can't download claude.ai artifacts at all (no public content API; it never uses the user's
claude.ai sign-in), so the user brings the code by pasting it or by dropping the downloaded file. Once
they have done that, the design should show.

## Decision
- A design's entry file is `index.html` (HTML or SVG) or `App.jsx` (React). The store picks it from
  the content on create and save (`designEntryFor`), keeps it to that fixed set (never a name from
  `artifact.json`), and reads a version from either entry.
- `apps/desktop/src/artifact-runtime/` is one bundled IIFE (`vite.runtime.config.ts`, built by the
  desktop `build` / `dev` / `e2e` / `dist` scripts into `out/artifact-runtime/react-runtime.js`,
  shipped as an electron-builder extra resource). It holds React and ReactDOM, Sucrase (JSX,
  TypeScript and imports → CommonJS), lucide-react, recharts and Tailwind's browser build (about
  2.2 MB, loaded only inside the preview frame).
- For a React design, main answers `index.html` with a generated page: the source in a
  `<script type="application/json">` block (`<`, U+2028 and U+2029 escaped) and
  `<script src="/__oide/react-runtime.js">`. `__oide/react-runtime.js` is the only path served from
  oIDE's namespace (case-folded check; every other `__oide/…` path is refused, even if the artifact
  folder has one). `services/artifact-preview.ts`.
- The runtime compiles the source, runs it through an inline `<script>` (allowed by the existing
  `'unsafe-inline'`; no eval), resolves imports only from the bundled libraries, and renders the
  default export. An import it doesn't bundle (shadcn's `@/components/ui/*`, a URL) and compile or
  runtime errors show a readable message in the frame.
- The artifact CSP, the sandbox and the opaque origin are unchanged.

## Consequences
- Pasted or downloaded claude.ai React designs show in oIDE without a network.
- Designs that use other libraries show "This artifact imports X, which oIDE's offline preview doesn't
  include" until they are rewritten with the bundled set.
- Past versions and unsaved edits of a React design are not previewed live (they would need scripts
  in a `srcdoc` frame, which the app CSP doesn't allow); the viewer says "Save to preview" and offers
  Compare.
- The app grows by the runtime's size; the libraries are permissive (MIT, ISC, Apache-2.0) and listed in
  `THIRD_PARTY_NOTICES.md`.
