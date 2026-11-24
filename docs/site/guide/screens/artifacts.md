# Artifacts

A local library of designs, docs and whiteboards that you and your agents read and write.

| Kind | Stored as | Preview |
| --- | --- | --- |
| Design | A self-contained HTML file | A sandboxed frame with no network access |
| Doc | Markdown with front matter | Rendered and sanitized; edit side by side with the preview |
| Whiteboard | Excalidraw JSON | A read-only drawing; edit the JSON source (no embedded whiteboard editor yet) |

## Where they live

When you create an artifact you choose **In the project's repo** (`.oide/artifacts/`, shared through
git) or **Personal** (oIDE's app data). Every save is a new numbered version.

## The screen

- Kind tabs (All, Designs, Docs, Whiteboards), the project scope, search, **Import from claude.ai**
  and **New artifact**.
- Each card says how agents use it: "Being written by an agent", "Read by 2 agents", "Not used by
  agents".
- The detail pane shows a live preview, **Open**, **Give to an agent** (opens Spawn with the artifact
  as context), **Agents using it** (reads or writes) and **History** (open any past version and
  **Restore** it).

## How agents use them

Every agent gets oIDE's own MCP server, with the tools `artifacts_list`, `artifacts_read`,
`artifacts_write` and `artifacts_create`. Every call is logged, which fills "Agents using it".

## claude.ai

There is no public API for claude.ai artifacts, so there is no sync. **Import from claude.ai** stores
a copy: paste a link (stored as a link) or pick an exported file. **Open in claude.ai** appears only
for artifacts that came from there.

Details: [screen-artifacts](https://github.com/oide-dev/oide/blob/main/docs/wiki/pages/screen-artifacts.md).
