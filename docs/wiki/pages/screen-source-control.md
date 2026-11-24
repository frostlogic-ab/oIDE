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
| Agent worktrees · N | `git.worktrees`; row = status dot, agent title (→ Focus), `branch · from main · 2 behind`, status, `7 files · +214 −37`, PR state, Review (blue when ready-for-review), ··· menu |
| ··· menu | Open folder (`shell.revealPath`), Reconcile with … (enabled only when the row is in an overlap → `git.reconcile`), Remove worktree… (confirm → `agents.remove { deleteWorktree: true }`, or `git.pruneOrphans` for orphaned rows) |
| Recent commits on main | `git.log { ref: 'HEAD', limit: 20 }`; who = `commitAuthor()`: `Oide-Agent` trailer → "<name> agent", a `Merge a/b` subject → "You, from an agent", else "You" |

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
unpushed notices, scope switching filters cards and calls `scope.set`; label helpers.

## Deviations from the canvas

- The overlap card names the agents by their full titles (the canvas uses short names).
- A Spinner shows while a project first loads; errors appear as a red line inside the card.
