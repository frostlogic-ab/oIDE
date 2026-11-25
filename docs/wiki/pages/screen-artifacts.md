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
  agents", "Not used by agents". Selected card = accent border. Double-click opens it. A **broken
  import** (`meta.brokenImport`: a link-only import made by an older oIDE, whose only version is the
  old notice) shows a red `Import has no content` badge (alert icon plus text, not colour alone) in
  place of the use line. Dropping one file on the grid opens the Import dialog on "Pick a file" with
  it chosen.
- **Detail pane** (320–380px, `panel`): 190px live preview, title with Rename and Delete (trash
  icon) beside it, "Kind · project · origin", Open, Give to an agent, Open in claude.ai, AGENTS USING
  IT, HISTORY (with "Compare versions"). For a broken import the preview is replaced by the **fix
  panel** (`FixImportPanel.tsx`, below).
- **Open (Viewer.tsx)**: back button, title, "Kind · project · vN", Unsaved changes badge, view tabs,
  Save, and a "More actions" menu (Rename, Delete). Tabs: docs and designs Edit / Preview / Compare;
  whiteboards Board / Compare. Editors are lazy chunks:

  | Kind | Edit | Preview |
  | --- | --- | --- |
  | Doc | Monaco (Markdown, word wrap) beside the rendered Markdown, live as you type | Rendered Markdown |
  | Design | Monaco (HTML, or JavaScript when `meta.entry` is `App.jsx`) beside the sandboxed preview of the **saved** version, which reloads on save ("Showing v3. Save to refresh the preview.") | Sandboxed preview |
  | Whiteboard | Embedded Excalidraw (`WhiteboardEditor.tsx`), dark theme on the oIDE tokens | (the board is the view) |

  Monaco reuses the Files screen setup (`screens/Files/monaco/setup.ts`: local package, `oide-dark`
  theme, inlined editor worker) through a dynamic import, so the Artifacts chunk stays small.
  Ctrl/Cmd+S saves in every editor. Plain keys typed in an editor stay there (`keepKeysInEditor`):
  Monaco types through an EditContext element and Excalidraw through its canvas, which the keymap
  does not see as editable, so J / K / N / Esc would otherwise also run app shortcuts.
- **Broken import** (`FixImportPanel.tsx`, in the detail pane and, full width with the paste box
  focused, in the open view in place of the tabs and editors): heading "This import has no content",
  "oIDE can't download claude.ai artifacts, so the link came in without the design.", **Open on
  claude.ai** (only for claude.ai links), a labelled "Paste the artifact's code" text area, **Save**,
  **Choose downloaded file…**, a drop zone ("Replaces this empty import with the file."), and
  **Delete**. Save checks the paste like the import dialog (`importContentError`: not blank, not the
  old notice, a design is HTML or React, a whiteboard is JSON) and then takes one of two paths
  (`fixImportPlan`): content that fits the artifact's kind is saved in place with
  `artifacts.save({ id, content, note: 'Imported from claude.ai', baseVersion })` (main switches the
  entry to `App.jsx` for React and, since v2 is real content, `brokenImport` goes away); content of
  another kind (legacy link-only imports defaulted to Doc, so a pasted design is the common case)
  creates a new artifact with `artifacts.import({ content, url: importedFrom, title, projectId,
  location })` and deletes the empty one after it worked, with a line saying so. A chosen or dropped
  file always takes the second path with `filePath`. The new artifact is selected.
- **Compare**: From / To selects (every version, plus "Your unsaved changes" when dirty) over a
  read-only Monaco diff (`VersionDiff.tsx`, same theme as the Review split view) with a "+N −M
  lines" count. Whiteboard JSON is pretty-printed first so the diff is per property.

## Data flow

| What | IPC |
| --- | --- |
| Grid | `artifacts.list({})`, then `artifacts.uses({ ids })` (one call for all use lines); both reload on `artifacts.changed` |
| Detail | `artifacts.get({ id })` (meta, content, uses, versions), reloaded on `artifacts.changed` for that id |
| Design preview | `artifacts.previewUrl` → `oide-artifact://<id>/index.html` in `<iframe sandbox="allow-scripts">` (opaque origin, main serves it with a no-network CSP). React designs (`entry: App.jsx`) use the same URL: main serves a generated page that runs the bundled offline runtime, under the same no-network CSP. Without a URL (dev mock), and for past versions, **HTML** goes in through `srcdoc` with `sandbox=""` (no scripts). **React source never goes into `srcdoc`** (`looksLikeReact` on the content): the frame shows "Save to preview React changes. Use Compare to see older versions." (or, without a URL, "React designs preview in the desktop app.") |
| Doc preview | `marked` → DOMPurify (no `script`, `style`, `iframe`, `form`, `style=`); link clicks never navigate the window, https links go to `shell.openExternal` |
| Whiteboard preview | Read-only SVG render of the Excalidraw JSON (`Whiteboard.tsx`: rectangle, ellipse, diamond, line, arrow, freedraw, text) so the detail pane never loads Excalidraw. Colours are stored as Excalidraw stores them (light theme) and drawn through Excalidraw's dark-theme filter (`invert(93%) hue-rotate(180deg)`), so it matches the editor |
| Open | Editors per kind (above). Save → `artifacts.save({ id, content, note: 'Edited by you', baseVersion })`, a new numbered version. Whiteboards save `serializeAsJSON(elements, appState, files, 'local')`; selecting, zooming and panning are not edits (the first serialisation after loading is the baseline). Esc / Artifacts goes back, with a "Discard your changes?" confirm when dirty |
| Agent writes while open | `artifacts.changed` reloads `artifacts.get`. A newer version the viewer did not save itself: with no unsaved edits it is loaded (Excalidraw remounts with it) and a blue status bar says "Updated by <agent> agent · v5" with See changes (v4 → v5) and Dismiss; with unsaved edits the edits stay and an amber alert says "<Agent> saved v5 while you were editing" with Compare (theirs vs yours), **Keep mine** (saves yours as v6 on top, `baseVersion: 5`, note "Edited by you over v5"; v5 stays in History) and **Use theirs**. A save refused with `conflict` (the event not seen yet) opens the same banner. Decision logic: `liveDecision` in `model.ts` |
| Rename | Detail pane or the viewer's More menu → dialog (title selected, 1 to 200 characters, `aria-invalid` on error) → `artifacts.rename`. Only the title changes |
| Delete | Trash icon or More menu → "Delete <title>?" confirm (repo: "deletes its folder in .oide/artifacts/ and all N versions; copies you committed stay in git history"; personal: "can't be undone") → `artifacts.delete`, toast, next artifact selected. An `artifacts.changed` with `change: 'deleted'` for the open artifact closes it quietly |
| Give to an agent | `navigate('spawn', { projectId, context: [{ kind: 'artifact', id, title }] })`; Spawn pre-fills its context chips from `route.params.context` |
| Open in claude.ai | Only when `importedFrom` is an https link on claude.ai (`canOpenClaudeLink`); `shell.openExternal`. Hidden for claude.site imports: that host is not on the external-link allow-list, since anyone can publish there |
| Agents using it | Uses grouped per agent: "writes" if it ever wrote or created, else "reads"; status dot and title from the agents store; click → Focus |
| History | `versions` newest first: "v4 · edited by you · 11:20", "v3 · Window shell layout agent · added a focus view · 10:52". Click a past version → `artifacts.readVersion` → previewed with "Viewing v2 (current is v4)", **Restore** (saves it as a new version) and **Back to latest** |
| Import from claude.ai | Dialog with "Paste a link" or "Pick a file". **Nothing is imported without content**: oIDE can't download claude.ai artifacts (no public content API; it never uses the claude.ai sign-in), not even public ones, and main refuses a link alone. Paste a link: the link is checked with `classifyClaudeLink` (artifact, public artifact, claude.site and design links; a chat link or another page gets the classifier's reason inline, `role="alert"` and `aria-invalid` on the field), an **Open** button (`shell.openExternal`, accessible name "Open the link on claude.ai"; disabled for `claude.site` links, which are not on the external-link allow-list because anyone can publish there) and an "Artifact content" text area under the steps "1. Open the link. 2. On claude.ai, use Copy (or Download). 3. Paste the code here, or drop the downloaded file." → `artifacts.import({ url, content })`. **Import** is disabled until there is content (link tab) or a file (file tab); the reason sits beside it and is its `aria-describedby` ("Paste the artifact's code first. oIDE can't download claude.ai artifacts, even public ones."). Content is checked before sending (`importContentError`, memoised so a multi-MB paste is not re-scanned on each keystroke): the old placeholder text, plain text as a design (a design is `isDesignContent`: HTML or React), whiteboard JSON, over 10 MB. The kind follows the content (`inferKindFromContent`, React is a design) until the user picks one. **Fetch with an agent** (shown for a valid link): `trackFetchWithAgent()` (opt-in telemetry event, no props) then `navigate('spawn', { projectId, goal })`; the goal asks an agent to read the link with its claude.ai connectors (Claude Docs read, DesignSync for Claude Design), create it with `artifacts_create` only if it got the real content, and otherwise create nothing and say the code should be pasted. Copy under it: works for Claude Docs and Claude Design; chat artifacts can't be fetched, even public ones. Pick a file: `dialog.pickFile` (filter html, htm, jsx, tsx, svg, md, markdown, txt, excalidraw, json), then `artifacts.import({ filePath, url? })` with an optional link kept as the origin; main only accepts a path picked in this session. **Drag and drop**: one file dropped on the dialog or on the Artifacts grid goes through the preload drop bridge (`window.oide.attachDropped`, the one prompt inputs use; `drop.ts`): preload reads the real path, main registers it as picked and a non-image file comes back as `{ kind: 'file', path }`, which is what `artifacts.import({ filePath })` accepts. No new IPC. `.svg`, `.jsx` and `.tsx` are not images to main (it recognises only png, jpeg, gif and webp, by name and by content), so they come back as files. An image has no path, so it is refused with "Images can't be imported as artifacts. Drop an .html, .jsx, .svg, .md or .excalidraw file."; several files get "Drop one file at a time."; outside the desktop app (dev mock) "Choose a file" is the way. Title (from the content or file name when empty), kind, project, where it lives (Personal by default). Copy says it is a copy, not synced |
| Fix a broken import | `FixImportPanel` (see Layout): `artifacts.save` or, when the paste does not fit the artifact's kind or a file is chosen or dropped, `artifacts.import` then `artifacts.delete` of the empty one |
| New artifact | Title (required, `aria-invalid`), kind, project (or none), where it lives: "In the project's repo" (`.oide/artifacts/`, shared through git; needs a project) or "Personal" (app data) → `artifacts.create` |

The Project select is the shared project scope (`useScope`): choosing a project here also scopes the
Wall, Files and Source control, and a scope chosen there filters this grid. Selection lives in the
route (`artifacts.artifactId`, via `replace`).

## Protocol additions (this screen)

`artifacts.uses({ ids })`, `artifacts.readVersion({ id, version })`, `dialog.pickFile`, optional
`projectId` / `location` on `artifacts.import`, `context` on the Spawn route params,
`artifacts.rename({ id, title })`, `baseVersion` on `artifacts.save`, and `change` / `version` /
`author` on the `artifacts.changed` event.

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
- There is no "Import link only": it stored a placeholder as v1. The dialog needs the code or a file,
  offers **Fetch with an agent** instead, and the grid and detail pane flag imports that predate this
  rule (the badge and fix panel are additions).
- The meta line says "imported from claude.ai" instead of "synced from claude.ai": v1 has no sync.
  A line under the buttons says it is a copy, not synced.
- Open in claude.ai is hidden for artifacts that did not come from claude.ai.
- Grid thumbnails stay stylised as drawn; the detail pane shows the real content.
- The 190px doc preview fades its last line out (`.oide-md-fade`) instead of slicing it.

## Tests

`model.test.ts` (filters, use lines, reads/writes grouping, version labels, claude.ai host check and
`importLinkError`, `importContentError`, `fixImportPlan`, file kinds, Monaco language per entry, front
matter, whiteboard validation, `liveDecision`, author labels, diff text, rename titles),
`Artifacts.test.tsx` (kind / scope / search filtering, Give to an agent route with the context chip,
Open in claude.ai only for claude.ai imports, DOMPurify strips scripts from docs; the import dialog:
Import disabled without content with its reason, chat-link reason, old placeholder and plain-text
design refused, React accepted as a design, Fetch with an agent opens Spawn with the goal, a file
dropped on the dialog or on the grid imports by `filePath`, an image or several files refused; broken
imports: badge, fix panel paste saves with `artifacts.save`, kind mismatch and chosen file import
then delete, focus in the open view; React design: saved version by URL and a notice for a past
version, never `srcdoc`), `Editors.test.tsx`
(Monaco, Excalidraw and the diff editor stubbed: doc edit with live preview saved as v2 with
`baseVersion`, agent write loaded with "Updated by", conflict banner with Compare / Keep mine / Use
theirs, a `conflict` save error, whiteboard dirty tracking and reload, rename, delete with confirm,
compare from History), `excalidraw-env.test.ts` (asset path, CDN sources dropped). E2E
`apps/desktop/e2e/artifacts.spec.ts`: edit a doc in Monaco and see v2; draw on a whiteboard in the
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
- Dropping a file works only in the desktop app (the preload bridge reads the path); the dev mock
  has no `attachDropped`, so use Choose a file there.
- React designs preview only as the saved current version; an older version or unsaved edit shows a
  notice (use Compare). A pasted fix of a broken import that changes its kind creates a new artifact
  (new id), so agents that knew the old id must be pointed at the new one.
