# ADR 0002: Workspace packages export TypeScript source

- Status: accepted
- Date: 2026-11-24

## Context
The brief's monorepo has nine internal packages. A build step per package slows the dev loop and
adds watch-mode coordination.

## Decision
Internal packages (`@oide/protocol`, `agent-core`, `git`, `store`, `mcp-server`, `extension-host`,
`ui`) point `main`/`exports` at `src/index.ts`. electron-vite bundles them into the main, preload
and renderer outputs; Vitest runs them directly. Relative imports use the `.js` suffix
(`moduleResolution: Bundler`). Only `@oide/extension-api`, which is published to npm, gets its own
`tsc` build when released.

## Consequences
One typecheck per package (`tsc --noEmit`), no `dist/` for internal packages, faster iteration.
