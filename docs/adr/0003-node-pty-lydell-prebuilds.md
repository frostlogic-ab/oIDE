# ADR 0003: @lydell/node-pty for terminals

- Status: accepted
- Date: 2026-11-24
- Refines: build brief, Stack table ("xterm.js + node-pty")

## Decision
Use `@lydell/node-pty`, a repackaging of node-pty that ships N-API prebuilt binaries per platform, so
the same binary loads in Node and in Electron without a rebuild. API is identical to `node-pty`.
