## [2026-11-27] build | Diff refresh keeps the newest counts

Windows CI failed `test/integration/archive.test.ts`: an agent archived with 1 changed file instead of
2. Overlapping background diff refreshes could finish out of order, and a slow, older `git diff` then
overwrote the newer counts. `GitService.refreshDiff` now records the latest refresh started per agent
and drops results from older ones. See [desktop-shell](../pages/desktop-shell.md).
