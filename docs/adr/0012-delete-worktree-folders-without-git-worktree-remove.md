# ADR 0012: Worktree folders are deleted by oIDE, not by `git worktree remove`

- Status: accepted
- Date: 2026-11-25
- Departs from: build brief, "Projects and git worktrees" (cleanup removes the worktree with
  `git worktree remove`), and the fix plan for the worktree-deletion incident, which asked to keep
  `git worktree remove` with `-c core.longpaths=true`.

## Context
A discarded agent's worktree could not be deleted on Windows (docs/wiki/pages/git-worktrees.md,
"Why a worktree can't be deleted on Windows"). While reproducing it with git 2.51.0.windows.1, a
directory junction inside the worktree pointing to a folder **outside** it had that folder's files
deleted by `git worktree remove` (with and without `--force`): git follows junctions. pnpm creates
thousands of junctions; most point inside the worktree, but `link:`/`file:` dependencies and
global stores point elsewhere. git also fails on paths over 260 characters without
`core.longpaths` and with "Directory not empty" on junctions.

`fs.rm` removes a junction without following it and handles long paths; but its own `maxRetries`
retries per directory level, so a held folder deep in the tree made it hang for minutes.

## Decision
`WorktreeManager.remove`:
1. Without `force`, makes the checks `git worktree remove` makes before deleting anything: refuses
   a locked worktree and one with modified or untracked files (`git status --porcelain
   --ignore-submodules=none`).
2. With `force`, unlocks a locked worktree.
3. Deletes the folder with `removeTree`: `fs.rm(recursive, force, maxRetries: 0)`, retried as a
   whole a few times with linear backoff on `EBUSY`/`EPERM`/`EACCES`/`ENOTEMPTY`.
4. Runs `git worktree prune`, which drops git's record of the missing worktree.

## Consequences
- Files outside a worktree are never deleted through a junction or symlink in it.
- Long paths and junctions cost nothing extra; a held folder fails within seconds and goes to the
  cleanup queue with the programs holding it named.
- git's admin folder (`.git/worktrees/<name>`) is removed by `prune` rather than by `remove`; a
  locked worktree removed without `force` is refused exactly as git would.
