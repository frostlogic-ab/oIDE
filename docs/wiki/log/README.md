# oIDE wiki: log entries

The wiki log is chronological and append-only, but it is stored as **one file per entry** so that
pull requests opened in parallel only ever add new files and never conflict. Entries up to
2026-11-27 are in the frozen archive [../log.md](../log.md).

- Create an entry: `pnpm wiki:log new <op> "<title>"`. It writes `YYYY-MM-DD-<slug>.md` here with
  the heading `## [YYYY-MM-DD] <op> | <title>`; fill in the body. `op` is `ingest`, `build`,
  `decision`, `review`, `lint` or `query`.
- One heading per file, and it is the first line. Link pages as `../pages/<page>.md`.
- Never edit another branch's entry to add yours; add a new file instead.
- Read the whole log in order: `pnpm wiki:log` (archive first, then these files by name, which sorts
  them by date).
- `pnpm wiki:lint` checks the file names, headings and links, and fails if an entry is appended to
  `log.md`.
