# Artifacts

A local library of designs, docs and whiteboards that you and your agents read and write.

| Kind | Stored as | Preview | Open (edit) |
| --- | --- | --- | --- |
| Design | A self-contained HTML file | A sandboxed frame with no network access | Monaco (HTML) beside the sandboxed preview of the saved version |
| Doc | Markdown with front matter | Rendered and sanitized | Monaco (Markdown) beside the live preview |
| Whiteboard | Excalidraw JSON | A read-only drawing | The embedded Excalidraw whiteboard editor |

Ctrl/Cmd+S saves in every editor; each save is a new version. **Compare** shows a diff between any
two versions (or your unsaved changes). If an agent saves a new version while you are editing, oIDE
keeps your edits and lets you compare, **Keep mine** (saved on top as a newer version) or **Use
theirs**. Artifacts can be renamed and deleted from the detail pane or the editor's **More** menu.

## Where they live

When you create an artifact you choose **In the project's repo** (`.oide/artifacts/`, shared through
git) or **Personal** (oIDE's app data). Every save is a new numbered version.

## The screen

- Kind tabs (All, Designs, Docs, Whiteboards), the project scope, search, **Import from claude.ai**
  and **New artifact**.
- Each card says how agents use it: "Being written by an agent", "Read by 2 agents", "Not used by
  agents".
- The detail pane shows a live preview, **Open**, **Give to an agent** (opens Spawn with the artifact
  as context), **Agents using it** (reads or writes), **History** (open any past version and
  **Restore** it, or **Compare versions**), and Rename / Delete.
- An artifact tagged with an extension's artifact type opens in that extension's viewer when the
  extension is on (see [extension contributions](/extensions/contributions#other-contribution-points)).

## How agents use them

Every agent gets oIDE's own MCP server, with the tools `artifacts_list`, `artifacts_read`,
`artifacts_write` and `artifacts_create`. Every call is logged, which fills "Agents using it".

## claude.ai

There is no public API for claude.ai artifacts, so there is no sync, and oIDE can't download an
artifact for you, not even a public one (it never uses your claude.ai sign-in). **Import from
claude.ai** stores a copy, and it always needs the artifact's real content: oIDE never creates an
artifact from a link alone.

- **Paste a link**: paste the artifact's link, click **Open** to view it on claude.ai, use **Copy**
  (or **Download**) there and paste the code into **Artifact content**. **Import** stays disabled
  until there is code, and says why. oIDE picks the kind from the content (an HTML page or a React
  component becomes a design) and the title from its heading. Chat links are refused with a reason:
  open the artifact in the chat and copy its own link, or just paste its code.
- **Pick a file**: choose a file you downloaded from claude.ai (.html, .jsx, .tsx, .svg, .md or
  .excalidraw), or drop it on the dialog. Dropping a file on the Artifacts grid opens the dialog with
  it chosen. You can add the link too, so **Open in claude.ai** appears on the copy.
- **Fetch with an agent**: for a valid link, this starts an agent that reads the artifact with its
  own claude.ai connectors and creates it only if it gets the real content. It works for Claude Docs
  and Claude Design projects. Chat artifacts can't be fetched, even public ones: ask Claude on
  claude.ai to save the design as a Doc to make this automatic.

Designs are HTML pages or React components. React runs in the same sandboxed preview as HTML,
offline and without network access, using a runtime that ships with oIDE; the editor shows it as
JavaScript. Older versions of the preview or unsaved React edits show a short notice instead: save to
preview the change, and use **Compare** for older versions.

An import made by an older oIDE from a link alone has no content. Its card says **Import has no
content**, and opening it shows a panel to paste the code, choose or drop the downloaded file (which
replaces the empty import), or delete it. **Open in claude.ai** appears only for artifacts that came
from there.

Details: [screen-artifacts](https://github.com/oide-dev/oide/blob/main/docs/wiki/pages/screen-artifacts.md).
