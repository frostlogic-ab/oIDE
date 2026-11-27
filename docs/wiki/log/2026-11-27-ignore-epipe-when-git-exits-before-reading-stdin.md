## [2026-11-27] build | Ignore EPIPE when git exits before reading stdin

Unit tests (ubuntu-latest) failed on the 0.8.0 release PR (#69) with an uncaught `write EPIPE` from
`packages/git/src/git.ts`. `ignoredPaths` (#70) pipes paths into `git check-ignore --stdin`; outside a
git checkout git exits with 128 before reading stdin, so the write raced git's exit and, with no
error listener on `child.stdin`, crashed the test run on Linux. The runner now attaches an error
listener before writing `input`; the exit code still reports the outcome. A regression test sends a
payload larger than the pipe buffer to git outside a checkout, which reproduces the error every time
without the fix. See [git-worktrees](../pages/git-worktrees.md).
