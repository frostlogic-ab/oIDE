# Artifacts

A local library of designs, docs and whiteboards that you and your agents read and write. An
artifact is a folder of files: one **entry** file that opens first, plus any pages, styles and
images it needs.

| Kind | Entry file | Preview | Open (edit) |
| --- | --- | --- | --- |
| Design | An HTML page, an SVG or a React component; a design can have many pages, styles and images | A sandboxed frame with no network access | Monaco beside the sandboxed preview of the saved version |
| Doc | A Markdown (or other text) file | Rendered and sanitized | Monaco (Markdown) beside the live preview |
| Whiteboard | An Excalidraw file | A read-only drawing | The embedded Excalidraw whiteboard editor |

Ctrl/Cmd+S saves in every editor; each save is a new version. If an agent saves a new version while
you are editing, oIDE keeps your edits and lets you compare, **Keep mine** (saved on top as a newer
version) or **Use theirs**.

## Where they live

When you create an artifact you choose **In the project's repo** (`.oide/artifacts/`, shared through
git) or **Personal** (oIDE's app data). Every save is a new numbered version.

## The screen

- Kind tabs (All, Designs, Docs, Whiteboards), the project scope, search and **New artifact**.
- Each card says how agents use it: "Being written by an agent", "Read by 2 agents", "Not used by
  agents". While a link is being retrieved it says "Retrieving with an agent"; after a failure,
  "Retrieval failed" (or "Update failed" when the artifact already has files).
- The detail pane shows a live preview, **Open**, **Give to an agent** (opens Spawn with the artifact
  as context), **Update** (for an artifact that came from a claude.ai link), **Open in claude.ai**,
  **Agents using it** (reads or writes), **History**, and Rename / Delete.
- An artifact tagged with an extension's artifact type opens in that extension's viewer when the
  extension is on (see [extension contributions](/extensions/contributions#other-contribution-points)).

## New artifact

One dialog, three ways to start. Pick under **Start from**; oIDE remembers your last choice. The main
button stays disabled until the choice can go, and says why next to it. Dropping files on the
Artifacts grid opens the dialog on **Files** with them chosen.

- **A link**: paste a claude.ai link (Claude Design, a published or shared artifact, or a claude.site
  artifact). Optionally give a title and a kind; otherwise oIDE uses the artifact's own. Choose the
  **project** the agent runs in (required), then **Retrieve**. Links to a chat are refused with a
  reason: open the artifact in the chat and copy its own link.
- **Files**: **Choose files…** (any type), **Choose a folder…** (its files, with their folders), or
  drop them on the dialog. For a design with several pages, **Opens on** picks the entry. You can add
  a **Came from** link, so **Open in claude.ai** appears on the copy. Dropped images alone can't
  start an artifact (a drop doesn't give oIDE an image's path); use Choose files… for those.
- **Blank**: a title and a kind (design, doc or whiteboard).

At the bottom, **Where it lives** is the project's repo or Personal. A link or files default to
Personal; a blank artifact in a project defaults to the repo.

## A link: an agent retrieves it

There is no public API for claude.ai artifacts, and oIDE never downloads one or uses your claude.ai
sign-in. When you choose **A link**, oIDE creates the artifact empty ("No files yet") and starts an
ordinary agent in the project you picked. That agent opens the link with **your own Claude Code
CLI**, copies the files it finds (pages, styles, images, with their folders) and hands them back to
oIDE. The artifact fills in when it is done, as its first version.

- **Follow it on the Wall.** The agent is titled "Retrieve" followed by the artifact title, takes a slot like any
  agent (it queues behind **Max running**), and asks for permissions like any agent. The artifact's
  detail pane also shows its live status, with **Open agent** to jump to it and **Cancel**.
- **It can fail, and says why.** The card turns red with "Retrieval failed" and the agent's reason.
  The most common one today: the Claude Code CLI has no tool that can read that kind of link (it can
  read Claude Docs and claude.ai/design projects, but not an artifact from a chat). The reason then
  suggests what to do: download the files on claude.ai and use **New artifact › Files**, or ask
  Claude on claude.ai to save it as a Doc. When a CLI update adds such a tool, retrying works without
  any change in oIDE.
- **After a failure** you can **Retry** (a new agent tries again), **Open agent** (read what it
  said), or **Delete** the empty artifact. Nothing is created from a link that failed.

## Update

An artifact that came from a link keeps it. **Update** (the refresh button in the detail pane, "Update
from claude.ai") starts a new retrieval agent for the same link. The current version stays in place
and keeps working while it runs ("You're seeing v3 until it's done"); the result becomes the next
version, so nothing is lost and you can **Compare** or **Restore** the older one. If the artifact
has no project, oIDE asks which project the agent should run in. The detail pane shows when it was
last retrieved, and reminds you that it is a copy, not synced: nothing updates on its own.

## Several files

A design retrieved from Claude Design, or created from files or a folder, is a multi-file artifact.
Its header says "9 files". Open it and the **Files** panel appears on the left: a tree of folders and
files with the entry marked **Opens on**.

- A text file (HTML, CSS, JS, JSON, Markdown…) opens in the editor, with the design's preview beside
  it. Saving a file writes a new version in which the other files stay exactly as they were.
- An image shows inline; other binary files say they can't be shown.
- For another HTML page, **Open on this page** makes it the entry (a new version, no file changes).
- If you have unsaved edits, switching files asks before it discards them. If an agent changes the
  file you are editing, you get the same banner as for the entry: **Keep mine** or **Use theirs**.

The Files panel edits one existing text file at a time. To add, remove or rename files, ask an agent
or re-import.

Designs are HTML pages or React components. React runs in the same sandboxed preview as HTML,
offline and without network access, using a runtime that ships with oIDE. Older versions of the
preview or unsaved React edits show a short notice instead: save to preview the change, and use
**Compare** for older versions.

## History and restore

**History** lists every version, newest first, with who made it (you, or an agent) and a note.
Every version is a complete snapshot of all the files. Click an older version to preview it
("Viewing v2 (current is v4)"), then:

- **Restore** brings back that whole version, every file and the entry it had, as a **new** version
  ("Restored v2 as v5"). Files you added or changed since then go back to how they were, and files
  you deleted come back. Nothing is lost: the version you restored from, and the one you left, stay
  in History. If someone saved in the meantime, Restore stops and tells you instead of overwriting it.
- **Compare versions** shows a diff between any two versions, or your unsaved changes. Compare and
  the version preview show the entry file.
- **Back to latest** leaves the old version.

## How agents use them

Every agent gets oIDE's own MCP server, with the tools `artifacts_list`, `artifacts_read`,
`artifacts_write` and `artifacts_create`. They work with all the files of an artifact, not only the
entry. Every call is logged, which fills "Agents using it".

## Older imports with no content

An import made by an older oIDE from a link alone has no content. Its card says **Import has no
content**, and opening it shows a panel with **Retrieve with an agent** (the same retrieval as
above), **Choose files…** (replaces the empty import), or delete. **Open in claude.ai** appears only
for artifacts that came from there.

Details: [screen-artifacts](https://github.com/oide-dev/oide/blob/main/docs/wiki/pages/screen-artifacts.md).
