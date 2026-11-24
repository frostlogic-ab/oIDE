# Artifacts screen

The library of local designs, docs and whiteboards that you and your agents read and write.
Design: [../raw/design/Artifacts.dc.html](../raw/design/Artifacts.dc.html). Store and on-disk
layout: [artifacts.md](artifacts.md). Frame, router and stores: [desktop-shell.md](desktop-shell.md).
Code: `apps/desktop/src/renderer/src/screens/Artifacts/`.

## Layout (as designed)

- **Toolbar**: "Artifacts" (18px), kind tabs All / Designs / Docs / Whiteboards (28px pills,
  `role="tab"`, arrow keys), Project select, "Import from claude.ai", accent "+ New artifact".
  The search field sits in the header's actions slot (`<HeaderSlot name="actions">`), because a
  fifth control would wrap the designed toolbar at 1440px.
- **Grid**: `repeat(auto-fill, minmax(220px, 1fr))`, 12px gap. Each card is a `<button>` with the
  design's stylised kind thumbnail (grey blocks, not real content), title, "Kind · project" and a
  use line: "Being written by an agent" (green), "Written by an agent · 1h ago", "Read by 2
  agents", "Not used by agents". Selected card = accent border. Double-click opens it.
- **Detail pane** (320–380px, `panel`): 190px live preview, title, "Kind · project · origin",
  Open, Give to an agent, Open in claude.ai, AGENTS USING IT, HISTORY.

## Data flow

| What | IPC |
| --- | --- |
| Grid | `artifacts.list({})`, then `artifacts.uses({ ids })` (one call for all use lines); both reload on `artifacts.changed` |
| Detail | `artifacts.get({ id })` (meta, content, uses, versions), reloaded on `artifacts.changed` for that id |
| Design preview | `artifacts.previewUrl` → `oide-artifact://<id>/index.html` in `<iframe sandbox="allow-scripts">` (opaque origin, main serves it with a no-network CSP). Without a URL (dev mock), and for past versions or unsaved edits, the HTML goes in through `srcdoc` with `sandbox=""` (no scripts) |
| Doc preview | `marked` → DOMPurify (no `script`, `style`, `iframe`, `form`, `style=`); link clicks never navigate the window, https links go to `shell.openExternal` |
| Whiteboard preview | Read-only SVG render of the Excalidraw JSON (`Whiteboard.tsx`: rectangle, ellipse, diamond, line, arrow, freedraw, text). Embedding the Excalidraw editor is left for later (bundle size, CSP-friendly build) |
| Open | Full-size view with Preview / Edit (docs: editor and live preview side by side; designs and whiteboards: "Edit source"). Plain `<textarea>` editor, Ctrl/Cmd+S saves through `artifacts.save` (new numbered version, note "Edited by you"); whiteboards must stay a JSON object. Esc / Artifacts goes back, with a "Discard your changes?" confirm when dirty |
| Give to an agent | `navigate('spawn', { projectId, context: [{ kind: 'artifact', id, title }] })`; Spawn pre-fills its context chips from `route.params.context` |
| Open in claude.ai | Only when `importedFrom` is an https link on claude.ai / claude.site; `shell.openExternal` |
| Agents using it | Uses grouped per agent: "writes" if it ever wrote or created, else "reads"; status dot and title from the agents store; click → Focus |
| History | `versions` newest first: "v4 · edited by you · 11:20", "v3 · Window shell layout agent · added a focus view · 10:52". Click a past version → `artifacts.readVersion` → previewed with "Viewing v2 (current is v4)", **Restore** (saves it as a new version) and **Back to latest** |
| Import from claude.ai | Dialog with "Paste a link" (must be https claude.ai; main stores a link-only stub because claude.ai has no public content API) or "Pick a file" (`dialog.pickFile`, then `artifacts.import({ filePath })`; main only accepts a path picked in this session). Title, kind, project, where it lives. Copy says it is a copy, not synced |
| New artifact | Title (required, `aria-invalid`), kind, project (or none), where it lives: "In the project's repo" (`.oide/artifacts/`, shared through git; needs a project) or "Personal" (app data) → `artifacts.create` |

The Project select is the shared project scope (`useScope`): choosing a project here also scopes the
Wall, Files and Source control, and a scope chosen there filters this grid. Selection lives in the
route (`artifacts.artifactId`, via `replace`).

## Protocol additions (this screen)

`artifacts.uses({ ids })`, `artifacts.readVersion({ id, version })`, `dialog.pickFile`, optional
`projectId` / `location` on `artifacts.import`, `context` on the Spawn route params.

## Deviations from the design

- Search is in the header (see Layout); the design has no search.
- The meta line says "imported from claude.ai" instead of "synced from claude.ai": v1 has no sync.
  A line under the buttons says it is a copy, not synced.
- Open in claude.ai is hidden for artifacts that did not come from claude.ai.
- Grid thumbnails stay stylised as drawn; the detail pane shows the real content.
- The 190px doc preview fades its last line out (`.oide-md-fade`) instead of slicing it.

## Tests

`model.test.ts` (filters, use lines, reads/writes grouping, version labels, claude.ai link check,
front matter, whiteboard validation) and `Artifacts.test.tsx` (kind / scope / search filtering,
Give to an agent route with the context chip, Open in claude.ai only for claude.ai imports,
DOMPurify strips scripts from docs).

## Gaps

- No embedded Excalidraw editor; whiteboards are edited as JSON.
- Monaco is not used for the editor (a textarea keeps the screen light); swap it in if docs grow.
- No delete or rename in the UI yet (`artifacts.delete` exists).
- Dropping a file onto the screen is not supported (sandboxed renderer has no file paths).
