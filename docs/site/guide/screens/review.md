# Review

An agent's changes, file by file, with your feedback. Open it from a tile (**Review diff**), from
Source control, or from Focus > Changes.

## Layout

- **Changed files** on the left with `+/-` totals. A check marks files you marked as viewed. Toggle
  **Unified** or **Split** view.
- **The diff** in the middle, with **Viewed** and **Open in editor** (opens the agent's copy in Files).
- **Summary** on the right: the agent's own summary and the checks it ran (from its
  `submit_for_review` call), your feedback list, and the actions.

## Feedback

Click a line (or its line number) to comment: "Your comment on line N · goes to the agent". Comments
collect until you press **Send feedback to agent**, which sends them together as one message; the
agent revises and submits again. Unsent comments can be deleted.

## Finish

- **Open pull request** creates a PR with `gh` (title and body from the summary and checks) and opens
  it in your browser. With an existing PR the button reads "View pull request #n". It is disabled,
  with the reason, when `gh` is not installed or not signed in.
- **Merge worktree into main locally** asks for confirmation, then runs `git merge --no-ff`. If there
  are conflicts, main is left untouched and the dialog lists them; **Hand them to a new agent** opens
  Spawn with the files as context.

## Keys

J / K next or previous file, `]` / `[` next or previous hunk. Rebindable.

Details: [screen-review](https://github.com/oide-dev/oide/blob/main/docs/wiki/pages/screen-review.md)
and [Worktrees and review](/guide/worktrees-and-review).
