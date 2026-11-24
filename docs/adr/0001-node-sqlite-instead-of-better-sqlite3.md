# ADR 0001: node:sqlite instead of better-sqlite3 + Drizzle

- Status: accepted
- Date: 2026-11-24
- Departs from: build brief, Stack table ("SQLite through better-sqlite3, Drizzle for schema and migrations")

## Context
better-sqlite3 is a V8-ABI native module. It must be built once for Node (Vitest) and once for
Electron (the app), and both builds can't live in one hoisted `node_modules` without juggling
`electron-rebuild` on every test run and in CI on three OSes. Electron 45 ships Node 24.22, which
includes the synchronous built-in `node:sqlite` (`DatabaseSync`). The host Node used for tests (24.x)
has the same module.

## Decision
Use `node:sqlite` (`DatabaseSync`) in WAL mode in the main process. Schema changes are numbered SQL
migrations in `packages/store/src/migrations.ts`, applied at startup inside a transaction, with a
file backup of the database taken before any pending migration runs. Repositories are small typed
modules that validate rows with the Zod schemas from `@oide/protocol`.

## Consequences
- No native rebuild for storage; tests and the app use the same code path.
- No Drizzle query builder; SQL is hand-written and kept in the repository modules.
- `node:sqlite` still prints an ExperimentalWarning in some Node versions; main suppresses that one warning.
