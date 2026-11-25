# Worktrees and review

## One worktree per agent

By default every agent gets its own [git worktree](https://git-scm.com/docs/git-worktree) on a new
branch `oide/<slug>` (the slug comes from the goal). Agents never touch your checkout, so you can
keep working in main while several agents work in parallel.

| Spawn > Work in | Worktree based on |
| --- | --- |
| New worktree from main (default) | The default branch (`origin/HEAD`, else `main`, `master`, ...) |
| New worktree from the current branch | Whatever your main checkout has checked out |
| Project folder directly | No worktree: the agent works in your checkout. Only one agent at a time, and never in Bypass mode. |

Worktrees live in oIDE's app data folder (`<app-data>/worktrees/<project>`) or, if you prefer, next
to the repo (`<repo>.worktrees`), set in **Settings > Agents**. git runs with prompts turned off, so
it never waits for a password; your own credential helper and SSH agent are used as usual.

If a trusted project has a `setup` command in `.oide/config.json` (for example `pnpm install`), it
runs in each new worktree as a "Setup" step before the agent starts.

## What the diff shows

An agent's diff compares the point where its branch left the base with its working tree: committed
and uncommitted changes, plus new untracked files. That is what the tile's `+n -n`, Focus > Changes
and Review show.

## Overlaps

When two live worktrees change the same file, Source control shows a heads-up with both agents and
the files, and predicts whether their branches merge cleanly (`git merge-tree --write-tree`; only
commits count). **Ask an agent to reconcile** spawns an agent that combines the two branches.

## Staying up to date

Other agents keep merging into the base branch while an agent works. To keep conflicts small, oIDE
tells every worktree agent to bring its base branch in twice:

- **When it starts** a new task: `git merge <base>` (after `git fetch origin` when the base is
  `origin/...`), resolving any conflicts before it begins.
- **Right before it submits for review**: commit, merge the base again, resolve conflicts, re-run
  its checks, and report a check named **Up to date with &lt;base&gt;**, so the branch is ready to merge.

The agent only merges into its own branch; it never rebases, force-pushes or touches the base
branch or the main checkout. Agents that work in the project folder, or whose base is a bare
commit, skip this.

## The review loop

1. The agent finishes and calls oIDE's `submit_for_review` tool with a summary and the checks it ran
   (tests, lint, ...). Its tile turns blue: **Ready for review**.
2. In [Review](/guide/screens/review), read the diff and comment on lines.
3. **Send feedback to agent** sends all comments as one message. The agent revises and submits again.
4. When you are happy: **Open pull request** (through `gh`) or **Merge worktree into main locally**
   (`git merge --no-ff`; on conflicts the merge is aborted and main stays untouched). Because the
   diff includes uncommitted work, oIDE first commits any uncommitted changes in the worktree on
   the agent's behalf (with the `Oide-Agent:` trailer), so what you reviewed is what gets merged.

## Cleanup

After a merge, the worktree is removed according to **Settings > Agents > Clean up** (after 7 days,
right away, or never). Removing an agent can delete its worktree too. On Windows, removal retries
while files are locked. Worktrees no agent owns any more are reported at startup as orphaned; remove
them from Source control.

## Commits by agents

Commits made from inside oIDE carry an `Oide-Agent: <name>` trailer, so Source control and Files can
say which agent made them.

Internals: [git-worktrees](https://github.com/oide-dev/oide/blob/main/docs/wiki/pages/git-worktrees.md).
