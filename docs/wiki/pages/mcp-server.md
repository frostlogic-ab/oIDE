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
  (body over 8 MB), 503 (shutting down). The CLI sends no `Origin`.
- Extra servers named `oide` (or with invalid names) are dropped so nothing can replace oIDE's entry.

## Tools

| Tool | Behaviour |
| --- | --- |
| `permission_prompt` | Input `{tool_name, input, tool_use_id?}` (+ `_meta["claudecode/toolUseId"]`). Creates a `PermissionRequest` (`perm-<uuid>`, summary like "Run npm test", `suggestedRule` like `Bash(npm test)`), calls `onPermissionRequest`, and **blocks** until `answer(requestId, …)` for that exact id. Returns text `{"behavior":"allow","updatedInput":…}` or `{"behavior":"deny","message":…}`. Optional `permissionTimeoutMs`; otherwise it waits for the user. `close()` and `unregisterAgent()` deny every pending prompt. |
| `submit_for_review` | `{summary, checks[{name, status, detail?}]}`; status words are normalized (`pass`/`ok` → `passed`, `fail`/`error` → `failed`, unknown → `warning`). Calls `onReview`. |
| `artifacts_list` / `artifacts_read` / `artifacts_write` / `artifacts_create` | Only listed when an `ArtifactsBackend` is passed. Every call is logged through `onArtifactUse({artifactId, agentId, op, ts})` (`list` uses artifactId `*`). Artifacts are also MCP resources `oide://artifacts/<id>`. `artifacts_list` items carry `importedFrom` and `brokenImport` when set. `artifacts_read` of a `brokenImport` (a claude.ai link-only import from an older oIDE) returns `content: null`, `status: 'import-has-no-content'` and a message (`brokenImportMessage`): don't build from it, ask the user to paste the code or drop the file in oIDE, or read a Claude Docs / Claude Design link with the claude.ai connectors and `artifacts_write` it. A design written or created may be HTML or React source ([ADR 0013](../../adr/0013-react-designs-with-a-bundled-offline-runtime.md)). |

## API

```ts
const mcp = new OideMcpServer({ appDataDir, artifacts?, onArtifactUse?, permissionTimeoutMs?, port?, log? });
await mcp.start();                                   // { port }
await mcp.registerAgent(agentId, { onPermissionRequest, onPermissionResolved, onReview }, extraServers?, { projectId? });
                                                     // → { agentId, url, secret, mcpConfigPath }
mcp.answer(requestId, permissionAnswer)              // false unless requestId is exactly pending (and matches answer.requestId)
mcp.pendingRequests(agentId?)
await mcp.unregisterAgent(agentId)
await mcp.close()                                    // deny pending, stop listening (call on app quit)
```

`ArtifactsBackend { list(ctx, {kind?, query?}); read(ctx, id) → {meta, content}; write(ctx, id, content, note?); create(ctx, {title, kind, content, location?}) }`
with `ctx = { agentId, projectId? }` is implemented by the artifacts store.

`OideMcpServer` is the supervisor's `PermissionBroker` (structural match; this package does not depend on agent-core).
