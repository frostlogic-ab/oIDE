# ADR 0017: Artifact agents work in an empty folder and edit one artifact over MCP

- Status: accepted
- Date: 2026-11-27
- Departs from: build brief, "Agents" (every agent works in a git worktree of a project, or in the
  project folder) and "Artifacts integration" (agents get artifacts as context chips; the user edits
  in the Viewer).

## Context
Users want to work on an artifact (a design, doc or whiteboard) with an agent from the artifact's
own open view: give directions, point at the preview and send that feedback, and watch the result
land, without leaving the Artifacts screen. An artifact is a folder of versioned files in oIDE's
store (ADR 0004, ADR 0014), not files of a repository, so a worktree is the wrong place: the agent
would be told to commit and merge, could change the repo, and costs a `git worktree add` for nothing.

## Decision
1. **An artifact agent** is an ordinary oIDE agent (the user's own unmodified `claude` CLI, queued
   behind Max running, on the Wall, asking for permissions) with `AgentSpec.artifactId` and
   `workIn: 'artifact-folder'`. Only main makes one (`artifacts.startAgent`); `agents.spawn` refuses
   both fields. One live agent per artifact (`busy` otherwise).
2. **It works in an empty scratch folder** `<userData>/artifact-agents/<agentId>`: no repo, no
   branch, no `.oide/setup`, no git watching or diff. Archiving with "delete worktree" deletes the
   folder. The project (the artifact's own, or one the user picks for a personal artifact) still
   gives it its settings, permissions and trust rules. Bypass is allowed there when Settings allow it
   (it is not the project folder).
3. **It changes the artifact only through oIDE's MCP tools.** Its system prompt is a separate
   contract (`artifactContract`: no commits, no `submit_for_review`, no repository) naming its
   artifact id. `artifacts_write` gains `edits` (exact search and replace, like the CLI's Edit tool)
   so small changes do not resend whole files. Main lets it write only its own artifact and create
   none; it always sees its own artifact (also a repo artifact of an untrusted project, since the
   user opened it and asked). Every write is a numbered version, so the open view's live-update,
   conflict, Compare and Restore flows apply unchanged.
4. **Writes to its own artifact go without a prompt in the modes that edit without asking** (Edit
   automatically, Auto, Bypass); Manual and Plan still ask for each write.
5. **Point and comment.** Every HTML page main serves from `oide-artifact://` loads
   `/__oide/picker.js`, inert until the Artifacts screen (the frame's parent) turns pick mode on. It
   posts the picked element's selector, tag, text and box to the parent, which accepts a message only
   from that frame's window and only if it parses (`PreviewPickerMessage`). The user writes the
   comments and chooses which to send; they reach the agent as one plain text message.
6. **Model and effort switch from the next turn** (`agents.setModel`, for any agent): the CLI reads
   both only at launch, so an idle process ends and the next message resumes the session with the
   new flags; a working turn is never cut short. Refused for a custom model.

## Consequences
- Artifact agents appear on the Wall like any agent (their permission prompts and errors surface
  there too), titled "Edit <artifact>".
- The agent cannot use its own Read/Edit tools on the artifact's files; it reads and writes them over
  MCP. Large binary files go through `files` with base64 or `fromFile` (inside its own folder).
- The picker script is part of every served HTML page; the artifact CSP still blocks all network
  access, and the page can post the parent only data the user sees before anything is sent.
