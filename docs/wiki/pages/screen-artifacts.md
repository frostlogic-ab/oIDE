# Artifacts screen

The library of local designs, docs and whiteboards that you and your agents read and write. An
artifact is a folder of files (one entry file opens first); a claude.ai link becomes an artifact
through an agent that retrieves its files ([ADR 0014](../../adr/0014-multi-file-artifacts-retrieved-by-agents.md)).
Design: [../raw/design/Artifacts.dc.html](../raw/design/Artifacts.dc.html). Store and on-disk
layout: [artifacts.md](artifacts.md). Frame, router and stores: [desktop-shell.md](desktop-shell.md).
Code: `apps/desktop/src/renderer/src/screens/Artifacts/`.

## Layout (as designed)

- **Toolbar**: "Artifacts" (18px), kind tabs All / Designs / Docs / Whiteboards (28px pills,
  `role="tab"`, arrow keys), Project select, and one accent **+ New artifact** (the design's
  "Import from claude.ai" button is gone: creating from a link is a choice inside New artifact).
  The search field sits in the header's actions slot (`<HeaderSlot name="actions">`), because a
  fifth control would wrap the designed toolbar at 1440px.
- **Grid**: `repeat(auto-fill, minmax(220px, 1fr))`, 12px gap. Each card is a `<button>` with the
  design's stylised kind thumbnail (grey blocks, not real content; version-0 cards too), title,
  "Kind · project" and a third line. Normally the use line: "Being written by an agent" (green),
  "Written by an agent · 1h ago", "Read by 2 agents", "Not used by agents". While a retrieval runs:
  a running-green dot that pulses (`motion-safe:animate-pulse`, still under prefers-reduced-motion)
  and "Retrieving with an agent"; after a failed one: a red alert icon and "Retrieval failed" (no
  files yet) or "Update failed" (the current version stays). A **broken import**
  (`meta.brokenImport`: a link-only import made by an older oIDE) shows a red `Import has no
  content` badge. Icon plus text everywhere, never colour alone. Selected card = accent border.
  Double-click opens it. Dropping files on the grid opens New artifact on Files with them chosen.
- **Detail pane** (320–380px, `panel`): 190px live preview, title with Rename and Delete (trash
  icon) beside it, "Kind · project · origin" (origin "from claude.ai" for a claude.ai link), Open,
  Give to an agent, **Update** (refresh icon, accessible name "Update from claude.ai"; only for a
  claude.ai link with files and no retrieval running or failed), Open in claude.ai, a line
  "Retrieved 2h ago. Not synced: Update gets the latest version.", the retrieval block when one is
  running or failed, AGENTS USING IT, HISTORY (with "Compare versions"; "No versions yet." at
  version 0). With no files yet (version 0) the retrieval block takes the preview's place; for a
  broken import the **fix panel** does (`FixImportPanel.tsx`, below).
- **Retrieval block** (`Retrieval.tsx`, detail pane and open view):
  - *Retrieving*: pulsing green dot, "Retrieving from claude.ai", one line ("An agent is opening
    the link with your Claude Code CLI and copying its files here. The artifact fills in when it is
    done." or, on an update, "You're seeing v3 until it's done."), the agent's live status from the
    agents store in a `role="status"` box (status dot, agent title, status label, last activity line
    in mono; "Waiting for a free slot (Settings › Agents › Max running)." when queued; "It needs you:
    open the agent to answer." on a permission prompt or question), **Open agent** (Focus) and
    **Cancel**.
  - *Failed*: red card, alert icon, "Retrieval failed" / "Update failed", the agent's reason
    (`retrieval.error`, or "The agent stopped without handing over the files."), "v3 is unchanged."
    on an update, **Retry**, **Open agent**, and **Delete** when there are no files.
  - *Needs a project*: when `artifacts.refresh` answers `needs_project` (the artifact has no
    project), "Run the agent in" (a project select) with Update / Retry and Cancel, inline.
- **New artifact dialog** (`Dialogs.tsx`, 560px): a **Start from** radio group (the shared
  `SegmentedControl`: roving tabindex, arrow keys, Home / End): **A link** | **Files** | **Blank**.
  The last choice is kept between uses; Project and "Where it lives" are reset from the scope each
  time. The primary button stays disabled until the choice can go, with the reason beside it as
  its `aria-describedby`; focus starts on the first field of the choice; Esc closes.
  - *A link*: "Link" (mono) checked live with `classifyClaudeLink` (reason inline, `role="alert"`,
    `aria-invalid`; a half-typed link waits for blur), hint "An agent opens the link with your
    Claude Code CLI and copies its files here. You can follow it on the Wall; the artifact fills in
    when it's done.", Title (optional, "Uses the artifact's own title"), Kind (Detect, Design, Doc,
    Whiteboard). Project is required (no "No project"; hint "The agent runs in this project.").
    **Retrieve**. Reasons: "Paste a claude.ai link first.", "Fix the link first.", "Choose the
    project the agent runs in.", "Add a project first: the agent runs in one."
  - *Files*: a dashed zone with **Choose files…**, **Choose a folder…** and "or drop files here"
    (the whole dialog takes a drop, and a drop on another choice switches to Files); the chosen
    files listed by name (mono, 132px scroll, a Remove button each, count in a live region); refused
    drops as alert lines; **Opens on** (a select) when a design has several pages; Title (optional),
    Kind ("Detect (Design)" from the names, `kindFromFiles`), **Came from** (optional claude.ai link,
    checked like the link field). **Create**. Reasons: "Choose or drop files first.", "Fix the link
    it came from, or clear it.", and for dropped images alone "Add a page or another file too, or use
    Choose files… for images: a drop doesn't give oIDE an image's file path."
  - *Blank*: Title (required), Kind (Design / Doc / Whiteboard). **Create**. Reason "Give it a
    title first."
  - Shared, at the bottom: Project and "Where it lives" ("In the project's repo", `.oide/artifacts/`,
    needs a project; or "Personal"). Default: the repo for a blank artifact with a project, Personal
    for a link or files, until the user picks.
- **Open (Viewer.tsx)**: back button, title, "Kind · project · vN" (plus "· 9 files" for several
  files, "no files yet" at version 0), Unsaved changes badge, view tabs, Save, and a "More actions"
  menu (Rename, Delete). Tabs: docs and designs Edit / Preview / Compare; whiteboards Board /
  Compare. Editors are lazy chunks:

  | Kind | Edit | Preview |
  | --- | --- | --- |
  | Doc | Monaco (Markdown, word wrap) beside the rendered Markdown, live as you type | Rendered Markdown |
  | Design | Monaco (HTML, or JavaScript when `meta.entry` is `App.jsx`; the entry's language otherwise) beside the sandboxed preview of the **saved** version, which reloads on save ("Showing v3. Save to refresh the preview.") | Sandboxed preview |
  | Whiteboard | Embedded Excalidraw (`WhiteboardEditor.tsx`), dark theme on the oIDE tokens | (the board is the view) |

  Monaco reuses the Files screen setup (`screens/Files/monaco/setup.ts`: local package, `oide-dark`
  theme, inlined editor worker) through a dynamic import, so the Artifacts chunk stays small.
  Ctrl/Cmd+S saves in every editor. Plain keys typed in an editor stay there (`keepKeysInEditor`):
  Monaco types through an EditContext element and Excalidraw through its canvas, which the keymap
  does not see as editable, so J / K / N / Esc would otherwise also run app shortcuts.
  With no files yet (version 0) the retrieval block stands in for the tabs, editors and Save.
- **Files panel** (`FilesPanel.tsx`, open view, when `fileCount > 1`): a 232px `nav` "Files" left of
  the editors: a compact tree (folders first, then files, sorted; 12px indent per level; JetBrains
  Mono), the open file `aria-current`, the entry marked with an accent "Opens on" badge, size in the
  tooltip. Selecting the entry shows the tabs and editors above. Selecting another file replaces
  them (the tabs hide):
  - a text file opens in Monaco (language by extension, `languageForPath`), with a design's
    preview beside it; Save writes it (below); switching away from unsaved edits asks "Discard your
    changes?";
  - an image shows inline (an `<img>` with a data: URL from `artifacts.readFile`; the renderer CSP
    allows `data:` images but not the `oide-artifact:` scheme); other binary files say they can't be
    shown;
  - a design's other HTML pages offer **Open on this page** (disabled with "Save your changes first."
    while anything is unsaved).
- **Broken import** (`FixImportPanel.tsx`, in the detail pane and, full width, in the open view in
  place of the tabs and editors): heading "This import has no content", "An older oIDE saved only
  the link. An agent can retrieve the files with your Claude Code CLI, or you can choose files you
  downloaded.", **Retrieve with an agent** (`artifacts.refresh`; "Retry with an agent" after a
  failure, with the reason; not offered for an old chat link, which can't be retrieved), **Choose
  files…** and **Delete**. While the retrieval runs the retrieval block shows in its place. In the
  open view the first action has focus.
- **Compare**: From / To selects (every version, plus "Your unsaved changes" when dirty) over a
  read-only Monaco diff (`VersionDiff.tsx`, same theme as the Review split view) with a "+N −M
  lines" count. Whiteboard JSON is pretty-printed first so the diff is per property.

## Data flow

| What | IPC |
| --- | --- |
| Grid | `artifacts.list({})`, then `artifacts.uses({ ids })` (one call for all use lines); both reload on `artifacts.changed` |
| Detail | `artifacts.get({ id })` (meta, content, uses, versions), reloaded on `artifacts.changed` for that id |
| Design preview | `artifacts.previewUrl` → `oide-artifact://<id>/<entry>` in `<iframe sandbox="allow-scripts">` (opaque origin, main serves it with a no-network CSP). Main returns the **entry's** URL, so relative links to CSS, images and other pages of a multi-file design work. React designs (`entry: App.jsx`) use the same URL: main serves a generated page that runs the bundled offline runtime, under the same no-network CSP. Without a URL (dev mock), and for past versions, **HTML** goes in through `srcdoc` with `sandbox=""` (no scripts; relative files don't load). **React source never goes into `srcdoc`** (`looksLikeReact` on the content): the frame shows "Save to preview React changes. Use Compare to see older versions." (or, without a URL, "React designs preview in the desktop app.") |
| Doc preview | `marked` → DOMPurify (no `script`, `style`, `iframe`, `form`, `style=`); link clicks never navigate the window, https links go to `shell.openExternal` |
| Whiteboard preview | Read-only SVG render of the Excalidraw JSON (`Whiteboard.tsx`: rectangle, ellipse, diamond, line, arrow, freedraw, text) so the detail pane never loads Excalidraw. Colours are stored as Excalidraw stores them (light theme) and drawn through Excalidraw's dark-theme filter (`invert(93%) hue-rotate(180deg)`), so it matches the editor |
| Open | Editors per kind (above). Save → `artifacts.save({ id, content, note: 'Edited by you', baseVersion })`, a new numbered version; for an artifact of several files `artifacts.writeFiles({ id, files: [{ path: entry, encoding: 'utf8', data }], note, baseVersion })`, so the other files stay as they are. Whiteboards save `serializeAsJSON(elements, appState, files, 'local')`; selecting, zooming and panning are not edits (the first serialisation after loading is the baseline). Esc / Artifacts goes back, with a "Discard your changes?" confirm when dirty |
| Agent writes while open | `artifacts.changed` reloads `artifacts.get`. A newer version the viewer did not save itself: with no unsaved edits it is loaded (Excalidraw remounts with it) and a blue status bar says "Updated by <agent> agent · v5" with See changes (v4 → v5) and Dismiss; with unsaved edits the edits stay and an amber alert says "<Agent> saved v5 while you were editing" with Compare (theirs vs yours), **Keep mine** (saves yours as v6 on top, `baseVersion: 5`, note "Edited by you over v5"; v5 stays in History) and **Use theirs**. A save refused with `conflict` (the event not seen yet) opens the same banner. Decision logic: `liveDecision` in `model.ts`. A newer version that left the entry unchanged (an agent wrote another file) is taken quietly: no reload, no conflict. A version whose entry moved to another file reloads the editor from the new entry |
| Files panel | `artifacts.files({ id })` on open and on each new version; `artifacts.readFile({ id, path })` for the selected file. A text file saves with `artifacts.writeFiles({ id, files: [{ path, encoding: 'utf8', data }], note: 'Edited <path>', baseVersion })`. Same live rules as the entry (`useArtifactFile`): someone else's version that changed this file is loaded when there are no edits ("Updated by <agent> agent · v5", Dismiss) and becomes an amber "<Agent> saved v5 with changes to site.css while you were editing it" banner with **Keep mine** (`baseVersion: 5`, note "Edited site.css over v5") and **Use theirs** when there are; a version that didn't change it is taken quietly; a `conflict` refusal reads the latest and opens the banner. **Open on this page** → `artifacts.writeFiles({ id, entry: path, note: 'Opens on <path>', baseVersion })` (no file changes) |
| Retrieval | The card line and the retrieval block read `meta.retrieval` (`activeRetrieval`, `retrievalLine` in `model.ts`) and the agent from the agents store (`retrieval.agentId`). Update and Retry → `artifacts.refresh({ id })`; `needs_project` → the inline project select, then `artifacts.refresh({ id, projectId })`; `busy` → "An agent is already retrieving it." Cancel → `artifacts.cancelRetrieval({ id })`. Open agent → `navigate('focus', { agentId })`. Main's answer updates the pane at once; `artifacts.changed` (change `retrieval`, or `saved` when the files land) reloads the grid and the detail like any change. A finished first retrieval in the open view replaces the block with the editors |
| Rename | Detail pane or the viewer's More menu → dialog (title selected, 1 to 200 characters, `aria-invalid` on error) → `artifacts.rename`. Only the title changes |
| Delete | Trash icon or More menu → "Delete <title>?" confirm (repo: "deletes its folder in .oide/artifacts/ and all N versions; copies you committed stay in git history"; personal: "can't be undone"; no files yet: "It has no files yet. This can't be undone.") → `artifacts.delete`, toast, next artifact selected. An `artifacts.changed` with `change: 'deleted'` for the open artifact closes it quietly |
| Give to an agent | `navigate('spawn', { projectId, context: [{ kind: 'artifact', id, title }] })`; Spawn pre-fills its context chips from `route.params.context` |
| Open in claude.ai | Only when `importedFrom` is an https link on claude.ai (`canOpenClaudeLink`); `shell.openExternal`. Hidden for claude.site imports: that host is not on the external-link allow-list, since anyone can publish there |
| Agents using it | Uses grouped per agent: "writes" if it ever wrote or created, else "reads"; status dot and title from the agents store; click → Focus |
| History | `versions` newest first: "v4 · edited by you · 11:20", "v3 · Window shell layout agent · added a focus view · 10:52". Click a past version → `artifacts.readVersion` → previewed with "Viewing v2 (current is v4)", **Restore** (`artifacts.restore({ id, version, baseVersion })`: the whole snapshot, every file and the entry it had, becomes a new version noted "Restored v2"; toast "Restored v2 as v5") and **Back to latest**. Compare and the preview still use the entry's text (`readVersion`) |
| Fix a broken import | `FixImportPanel`: **Retrieve with an agent** → `artifacts.refresh` (as above). **Choose files…** → `dialog.pickArtifactFiles({ folder: false })`, then `artifacts.importFiles({ filePaths, url: importedFrom (only a link `classifyClaudeLink` accepts), title, projectId, location })`, then `artifacts.get` and `artifacts.delete` of the empty import only if it is still the same broken version (an agent may have written it meanwhile); the new artifact is selected |
| New artifact › A link | `artifacts.importLink({ url, title?, kind?, projectId, location })`. Main creates the artifact at version 0 with `retrieval.status: 'retrieving'` and starts an ordinary agent in the project (on the Wall, queued behind Max running); oIDE never downloads claude.ai content itself. The dialog closes, the new artifact is selected and shows its retrieving state, and a toast says "Retrieving <title> with an agent. You can follow it on the Wall." |
| New artifact › Files | `dialog.pickArtifactFiles({ folder: false })` (several files, any type) or `({ folder: true })` (one folder); main registers the picks. Dropped files go through the preload drop bridge (`window.oide.attachDropped`, `drop.ts`, at most 50): non-image files come back by path (main registers them as picked); images come back inline with no path, so they are added right after the import with `artifacts.writeFiles({ id, files: [{ path: name, encoding: 'base64', data }], baseVersion, note: 'Added the dropped images' })`; a dropped folder is refused ("Use Choose a folder… instead"). Then `artifacts.importFiles({ filePaths, folderPath?, entry? (Opens on, when there are several pages), url? (Came from), title?, kind?, projectId?, location })`. Outside the desktop app (dev mock) a drop says "Dropping files needs the desktop app. Use Choose files… instead." |
| New artifact › Blank | `artifacts.create({ title, kind, projectId?, location })` |

The Project select is the shared project scope (`useScope`): choosing a project here also scopes the
Wall, Files and Source control, and a scope chosen there filters this grid. Selection lives in the
route (`artifacts.artifactId`, via `replace`).

## Protocol additions (this screen)

`artifacts.uses({ ids })`, `artifacts.readVersion({ id, version })`, `dialog.pickFile`, optional
`projectId` / `location` on `artifacts.import`, `context` on the Spawn route params,
`artifacts.rename({ id, title })`, `artifacts.restore`, `baseVersion` on `artifacts.save`, and `change` / `version` /
`author` on the `artifacts.changed` event. ADR 0014 added `artifacts.importLink`, `refresh`,
`cancelRetrieval`, `files`, `readFile`, `writeFiles`, `importFiles`, `dialog.pickArtifactFiles`,
`retrieval` / `fileCount` on `ArtifactMeta` (version 0 allowed) and change `retrieval` on
`artifacts.changed`; the screen uses all of them and needed no further contract change.
`artifacts.import` and `dialog.pickFile` are no longer used by this screen. No renderer telemetry
events: retrieval is observed in main ([telemetry.md](telemetry.md)); the "Fetch with an agent"
event and its helper are gone.

## Excalidraw, CSP and bundle

- `@excalidraw/excalidraw` 0.18 (MIT; open question 16 chose it over tldraw), a devDependency of
  `@oide/desktop` like the other renderer libraries (bundled by Vite, not shipped as node_modules).
- **No CSP change.** Fonts are bundled: `apps/desktop/excalidraw-assets.ts` (a Vite plugin in both
  `electron.vite.config.ts` and `vite.web.config.ts`) copies `dist/prod/fonts/**` to
  `out/renderer/excalidraw-assets/fonts/` and serves them in dev; `excalidraw-env.ts` sets
  `window.EXCALIDRAW_ASSET_PATH` to that folder (absolute URL, since the packaged page's origin is
  "null") before Excalidraw loads, so they load under `font-src 'self'`. Excalidraw also names an
  esm.sh copy as a fallback `src` of every FontFace; Chromium reports a CSP violation for each of
  them (~240) when a board opens, so `excalidraw-env.ts` wraps `window.FontFace` to drop esm.sh
  sources. The e2e test checks there are no CSP violations and no failed font loads.
- Off on purpose instead of widening the CSP: file open/save and image export (the app saves through
  `artifacts.save`; SVG export subsets fonts with WebAssembly, which would need
  `'wasm-unsafe-eval'`), AI text-to-diagram (`aiEnabled={false}`), embeds (`validateEmbeddable`
  refuses all; `frame-src` only allows `oide-artifact:`). Element links open in the system browser
  (https only).
- Bundle (`electron-vite build`): first-load `index` chunk unchanged (+0.2 kB); Artifacts chunk
  53 → 75 kB; Monaco editor wrappers 8 kB (Monaco itself was already a lazy chunk); Excalidraw
  1.67 MB JS + 145 kB CSS, loaded when a board opens; fonts 13.1 MB (12.6 MB of it Xiaolai, the CJK
  hand-drawn fallback, fetched only for CJK text); about 9.8 MB of further lazy chunks
  (Mermaid-to-Excalidraw, font subsetting) that load only if those features are used.
  `out/renderer` grows from 11.6 MB to 36.3 MB on disk.

## Deviations from the design

- Search is in the header (see Layout); the design has no search.
- One **+ New artifact** button with a "Start from" choice (A link, Files, Blank) instead of the
  design's two buttons ("Import from claude.ai" and "+ New artifact"). The design has no dialog for
  either; this one is drawn with the design-system fields, segmented control and dashed drop zone.
- A link starts an agent that retrieves the files (ADR 0014) instead of a copy pasted by hand. The
  retrieving and failed states (card line, detail-pane block, open view) and the Update button are
  additions; so are the Files panel and "Open on this page".
- Failed: Delete is offered in the block only when there are no files (a failed first retrieval).
  After a failed update the artifact still has its content, so the block offers Retry and Open agent;
  Delete stays beside the title.
- The meta line says "from claude.ai" and "Retrieved 2h ago. Not synced: Update gets the latest
  version." instead of "synced from claude.ai": nothing syncs on its own.
- Open in claude.ai and Update are hidden for artifacts that did not come from claude.ai (and for
  claude.site links, which are not on the external-link allow-list).
- Grid thumbnails stay stylised as drawn; the detail pane shows the real content.
- The 190px doc preview fades its last line out (`.oide-md-fade`) instead of slicing it.

## Tests

`model.test.ts` (filters, use lines, reads/writes grouping, version labels, claude.ai host check and
`importLinkError`, `kindFromFiles`, `entryCandidates`, `baseName`, `activeRetrieval` /
`retrievalLine` / `canUpdateFromLink`, Monaco language per entry and per file, `fileTree`, image data
URLs and pages, front matter, whiteboard validation, `liveDecision`, author labels, diff text, rename
titles), `Artifacts.test.tsx` (kind / scope / search filtering, one creation button, Give to an agent
route with the context chip, Open in claude.ai only for claude.ai imports, DOMPurify strips scripts;
**New artifact**: the "Start from" radio group with arrow keys; A link: live check with the chat-link
reason and `aria-invalid`, each disabled reason as `aria-describedby`, no paste box or steps,
`importLink` with the project (and title, kind, location when chosen), no projects; Files: picked
files listed and removable, "Opens on", "Came from" check, `importFiles` with `entry` and `url`, a
folder by `folderPath`, several dropped files with the folder refusal, dropped images added with
`writeFiles` and `baseVersion`, images alone refused, the dev build's drop message; Blank: title
required, kind, repo default; scope reset and the kept choice; files dropped on the grid open Files;
**retrieval**: retrieving and failed card lines with icon and text, the retrieving block with the
agent's status, activity and queued line, Cancel, Open agent, the failed block with its reason,
Retry and Delete (no-files copy), Update with "Retrieved 2h ago", `needs_project` answered with the
inline select, `busy`, the current version kept on show during an update, reload on change
`retrieval`, the open view at version 0; **broken imports**: badge, Retrieve with an agent,
Choose files… imports then deletes (and keeps it when it changed), an old chat link neither retrieved
nor carried over, focus in the open view; React design: saved version by URL and a notice for a past
version, never `srcdoc`), `Editors.test.tsx` (Monaco, Excalidraw and the diff editor stubbed: doc
edit with live preview saved as v2 with `baseVersion`, agent write loaded with "Updated by",
conflict banner with Compare / Keep mine / Use theirs, a `conflict` save error, whiteboard dirty
tracking and reload, rename, delete with confirm, compare from History; **several files**: the tree
with "Opens on", another file saved with `writeFiles` and `baseVersion`, the discard confirm, entry
saves through `writeFiles`, another file's agent write taken quietly vs a conflict with Keep mine,
reload and Use theirs, an image as a data URL, Open on this page; a first retrieval landing while
open), `lib/mock/library.test.ts` (the dev mock's retrieval: an /artifact/ link fails with the
reason, a claude.ai/design link becomes nine files, `busy`, `needs_project`, cancel, files read and
written, `conflict`), `excalidraw-env.test.ts` (asset path, CDN sources dropped). E2E
`apps/desktop/e2e/artifacts.spec.ts`: the dialog opens on "A link", a chat link is refused there,
then Blank creates a doc that is edited in Monaco and saved as v2; draw on a whiteboard in the
packaged-CSP build and save v2 with bundled fonts and no CSP violations.

## Gaps

- Whiteboards have no source (JSON) view; agents write the JSON directly and Compare shows it.
- An agent write to a whiteboard you have not edited remounts Excalidraw, which resets zoom and scroll.
- Excalidraw image export and "copy as SVG" are off or degraded (see Excalidraw, CSP and bundle);
  "copy as PNG" from its context menu still works.
- The Xiaolai CJK font is 12.6 MB of the bundle; drop it from `excalidraw-assets.ts` if size matters
  more than hand-drawn CJK text (CJK then falls back to a system font).
- The app keymap treats Monaco's EditContext element as non-editable (`lib/keymap.ts`
  `isEditableTarget`); the Artifacts editors stop plain keys themselves, other Monaco hosts (Files)
  may still see J / K / N shortcuts fire while typing.
- Dropping files works only in the desktop app (the preload bridge reads the paths); the dev mock
  has no `attachDropped`, so use Choose files there. A drop takes at most 50 files and no folders.
  Dropped images have no path, so they arrive as a second version ("Added the dropped images"), and
  images alone can't start an artifact by drop (Choose files… can).
- React designs preview only as the saved current version; an older version or unsaved edit shows a
  notice (use Compare).
- Several files: Compare and History › view work on the entry file only (`readVersion`); Restore
  brings back every file (`artifacts.restore`). The Files
  panel edits one non-entry file at a time, has no rename, add or delete, and no Compare for
  non-entry files. The design preview beside a non-entry file shows the saved version, so a CSS
  edit shows after Save.
- With today's CLI most claude.ai `/artifact/` links fail retrieval with a reason (no CLI tool reads
  them yet); the failed block says why and offers Retry, Open agent and Delete. Claude Docs and
  claude.ai/design links work when the CLI has those connectors.
- A replacement made from a broken import's files gets a new id, so agents that knew the old id
  must be pointed at the new one.
