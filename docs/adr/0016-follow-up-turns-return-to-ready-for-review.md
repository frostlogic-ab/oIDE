# ADR 0016: Follow-up turns after a review return to Ready for review

- Status: accepted
- Date: 2026-11-26
- Departs from: build brief, status table ("Has a question: the turn ended (`result`) without the agent
  calling `oide.submit_for_review`").

## Context
Many agents submit for review and then keep talking with the user: the user asks for a push, a CI
check or a small extra fix, and the agent answers with a status report ("PR #10's CI is green") without
calling `submit_for_review` again. A background task finishing (a CI watch) can also start a turn the
user did not send. Under the brief's rule every such turn ends as **Has a question**, so the Wall shows
an amber "needs you" tile for an agent that asked nothing and whose work is still ready to merge.

## Decision
When a turn ends without `submit_for_review`, the reducer (`packages/agent-core/src/reducer.ts`)
returns **Ready for review** instead of **Has a question** when both hold:

1. the agent already submitted for review in an earlier turn (`summary.review` is set), and
2. its final message asks the user nothing (`asksUser`): no `?` outside code spans, code blocks and
   links, and no plain request such as "let me know", "please confirm" or "I need your decision".

Everything else is unchanged: an agent that never submitted still ends as Has a question, and a
follow-up that asks something is still Has a question. The earlier review (summary, checks) stays.

## Consequences
- Status-only follow-ups no longer count as "Needs you" and go back to the blue review tile.
- The check errs towards Has a question: a rhetorical `?` in a status report shows the old behaviour,
  which is safer than hiding a real question.
- The "ready for review" notification can fire again after such a follow-up, with the earlier summary.
