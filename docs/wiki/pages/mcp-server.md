# oIDE MCP server (`packages/mcp-server`)

oIDE's own MCP server, through which each agent's CLI asks for permission, submits work for review and
uses artifacts. It runs in the main process. The tool contract with the CLI was verified on 2.1.325
(see [cli-integration](cli-integration.md)); the supervisor side is in [agent-supervisor](agent-supervisor.md).
Artifacts storage: [artifacts](artifacts.md).

## Transport and security

- `@modelcontextprotocol/sdk` low-level `Server` over Streamable HTTP (stateless, JSON responses), bound to
  `127.0.0.1` on a random port (`start()`).
- One endpoint per agent: `http://127.0.0.1:<port>/mcp/<agentId>`, with a 32-byte random secret in the
  `X-Oide-Secret` header. `registerAgent` writes `<app-data>/agents/<id>/mcp.json` (mode 0600):

```json
{ "mcpServers": {
    "github": { "...": "extension / custom entries passed in" },
    "oide": { "type": "http", "url": "http://127.0.0.1:53121/mcp/agt-…", "headers": { "X-Oide-Secret": "…" } } } }
```

- Requests are refused with 401 (missing or wrong secret, constant-time compare), 403 (`Host` not
  `127.0.0.1:<port>` / `localhost:<port>`, or any `Origin` other than our own), 404 (unknown agent), 413
  (body over 16 MB; the SDK transport gets the same `maxRequestBodySize`, its own default is 4 MB), 503
  (shutting down). The CLI sends no `Origin`.
- Extra servers named `oide` (or with invalid names) are dropped so nothing can replace oIDE's entry.

## Tools

| Tool | Behaviour |
| --- | --- |
| `permission_prompt` | Input `{tool_name, input, tool_use_id?}` (+ `_meta["claudecode/toolUseId"]`). Creates a `PermissionRequest` (`perm-<uuid>`, summary like "Run npm test", `suggestedRule` like `Bash(npm test)`), calls `onPermissionRequest`, and **blocks** until `answer(requestId, …)` for that exact id. Returns text `{"behavior":"allow","updatedInput":…}` or `{"behavior":"deny","message":…}`. Optional `permissionTimeoutMs`; otherwise it waits for the user. `close()` and `unregisterAgent()` deny every pending prompt. |
| `submit_for_review` | `{summary, checks[{name, status, detail?}]}`; status words are normalized (`pass`/`ok` → `passed`, `fail`/`error` → `failed`, unknown → `warning`). Calls `onReview`. |
| `set_title` | `{title}`. The agent names its task. Calls `onTitle(title)` (optional handler) and returns its `{ok, title}` or `{ok:false, message}` (an MCP error result, never thrown). Without a handler it is refused. Auto-allowed (`--allowedTools`), summary "Set title". |
| `artifacts_list` / `artifacts_read` / `artifacts_write` / `artifacts_create` | Only listed when an `ArtifactsBackend` is passed. Every call is logged through `onArtifactUse({artifactId, agentId, op, ts})` (`list` uses artifactId `*`). Artifacts are also MCP resources `oide://artifacts/<id>`. `artifacts_list` items carry `importedFrom` and `brokenImport` when set. A design written or created may be HTML or React source ([ADR 0013](../../adr/0013-react-designs-with-a-bundled-offline-runtime.md)). Multi-file artifacts ([ADR 0014](../../adr/0014-multi-file-artifacts-retrieved-by-agents.md)) below. |
| `artifacts_read` | `{id, path?}`. Returns `{meta, content}` (the entry file's text); when `meta.fileCount > 1` also `files: ArtifactFile[]` (`{path, size, text}`). `path` reads one file: `{id, path, encoding, content}` for text or `{…, base64}` for binary, refused above 4 MB. Version 0 (a linked artifact with no files yet) returns `content: null` with `status: 'retrieving'` or `'retrieval-failed'` and a message (`noFilesYetMessage`, which quotes the failure reason). A `brokenImport` (an old link-only import) returns `content: null`, `status: 'import-has-no-content'` and `brokenImportMessage`: don't build from it; tell the user to press Update in oIDE (an agent then retrieves it) or drop the downloaded files. |
| `artifacts_write` | `{id, content?, files?, deletes?, entry?, note?}`, at least one of them. `content` alone is a new version of the entry file (as before); with `files` / `deletes` / `entry` it is one `writeFiles` version (`content` then replaces the entry, or the new `entry`). Each file is an `AgentArtifactFileInput`: `{path, content}` (UTF-8), `{path, base64}` or `{path, fromFile}` (exactly one), `path` an `ArtifactPath`. Returns `{ok, id, version, entry, files}`. |
| `artifacts_create` | `{title, kind, content?, files?, entry?, shared?}`, content or files. With `files` (and `entry`, else the default entry for the kind) the first version holds them all. |
| `artifact_retrieval_add_files` | `{id, files}` (1 to 500 `AgentArtifactFileInput`). Listed only when `backend.isRetrievalAgent(agentId)`; main (`ArtifactRetrievalService.addFiles`) refuses any agent but the artifact's `retrieval.agentId` while `status` is `retrieving`. Stages the files (a path given again replaces it); returns `{ok, staged, files, bytes}` (totals so far). |
| `artifact_retrieval_finish` | `{id, ok, reason?, entry?, title?, kind?}`. Same caller check. `ok: true` commits the staged files as one new version (`{ok, status: 'ready', version, entry}`), or reports why oIDE could not use them (`isError`, status `failed`); `ok: false` records `reason` (`{status: 'failed', error}`). Either way the agent is told to end its turn. |

## API

```ts
const mcp = new OideMcpServer({ appDataDir, artifacts?, onArtifactUse?, permissionTimeoutMs?, port?, log? });
await mcp.start();                                   // { port }
await mcp.registerAgent(agentId, { onPermissionRequest, onPermissionResolved, onReview, onTitle? }, extraServers?, { projectId? });
                                                     // → { agentId, url, secret, mcpConfigPath }
mcp.answer(requestId, permissionAnswer)              // false unless requestId is exactly pending (and matches answer.requestId)
mcp.pendingRequests(agentId?)
await mcp.unregisterAgent(agentId)
await mcp.close()                                    // deny pending, stop listening (call on app quit)
```

`ArtifactsBackend { list(ctx, {kind?, query?}); read(ctx, id) → {meta, content}; write(ctx, id, content, note?); create(ctx, {title, kind, content?, location?, files?, entry?}); files?(ctx, id); readFile?(ctx, id, path); writeFiles?(ctx, id, {content?, files?, deletes?, entry?, note?}); isRetrievalAgent?(agentId); retrievalAddFiles?(ctx, id, files); retrievalFinish?(ctx, id, {ok, reason?, entry?, title?, kind?}) }`
with `ctx = { agentId, projectId? }`. Main implements it (`mcpArtifacts` in `apps/desktop/src/main/services/core.ts`) over the
artifacts store: SEC-26 visibility, `fromFile` resolved against the calling agent's own worktree (never in the store),
and the retrieval tools routed to `ArtifactRetrievalService` ([artifacts](artifacts.md)).

`OideMcpServer` is the supervisor's `PermissionBroker` (structural match; this package does not depend on agent-core).
