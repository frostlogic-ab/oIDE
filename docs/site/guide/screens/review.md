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
- **Merge worktree into main locally** first predicts whether the merge would conflict (with
  `git merge-tree`, nothing is touched) and lists any uncommitted files in the main checkout. If it
  merges cleanly, Merge commits any uncommitted changes in the worktree on the agent's behalf, then
  runs `git merge --no-ff`. If it would conflict, the dialog names the files and its main action is
  **Ask <agent> to resolve**: oIDE sends the agent a message (marked "Sent by oIDE" in the transcript)
  to merge main into its own worktree, resolve the conflicts, commit and submit for review again. A
  stopped or archived agent is brought back first. The tile shows "Resolving merge conflicts" until it
  submits; then you click Merge again. **Merge anyway** still tries, and a merge that stops on
  conflicts leaves main untouched and offers the same action.
- The summary column, Ready-for-review tiles and Source control show how the branch stands:
  "Up to date with main" or "Behind main by 2 commits, would conflict in 1 file".

Extensions that are on for the project can add **deploy targets**: buttons in the summary column,
above Open pull request, that hand the agent's branch to the extension.

## Keys

J / K next or previous file, `]` / `[` next or previous hunk. Rebindable.

Details: [screen-review](https://github.com/oide-dev/oide/blob/main/docs/wiki/pages/screen-review.md)
and [Worktrees and review](/guide/worktrees-and-review).
