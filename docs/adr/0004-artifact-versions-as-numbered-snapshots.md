# ADR 0004: Artifact versions are numbered snapshots in both locations

- Status: accepted
- Date: 2026-11-24
- Departs from: build brief, Artifacts integration ("Versions are git commits for repo artifacts and numbered snapshots for personal ones")

## Context
Repo artifacts live in `<repo>/.oide/artifacts/<slug>/`. Making each save a git commit would mean
oIDE commits into the user's main checkout on its own: it would interleave with the user's staged
work, trip pre-commit hooks and signing prompts, fail mid-merge or mid-rebase, and fight agents that
commit from worktrees. It would also give the History list two code paths (git log vs. snapshots).

## Decision
Every save, for both locations, writes the next numbered snapshot:
`<artifact>/.versions/<n>/<entry>` plus `.versions/versions.json` (`ArtifactVersion[]`: version, ts,
author, note) and bumps `version` in `artifact.json`. oIDE never commits artifacts. For repo
artifacts the user commits the folder (including `.versions/`) like any other change, so the team
gets the content and the history through git when they choose to.

## Consequences
- One History implementation (`ArtifactStore.versions()` / `readVersion()`), works for personal
  artifacts, uncommitted repo artifacts and repos with hooks alike.
- Repo artifacts grow by one snapshot per save; `.versions/` can be git-ignored by teams that only
  want the latest content (History then shows only local saves).
- If a team later wants git-backed history, `git log -- .oide/artifacts/<slug>` can be added as a
  second source without changing the store format.
