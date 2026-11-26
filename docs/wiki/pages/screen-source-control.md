# Screen: Source control

Design: [../raw/design/SourceControl.dc.html](../raw/design/SourceControl.dc.html). Spec: "Project scope and
Source control" in the [build brief](../raw/build-brief.md). Code: `apps/desktop/src/renderer/src/screens/SourceControl/`.
Data meaning: [git-worktrees](git-worktrees.md). Frame and stores: [desktop-shell](desktop-shell.md).

## Layout

- Header: title + shared scope switcher (registry `scopeSwitcher: true`). Picking a project here also
  scopes the Wall and Files (`useScope`).
- Main column: "All projects" (or the project name) with "N projects · M agent worktrees", the
  one-line explainer, then one card per project in scope.
- Right column (`SidePanel.tsx`, `aria-label="Needs you"`): Ready to review, Heads-up, the shared-scope note.

## Project card (`ProjectCard.tsx`)

| Part | Source |
| --- | --- |
| Name toggle (expand/collapse), `~/code/x` path, branch chip | `Project`, `git.sync` → `SyncState.branch` |
| "2 behind origin" + Pull / "1 to push" + Push / "Up to date" + Fetch | `syncView()` in `model.ts`; actions `git.pull` / `git.push` / `git.fetch` (`actions.ts`) |
| Your changes on main + Commit… | `SyncState.dirtyFiles`; `CommitDialog.tsx` (message, per-file checkboxes, Ctrl/Cmd+Enter) → `git.commit` (`files` omitted when all are picked) |
| Your changes on main + Revert… | `RevertDialog.tsx` (per-file checkboxes, "can't be undone" warning, Cancel focused, danger button) → `git.discard` (`files` omitted when all are picked): `@oide/git` `discard()` runs `git restore --source=HEAD --staged --worktree` on tracked paths (both sides of a staged rename) and `git clean -f` on untracked ones, literal pathspecs; only paths `git status` reports as changed are touched |
| Agent worktrees · N | `git.worktrees`; row = status dot, agent title (→ Focus), `branch · from main · 2 behind`, status, `7 files · +214 −37`, PR state, Review (blue when ready-for-review), ··· menu |
| ··· menu | Open folder (`shell.revealPath`), Reconcile with … (enabled only when the row is in an overlap → `git.reconcile`), Remove worktree… (confirm → `agents.remove { deleteWorktree: true }`, or `git.pruneOrphans` for orphaned rows) |
| Recent commits on main (collapsed by default) | `git.log { ref: 'HEAD', limit: 20 }`; who = `commitAuthor()`: `Oide-Agent` trailer → "<name> agent", a `Merge a/b` subject → "You, from an agent", else "You" |

Status column collapses needs-permission / has-question / error / rate-limited into "Needs you"
(as drawn). PR column: `prView()` ("No PR", "Ready to open" when ready-for-review, "Draft PR #18",
"PR #n open", "Merged #n"); the column is hidden when `git.prAvailable` says gh is unavailable.

## Right column

- **Ready to review**: agents in scope with status `ready-for-review` → Review. Subtitle
  "project · 8 files · checks passed" (failed checks counted; warnings do not fail).
- **Heads-up**: every `OverlapWarning` in scope: "Two worktrees change the same file", both agent
  titles and the files; the last sentence follows `conflicts` (true: needs a fix, false: merges
  cleanly, unknown: may need a fix). "Ask an agent to reconcile" → `git.reconcile`, the spawned
  summaries go into the agents store.
- **Unpushed commits**: projects with `ahead > 0` → "docs-site has 1 unpushed commit" + Push.

## Data (`gitStore.ts`)

`useGit` keeps `ProjectGit` per project (`sync`, `worktrees`, `log`, `overlaps`, `prAvailable`,
`error`, `loadedAt`), loaded with five parallel calls (not-implemented answers become empty state;
other errors show in the card). `useGitData(projectIds)` loads them and reloads a project on
`git.changed { projectId }`. Review and Files reuse the same store (`findWorktree`, `useProjectGit`).

## Tests

`SourceControl.test.tsx`: cards per project from the mock bridge, sync label/action, heads-up and
unpushed notices, scope switching filters cards and calls `scope.set`; the loading state; label helpers.

## Deviations from the canvas

- The overlap card names the agents by their full titles (the canvas uses short names).
- A Spinner shows while a project first loads, with "Loading agent worktrees…" and "Loading commits…" (and
  "loading agent worktrees…" in the header count) instead of 0 / "No commits yet"; errors appear as a red line inside the card.
- Worktree rows are a fixed grid so they never wrap: below 1280px the status / diff / PR columns
  narrow (100 / 118 / 84px) and the name and branch meta truncate (full text in `title`).
- "Open pull request" is hidden or disabled with a reason when the project has no git remote (`git.prAvailable`).
