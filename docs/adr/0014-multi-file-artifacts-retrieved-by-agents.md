# ADR 0014: Artifacts are folders of files, and linked artifacts are retrieved by agents

- Status: accepted
- Date: 2026-11-25
- Departs from: build brief, "Artifacts integration" (one entry file per artifact, import from
  claude.ai as a manual copy), and the import rule "nothing is created without its content".
- Supersedes: the paste-a-link import dialog, the "Fetch with an agent" hand-off to Spawn, and the
  broken-import fix panel's paste box.

## Context
A claude.ai Design artifact is a project, not a page: several HTML pages, shared CSS, a canvas
layout file and a folder of screenshots. oIDE stored one entry file per artifact, so even a pasted
copy lost most of it.

oIDE itself must not download it: there is no public content API, and oIDE never reads or uses the
user's claude.ai credentials or calls Anthropic directly (CLAUDE.md hard rules 3 and 4). The user's
own `claude` CLI can, when it has a claude.ai tool for that kind of link: the Claude Docs connector
for docs and `DesignSync` for claude.ai/design projects today, and an Artifact tool when the CLI
gets one (the Claude desktop app has one; CLI 2.1.332 does not). Asking the user to copy files by
hand was the workaround the user rejected.

## Decision
1. **An artifact is a folder of files.** The entry file (what a design previews from, the doc's
   Markdown, the board's JSON) is one of them, chosen by `entry` (any safe relative path). Every
   version is a full snapshot of the folder (ADR 0004 still holds, per folder instead of per file).
   Paths are checked with `isSafeArtifactPath` in the protocol and resolved inside the folder in
   main. Limits: 500 files, 10 MB per file, 100 MB per version.
2. **A link becomes an artifact through an agent.** New artifact › From a link creates the artifact
   at version 0 with `retrieval.status = 'retrieving'` and starts an ordinary oIDE agent (it shows on
   the Wall, is queued behind Max running, and asks for permissions like any agent) whose goal is to
   read the link with its claude.ai tools and hand the files to oIDE with the MCP tools
   `artifact_retrieval_add_files` and `artifact_retrieval_finish`. Files are staged and become a new
   version only when the agent finishes successfully; a failure leaves the current version untouched
   and records the agent's reason. Only the agent started for that retrieval may call those tools.
3. **Update** on a linked artifact starts the same retrieval again; the result is the next version.
4. When the CLI has no tool that can read the link, the agent says so and the artifact shows that
   reason with Retry and Delete. oIDE does not fall back to a browser or a web fetch.

## Consequences
- An artifact can exist with no files (version 0) while it is being retrieved, or after a first
  retrieval failed. The UI, the MCP `artifacts_read` tool and the preview handle version 0.
- Today a claude.ai `/artifact/<id>` Design link fails with a clear reason, because the CLI has no
  tool that reads it. It starts working without oIDE changes once the CLI gets such a tool.
- Each retrieval spends plan usage like any agent run. It runs in a worktree of the chosen project,
  removed when the retrieval succeeds.
