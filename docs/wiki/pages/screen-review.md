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
- Open pull request → `git.openPr { agentId }`, then opens the URL. Main writes the title and body
  to the project's own conventions (`packages/git/src/pr-draft.ts`): the agent's draft from
  `submit_for_review` (`pr`) when it gave one; otherwise the project's PR template
  (`.github/pull_request_template.md`, root, `docs/`, or a `PULL_REQUEST_TEMPLATE/` folder) with the
  summary under its Summary/Description heading and the checks as a task list under its testing
  heading, or summary + checks without a template. When the project uses Conventional Commits
  (commitlint, release-please or semantic-release config, a PR-title workflow, or 60% of recent
  commits) the title gets a `type(scope):` from the branch's own commits or the title's words.
  The Wall tile's Open PR takes the same path. With an existing PR it reads "View pull request #n". When `git.prAvailable`
  answers `available: false` it is disabled with the reason (default: install gh and `gh auth login`).
- Push to pull request (2026-11-26): once the branch has an open or draft PR, follow-up work (the
  agent continued after the PR and committed more, or left new files uncommitted) goes up to the same
  PR. Review reads `WorktreeInfo.unpushed` (commits the branch's own remote branch lacks: the upstream
  when it carries the branch name, else `origin/<branch>`, because a worktree made from `origin/main`
  tracks `origin/main`) and `WorktreeInfo.uncommitted` (files in `git status`). With either, the primary
  button is **Push to pull request #n** with a note ("Not on pull request #n yet: 2 new commits and 1
  uncommitted file. oIDE commits the files for the agent first."), and View pull request #n sits under
  it; up to date, only View pull request #n shows. `git.pushToPr { agentId }` commits leftover files on
  the agent's behalf (subject from its latest review summary, `Oide-Agent` trailer, like Merge locally),
  then pushes the branch; it never opens a PR (no open/draft PR → `conflict`) and refuses to commit
  under a working agent (starting, running, needs permission) so it never catches half-written files.
  The Wall tile in review shows a **Push** button next to View PR (same command; the toast says how many
  commits went up, or that the PR is already up to date).
- Comment cards and the inline composer are sized to the visible diff width and stick to its left
  edge, so long lines scroll sideways under them; the diff scroller uses full-width scrollbars.
- The file-list header sums the parsed patches; the Wall, Source control and Ready to review read
  `AgentSummary.diff` / `WorktreeInfo.diff`. Both come from the same git diff in main; the mock keeps
  them equal (`lib/mock/mock.test.ts`).
- Merge locally: confirm dialog → `git.mergeLocal`. The dialog predicts first (see
  [Merge conflicts](#merge-conflicts)); main is never left mid-merge.
- Nothing to push (2026-11-26): when the diff is empty (committed, uncommitted and untracked), the
  worktree is known with `ahead: 0` and there is no PR, Open pull request and Merge locally are
  replaced by **Archive session** (`agents.archive`, then back to the Wall) with a note saying there
  is nothing to push against the base. While the agent still works (not `canArchive`) the button is
  disabled and the note says to archive once it stops. Archived sessions can be unarchived from
  Wall › Archived.

## Merge conflicts

"If there's a conflict, send it back to the agent to solve, then I click Merge again" (2026-11-25).

- **Predict before merging.** Opening "Merge into main?" calls `git.predictMerge { agentId, refresh:
  true, withMainStatus: true }` (main: `git merge-tree --write-tree` between the main checkout's HEAD
  and the agent branch, no checkout touched; see [git-worktrees](git-worktrees.md#merge-overlaps-remote-prs-commit)).
  - Clean: "It merges cleanly into main @ abc1234." Primary: Merge.
  - Conflicts: "Merging will conflict in 3 files: a.ts, b.ts, c.ts and 1 more.", the file list (binary
    and submodule files badged), primary **Ask agent to resolve**, secondary **Merge anyway** (which
    still stops and aborts as before). The button label is fixed (agent titles are free text and
    pushed the footer out of the dialog); the note above it and the button tooltip name the agent.
  - Unknown (git older than 2.38): the reason, and Merge stays the action.
  - Uncommitted files in the main checkout are listed up front ("The ones this merge touches are set
    aside (stashed) for the merge and put back after it."). Merge recovers on its own (2026-11-25:
    "oIDE should automatically recover by stashing, merging and then unstashing"): `git.mergeLocal`
    stashes only the files in the way, merges, re-applies the stash and returns `autoStash { files,
    restored, note }`. The toast reads "Merged <branch> into <target>. Your uncommitted changes to …
    were set aside for the merge and put back." When they clash with the merge, the toast is a warning:
    the files are left as merged and the changes stay in the stash `oide: local changes set aside to
    merge <branch>` ("run git stash pop in the project folder to bring them back"). See
    [git-worktrees](git-worktrees.md#merge-overlaps-remote-prs-commit).
- **A merge that stops anyway** (prediction missed it, or could not run) shows "The merge stopped on
  conflicts" with the same **Ask agent to resolve** (`source: 'merge'`; main remembers the files
  the merge reported). When the agent cannot be asked, the old "Hand them to a new agent" (Spawn with
  the files as context) is offered instead.
- **Ask agent to resolve** → `git.askToResolve { agentId, source }`. Main re-predicts, then sends a
  `merge-conflicts` message (built in main only; `agents.send` refuses that kind) that the transcript
  shows in full under "Sent by oIDE": target branch and commit (`main` @ abc1234, or the commit on a
  detached HEAD), the conflicted files (binary / submodule notes), run `git merge <target>` in its own
  worktree (local refs are shared, no fetch; a remote-tracking target says fetch first), resolve
  keeping both sides' intent, run the project's checks, commit the merge, `submit_for_review` again;
  never rebase or force-push, never touch the main checkout, never `git merge --abort` without saying
  why. A stopped, interrupted or done agent is resumed with `--resume` (queued under Max running); a
  paused one is resumed; an archived one is unarchived first. Not offered (`canAsk: false`, reason
  shown) when its worktree is gone or the session cannot resume; an agent in the project folder has
  no branch, so nothing is predicted. Bypass agents are allowed (always in a worktree); untrusted
  projects keep their git restrictions (the prediction runs with the repo's exec config neutralised).
- **While it resolves**: `AgentSummary.mergeConflict { target, targetSha, files, sentAt }` puts a
  "Resolving merge conflicts" badge on the Wall tile and in Review ("Sent 2 conflicted files with main
  3m ago"); the activity line reads "Resolving merge conflicts". The reducer clears it when the lead
  submits for review again (back in Ready for review). Nothing merges on its own: the user clicks
  Merge again.
- **Freshness.** `stores/mergePrediction.ts` keeps one prediction per agent, loaded on mount and
  refreshed (debounced 400 ms) on `git.changed` for its project; main caches each answer per (HEAD,
  branch) commit pair, so renders never run git. Review shows "Up to date with main" / "Behind main by
  2 commits, would conflict in 1 file"; Ready-for-review tiles and Source control › Ready to review
  show the short form ("Behind main by 2 · would conflict"). If main moved while the agent worked,
  the next dialog predicts the new conflict and offers the same action.
- Telemetry: `merge_conflict_predicted`, `merge_conflict_sent_to_agent`, `merge_conflict_resolved`
  ([telemetry](telemetry.md)); never file names.
- Tests: `packages/git/test/predict.test.ts` (conflicts, clean, after resolving, binary and
  modify/delete, detached HEAD, old-git fallback, dirty main), `test/integration/merge-conflicts.test.ts`
  (live, stopped, archived, queued at Max running, worktree gone, project folder, message content),
  `MergeDialog.test.tsx` (dialog states), `e2e/merge-conflicts.spec.ts` (fake agent resolves, dialog
  then predicts clean).

## Load errors and sending feedback
- When `git.diff` fails, the main pane shows "Couldn't load the changes" with the message and a
  "Try again" button (`review.reload()`). "No changes yet" appears only when the diff loaded and is empty.
- The send button in the summary reads "Send N comments to agent" and is enabled only while comments
  are pending. After a send with nothing pending it is disabled and a polite live region says
  "Feedback sent · agent is revising"; a new comment brings the button back.

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
