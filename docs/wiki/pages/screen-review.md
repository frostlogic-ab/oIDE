# Screen: Review changes

Design: [../raw/design/Review.dc.html](../raw/design/Review.dc.html). Route `review { agentId }`, reached from
[Source control](screen-source-control.md) (Review buttons, Ready to review) and the Wall tiles. Code:
`apps/desktop/src/renderer/src/screens/Review/`. Diff semantics: [git-worktrees](git-worktrees.md).

## Layout

- Header title slot: breadcrumb `Source control / <project> / Review: <title>` (registry `customTitle`).
- Left (260px, "Changed files"): "8 files changed" with +/− totals, one button per `FileDiff`
  (current = accent dot, viewed = small check and dimmer text; names drop a leading `src/` as
  drawn, full path in the tooltip), Unified / Split toggle (`aria-pressed`).
- Middle: file path, Viewed checkbox (`review.setViewed`, initial state from `review.viewed`),
  "Open in editor" (→ Files with `{ root: worktree, path }`), then the diff.
- Right (`SummaryPanel.tsx`): status, title, `worktree <short branch> → <base>`, Agent's summary
  and Checks the agent ran (from `AgentSummary.review`, the `submit_for_review` payload), Your
  feedback list (click → jump to file/line), Send feedback to agent, Open pull request, Merge
  worktree into main locally.

## Unified diff (`diff.ts`, `UnifiedDiff.tsx`)

- `parseHunks(patch)` numbers lines from the hunk headers (same rules as `@oide/git` `parseHunks`).
- One 44px number column with the new-side number; removed lines have none (canvas). Colours:
  hunk header `#131822`/`#9AA3AE`, context `#B8BFC9`, add `#12261D`/`#A8E0C6`, del `#2A1618`/`#F4B8B8`.
  Text is "marker + space + code".
- Click a line (or its number button, "Comment on line N") → inline box "Your comment on line N ·
  goes to the agent", Cancel / Add to feedback (Ctrl/Cmd+Enter, Esc) → `review.addComment
  { agentId, path, line, body }`. Removed lines comment with their old number ("removed line N").
- Existing comments render inline under their line (sent / not sent yet, delete while unsent →
  `review.deleteComment`).
- Over 400 rows the list is virtualized (`@tanstack/react-virtual`, measured rows).

## Split (`SplitDiff.tsx`)

Monaco's diff editor, lazy-loaded from `screens/Files/monaco/setup.ts` (local package, editor
worker inlined as a blob; see [screen-files](screen-files.md)). Modified side = `files.read` of the
worktree copy, original = that content with the patch reverse-applied (`reverseApply`). If the read
fails, both sides are rebuilt from the hunks with blank padding so line numbers still match
(`sidesFromHunks`), and a note says only changed parts are shown. Unchanged regions are folded.

## Decisions

- Send feedback → `review.sendFeedback { agentId }` (main bundles unsent comments into one
  `review-feedback` message); label becomes "Feedback sent · agent is revising". Disabled while there
  are no unsent comments.
- Open pull request → `git.openPr { agentId, title, body }` (body = summary + checks as a task list),
  then opens the URL. With an existing PR it reads "View pull request #n". When `git.prAvailable`
  answers `available: false` it is disabled with the reason (default: install gh and `gh auth login`).
- Merge locally: confirm dialog → `git.mergeLocal`. Conflicts show in the dialog (main is left
  untouched); "Hand them to a new agent" opens Spawn with a goal and the files as context chips.

## Keys

`review.nextFile` J, `review.prevFile` K, `review.nextHunk` `]`, `review.prevHunk` `[` (defined with
`keymap.define`, rebindable). Past the last hunk, `]` moves to the next file.

## Tests

`Review.test.tsx`: hunk numbering, reverse-apply, rendered numbers and colours, click-to-comment,
`review.addComment` arguments (with `side`), removed-line threads, Send feedback, Viewed toggle.

## Comment side

`ReviewComment.side` is `old` for a comment on a removed line (its `line` is the old-side number) and `new`
otherwise (default; store column from migration 2). `UnifiedDiff` keys threads by side and line, so a removed-line
comment sits under that removed line, and the summary list and the feedback message say "removed line N".

## Gaps

- The design's summary text differs from the shared fixture's (the Wall uses the shorter one).
