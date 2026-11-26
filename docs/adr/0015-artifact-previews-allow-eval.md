# ADR 0015: Artifact previews allow `'unsafe-eval'`

- Status: accepted
- Date: 2026-11-26
- Departs from: ADR 0013 ("the artifact CSP ... no `'unsafe-eval'`", "The artifact CSP ... unchanged").

## Context
A claude.ai Design export (ADR 0014) ships its own runtime next to its pages: `Main.dc.html` loads
`_runtime/react.js`, `_runtime/react-dom.js` and `_runtime/support.js`, and the page's component lives
in `<script type="text/x-dc">`. `support.js` turns that text into code with `new Function(...)`. Under
the artifact CSP (`script-src 'unsafe-inline' 'self'`) that call throws, and the runtime paints a red
"Evaluating a string as JavaScript violates the following Content Security Policy directive" box over
the design. Its template bindings (`{{ dlShort }}`, menus, theme props) never run.

## Decision
`ARTIFACT_CSP` adds `'unsafe-eval'` to `script-src`. Nothing else changes: `default-src 'none'`,
`connect-src 'none'`, `frame-src 'none'`, `worker-src 'none'`, `form-action 'none'`, `base-uri 'none'`,
`'self'` scoped to the one artifact (SEC-18), `<iframe sandbox="allow-scripts">` with an opaque origin,
and the WebRTC policy.

## Why this is safe
The frame already runs any inline `<script>` the artifact contains, so eval gives an artifact no
capability it did not have: the same code can be written inline. What protects the user is the frame's
isolation (no network, no same-origin access to the app, no other artifact's files), and that is
unchanged. The app windows' own CSP stays `script-src 'self'` with no eval (checked in `e2e/smoke.spec.ts`).

## Consequences
- claude.ai Design exports render and are interactive in the preview.
- A test pins the artifact CSP: eval allowed, network still blocked.
