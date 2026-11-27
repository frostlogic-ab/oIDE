## [2026-11-27] decision | Wiki log: one file per entry
Parallel pull requests all appended to the end of `docs/wiki/log.md`, so every pair of them conflicted
on the same lines. The log is now a folder: `docs/wiki/log/` holds one file per entry, named
`YYYY-MM-DD-<slug>.md` with the usual `## [YYYY-MM-DD] <op> | <title>` heading, and `log.md` is a
frozen archive of everything up to today. Branches only add new files, so they cannot conflict.
`pnpm wiki:log` prints the archive plus every entry in order; `pnpm wiki:log new <op> "<title>"`
creates an entry file. `pnpm wiki:lint` now checks entry names, headings, ops and links, and fails
when an entry follows the archive's last one in `log.md`. Only the top of `log.md` changed, so a
branch opened before this that appended to it still merges main cleanly; lint then asks it to move
the entry into `log/`. `merge=union` in `.gitattributes` was tried and dropped: a branch only gets
the attribute after it has merged main, so it would not prevent that merge's conflict. Updated CLAUDE.md, CONTRIBUTING.md, the PR template, the docs site and
the [wiki index](../index.md).
