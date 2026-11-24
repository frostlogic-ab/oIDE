# ADR 0006: "Open pull request" calls the user's gh CLI from main, not the Git extension

- Status: accepted
- Date: 2026-11-24
- Departs from: build brief, Projects and git worktrees › Finish ("through the Git extension, which uses the user's own `gh` login or a GitHub token they add")

## Context
Review's "Open pull request" needs to push the agent's branch and run `gh pr create`. The built-in Git
extension runs in the extension host utility process, which has no access to worktree paths outside
the roots main hands it and no command contract for "push this branch and open a PR" yet.

## Decision
`packages/git/src/gh.ts` (`GhCli`) runs the user's own `gh` from main (`services/git.ts` `openPr`,
`prView`). It never reads or stores a GitHub token; `gh` uses its own login. `git.prAvailable` is
false, with a reason, when `gh` is missing or signed out, or when the project has no git remote.

## Consequences
- PRs work without the extension host; the user's `gh auth` is the only credential.
- A GitHub token entered in the Git extension is not used for PRs yet. Moving `openPr` behind an
  extension command later only changes the caller, not the Review UI.
