# Artifacts

Local artifacts that oIDE stores, previews and hands to agents. v1 has no claude.ai sync (no public
API). Source: [../raw/build-brief.md](../raw/build-brief.md), "Artifacts integration"; decision
[ADR 0004](../../adr/0004-artifact-versions-as-numbered-snapshots.md). Related:
[storage.md](storage.md), [protocol.md](protocol.md); the MCP server and Artifacts screen pages once written.

## Store (`packages/store/src/artifacts.ts`)

### Layout on disk

```
<repo>/.oide/artifacts/<slug>/     location "repo": shared with the team through git
<app-data>/artifacts/<slug>/       location "app-data": personal
  artifact.json                    ArtifactMeta (id, slug, title, kind, projectId, location, version, entry, importedFrom?, times)
  index.html | App.jsx | doc.md | board.excalidraw      entry file (a design: index.html, or App.jsx for React)
  .versions/versions.json          ArtifactVersion[] (version, ts, author, note)
  .versions/<n>/<entry>            snapshot of version n
```

| Kind | Entry | New content |
| --- | --- | --- |
| design | `index.html` (HTML, SVG) or `App.jsx` (React, [ADR 0013](../../adr/0013-react-designs-with-a-bundled-offline-runtime.md)) | minimal HTML5 page with the title |
| doc | `doc.md` | Markdown with front matter (`title`, `kind`, `importedFrom`) added when missing |
| whiteboard | `board.excalidraw` | empty Excalidraw scene; saves must be a JSON object |

Slugs come from the title and are unique per location root. The folder is the source of truth;
SQLite (`artifacts`, `artifact_uses`) is an index plus the uses log. Versions are numbered snapshots
for both locations (ADR 0004); oIDE never commits artifacts.

### API

`new ArtifactStore({ db, appDataDir, projectPath: (projectId) => string | undefined, now?, onChange? })`

`onChange(id?, info?)` gets an `ArtifactChange` `{ change: 'created' | 'saved' | 'renamed' | 'deleted', version?, author? }`;
main forwards it as the `artifacts.changed` event (`{ id, change, version, author }`, plus `change: 'used'`
for MCP uses), so an open editor can say "Updated by <agent>" without a refetch.

- `create({ title, kind, projectId?, location='app-data', content? }, author='user')` → `ArtifactMeta` (version 1).
- `list({ projectId?, kind? })`, `read(id, agentId?)` → `{ meta, content }`, `get(id)` → `{ meta, content, uses, versions }` (the `artifacts.get` IPC shape).
- `save(id, content, { author, note, baseVersion? })` → next version; per-artifact lock so concurrent writes get distinct versions.
  With `baseVersion` (the version an editor started from) it throws `ArtifactError` code `conflict` when the
  artifact has moved on (an agent saved meanwhile); the IPC error code is `conflict`.
- `rename(id, title)`: trims and collapses whitespace, 1 to 200 characters (`ArtifactError` `invalid_input`);
  only `artifact.json` and the index change. The folder (slug), id and versions stay, so repo paths, git
  history and agents holding the id keep working. A rename is not a version.
- `delete(id)`: removes the folder (all versions), the index row and the uses log; `false` if unknown.
- `versions(id)` (newest first), `readVersion(id, n)`, `dirOf(id)` (for preview and path checks), `root(location, projectId?)`.
- `importUrl({ url, content, title?, kind?, projectId?, location? })`: **never creates an artifact without its
  content**. oIDE cannot fetch claude.ai content (no public API, and it never uses the user's claude.ai sign-in; even a
  public artifact's page is an empty shell that loads the design from a sandbox frame in the browser), so the user pastes
  what they copied there as `content` (10 MB limit). Everything is checked before anything is written; a refusal is an
  `ArtifactError` `invalid_input` with a `reason` (telemetry only):
  - the link (`claudeImportUrl` → `classifyClaudeLink`): https, no user name or password, claude.ai (or a subdomain) with
    `/artifact/<id>`, `/code/artifact/<id>`, `/public/artifacts/<id>` or `/design/…`, or claude.site `/artifacts/<id>`
    (id: 22 characters or a UUID, optional `<title>-` prefix). A chat link (`/chat/…`) or any other page is refused with a
    reason that says what to copy instead (`bad_link`).
  - content present and not blank (`no_content`, message `IMPORT_NEEDS_CONTENT`), at most 10 MB (`too_large`), not the
    placeholder older versions stored for link-only imports (`isImportStubContent`, `stub_content`), and fitting the kind
    (`wrong_kind`): a design is an HTML page or fragment, or React component source (`isDesignContent`); a whiteboard is
    Excalidraw JSON.
  - The kind follows the content unless given (`inferKindFromContent`: an HTML page or fragment → design, but Markdown
    that opens with an HTML banner stays a doc; React source → design; Excalidraw JSON → whiteboard; else doc), the title
    comes from `<title>`/`<h1>`, or a front-matter `title:` or the first `# heading` outside code fences, unless given
    (`titleFromContent`). The link is kept as `importedFrom` ("Open in claude.ai" uses it).
  The helpers live in `@oide/protocol` (`artifacts.ts`) so the dialog uses the same rules; they skip leading comments with
  `indexOf`, scan at most 256 KB with bounded patterns, so a 10 MB paste stays linear.
- `importFile({ filePath, url?, title?, kind?, ... })`: `.html/.htm/.svg/.jsx/.tsx` → design, `.md/.markdown/.txt` → doc,
  `.excalidraw` or Excalidraw `.json` → whiteboard; 10 MB limit. `url` (the claude.ai link the file was downloaded from)
  becomes `importedFrom`. Checked like pasted content (an empty file or the old placeholder is refused; a non-HTML,
  non-React file picked as a design is refused); an `.html` file is otherwise taken as a page.
- `brokenImport` (derived on `read`/`get`/`list`, never stored): an artifact with `importedFrom`, still at version 1,
  whose content is the old link-only placeholder. The Artifacts screen asks for the real content; the MCP
  `artifacts_read` answers `content: null`, `status: 'import-has-no-content'` so agents don't build from the notice.
  Saving real content (v2) clears it.
- React designs: `create` and `save` pick the design entry from the content (`designEntryFor`: `App.jsx` for React,
  else `index.html`); a save that changes the format writes the new entry and removes the old one, so the preview never
  serves a stale page. `readVersion` reads a version under either design entry. The entry is always one of the fixed
  names (`entryFileOf`), never a path from `artifact.json`. `metaOf(id)` gives the indexed meta without file access
  (the preview scheme).
- `rescan(projects)` re-indexes folders found on disk (repo artifacts teammates committed), assigns
  repo artifacts to the scanning project and drops index rows whose folder is gone. Run at startup.
- Uses: `recordUse(artifactId, agentId, op)`, `uses(id)`, `usesByAgent(agentId)` ("Agents using it",
  and a tile's "1 doc artifact").
- `backend()` → protocol `ArtifactsBackend` for the MCP server: `list(filter, agentId?)`,
  `read(id, agentId?)` (logs `read`), `write(id, content, agentId)` (new version, author
  `agent:<id>`, logs `write`), `create(input, agentId)` (app-data, logs `create`). `list` is not
  logged because it is not about one artifact.

`ArtifactSource { list, fetch, push }` is declared in the protocol for a future sync source; nothing
implements it in v1.

## IPC

`artifacts.list`, `get`, `create`, `save` (`baseVersion?`, refused with `conflict`), `rename` (Zod: trimmed,
1 to 200 characters), `delete`, `import`, `uses`, `readVersion`, `previewUrl`
(`apps/desktop/src/main/handlers/artifacts.ts`). `artifacts.import` needs pasted `content` (with `url`) or a `filePath`
picked with `dialog.pickFile` or dropped (Zod refine, then the store); a link alone is `invalid_input`. Refusals
carry their reason to the router's `observeFailure` (`artifact_import_refused`). Tests:
`packages/store/test/artifacts-editing.test.ts`, `packages/store/test/secrets-artifacts.test.ts`,
`test/integration/artifact-handlers.test.ts`.

## React design preview

[ADR 0013](../../adr/0013-react-designs-with-a-bundled-offline-runtime.md). `artifacts.previewUrl` is
`oide-artifact://<id>/index.html` for every design. For an `App.jsx` design main
(`services/artifact-preview.ts`, `resolveArtifactRequest`) answers with a generated page: the source as JSON in
`<script type="application/json" id="oide-src">` (`<`, U+2028, U+2029 escaped) and
`<script src="/__oide/react-runtime.js">`. The runtime (`apps/desktop/src/artifact-runtime/`, built by
`vite.runtime.config.ts` into `out/artifact-runtime/`, an extra resource in packaged builds) bundles React,
ReactDOM, Sucrase, lucide-react, recharts and Tailwind's browser build; it compiles the JSX/TSX, runs it through
an inline script (no eval), resolves imports only from those libraries, renders the default export, and shows a
readable message for an unsupported import or an error. The artifact CSP and sandbox are unchanged (no network).
Tests: `apps/desktop/src/artifact-runtime/compile.test.ts`, `apps/desktop/src/main/services/artifact-preview.test.ts`.

## MCP tools and UI

UI: [screen-artifacts.md](screen-artifacts.md) (editors per kind: Excalidraw for whiteboards, Monaco for
docs and designs; preview through `artifacts.previewUrl` in a sandboxed iframe; Give to an agent as a
Spawn context chip; history with view, restore and compare; rename and delete). MCP tool names:
[mcp-server.md](mcp-server.md).
