# Source control

Every project in scope as a card, plus a column of things that need you.

## Project card

| Part | What it shows and does |
| --- | --- |
| Name, path, branch | Click the name to collapse the card |
| Sync | "2 behind origin" with **Pull**, "1 to push" with **Push**, or "Up to date" with **Fetch**. Only fetch ever runs without a click (every 10 minutes by default, Settings > Agents). Pull is fast-forward only. |
| Your changes on main | Your own uncommitted files, with **Commit...** (pick files, write a message) |
| Agent worktrees | One row per agent: status, title (opens Focus), branch, how far behind main, changed files and `+/-`, PR state, **Review**, and a menu |
| Row menu | Open folder, **Reconcile with...** (when two worktrees overlap), **Remove worktree...** |
| Recent commits on main | Who made each: "You", "&lt;name&gt; agent" (commits carrying the `Oide-Agent:` trailer), or "You, from an agent" for merges |

## Needs you

- **Ready to review**: agents that submitted their work, with file counts and check results.
- **Heads-up**: two worktrees change the same file. oIDE predicts whether the branches will merge
  cleanly (`git merge-tree`). **Ask an agent to reconcile** spawns an agent that combines the two.
- **Unpushed commits**: projects with local commits, with **Push**.

The PR column is hidden when the GitHub CLI is missing or signed out.

Details: [screen-source-control](https://github.com/oide-dev/oide/blob/main/docs/wiki/pages/screen-source-control.md).
