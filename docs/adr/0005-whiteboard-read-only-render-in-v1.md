# ADR 0005: Whiteboards are a read-only render in v1, not an embedded Excalidraw editor

- Status: superseded (2026-11-25) by the embedded Excalidraw 0.18 editor (commit 26389c6:
  lazy chunk, fonts bundled and served from 'self', no CSP change). The read-only renderer
  (`screens/Artifacts/Whiteboard.tsx`) remains for previews. The text below is the original decision.
- Date: 2026-11-24
- Departs from: build brief, Artifacts integration ("Whiteboard | Excalidraw JSON | Embedded whiteboard component")

## Context
The brief lists an embedded whiteboard editor (Excalidraw, open question 16). Excalidraw's editor is
a large React bundle that loads fonts and workers at run time and evaluates code paths that need a
looser CSP than the renderer's `script-src 'self'` (no `unsafe-eval`). Shipping it in v1 would grow
the renderer by several MB and need its own sandboxed frame and CSP review.

## Decision
v1 stores whiteboards as Excalidraw JSON (the brief's format) and shows them with a small read-only
SVG renderer (`screens/Artifacts/Whiteboard.tsx`: rectangle, ellipse, diamond, line, arrow, freedraw,
text). People edit the JSON through "Edit source"; agents edit it through the artifact MCP tools.

## Consequences
- The file format is the one the editor uses, so embedding Excalidraw later needs no migration.
- No drawing by hand in v1; the screen-artifacts page lists it as a gap.
- When the editor is embedded, it goes in a sandboxed `oide-artifact:` frame like other previews.
