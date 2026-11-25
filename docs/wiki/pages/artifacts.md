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
  index.html | doc.md | board.excalidraw      entry file by kind
  .versions/versions.json          ArtifactVersion[] (version, ts, author, note)
  .versions/<n>/<entry>            snapshot of version n
```

| Kind | Entry | New content |
| --- | --- | --- |
| design | `index.html` | minimal HTML5 page with the title |
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
- `importUrl({ url, content?, title?, kind?, projectId?, location? })`: only `https://claude.ai` (and `claude.site`) links,
  no user name or password in them (`claudeImportUrl`, `ArtifactError` `invalid_input`). oIDE cannot fetch claude.ai
  content (no public API, and it never uses the user's claude.ai sign-in), so the user pastes what they copied there as
  `content` (10 MB limit). With content: the kind follows it unless given (`inferKindFromContent`: HTML → design,
  Excalidraw JSON → whiteboard, else doc), the title comes from `<title>`/`<h1>` or a `# heading` unless given
  (`titleFromContent`), and a design must hold HTML (`looksLikeHtml`; React or other code artifacts are refused with
  `invalid_input` because the preview has no network to load them). Without content (or only whitespace): a link-only
  stub (kind defaults to doc) whose note says how to paste the content. The link is kept as `importedFrom` either way;
  "Open in claude.ai" uses it. The three helpers live in `@oide/protocol` (`artifacts.ts`) so the dialog uses the same rules.
- `importFile({ filePath, url?, title?, kind?, ... })`: `.html/.htm` → design, `.md/.markdown/.txt` → doc, `.excalidraw` or
  Excalidraw `.json` → whiteboard; 10 MB limit. `url` (the claude.ai link the file was downloaded from) becomes
  `importedFrom`. A non-HTML file picked as a design is refused like pasted content; an `.html` file is taken as a page.
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
(`apps/desktop/src/main/handlers/artifacts.ts`). Tests: `packages/store/test/artifacts-editing.test.ts`,
`test/integration/artifact-handlers.test.ts`.

## MCP tools and UI

UI: [screen-artifacts.md](screen-artifacts.md) (editors per kind: Excalidraw for whiteboards, Monaco for
docs and designs; preview through `artifacts.previewUrl` in a sandboxed iframe; Give to an agent as a
Spawn context chip; history with view, restore and compare; rename and delete). MCP tool names:
[mcp-server.md](mcp-server.md).
