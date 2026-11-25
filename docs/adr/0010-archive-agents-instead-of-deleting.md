# ADR 0010: Merged and discarded agents are archived, not deleted

- Status: accepted
- Date: 2026-11-25
- Departs from: build brief, Source control and Review flows, where cleanup after a merge (and
  "Remove worktree") removes the agent together with its worktree.

## Context
`Supervisor.remove()` ended the process, optionally deleted the worktree, and deleted the agent row
and its events. Merge (cleanup "Right away", or the 7-day sweep) and Source control › Remove worktree
went through it, so a merged or discarded agent vanished: its transcript, branch, final diff stats and
cost were gone, and a user could not look back at what an agent did or why. Users asked for finished
agents to stay visible "in another view" (Archived), and for agents interrupted by a restart to stay
on the Wall, resumable.

## Decision
- Merge (in oIDE or a PR merged on the forge), discard (`agents.remove`), `done`, and a new Archive
  action **archive** the agent: `Supervisor.archive()` ends the process, applies worktree cleanup as
  before, stamps `summary.archived = { at, reason, mergeCommit?, worktreeRemoved }` and saves it; the
  agent leaves the supervisor (so no counter and no Max running slot sees it). Row, summary and
  events stay (migration 3 adds `archived_at`, `archive_reason`, `merge_commit`).
- Wall › Archived lists them (paged, searchable, project-scoped); Focus opens one read-only from the
  database. Unarchive puts it back on the Wall (Resume blocked when its worktree is gone).
- Hard delete remains as "Delete permanently" (native confirmation in main) and when a project is
  removed from oIDE (its rows cascade).
- Event retention: archived agents' events older than 30 days are compacted (bookkeeping events into
  a summary row, raw JSON dropped, tool output trimmed), not deleted, so the transcript stays readable.

## Consequences
- The database grows with history; compaction bounds the per-agent cost. "Delete permanently" is the
  way to reclaim it.
- Kept worktrees of archived agents (Clean up "Never" / "After 7 days") are not orphans in Source
  control; the 7-day sweep deletes an archived agent's worktree in place.
- `agents.removed` now means "deleted permanently"; archiving emits `agents.archived`.
