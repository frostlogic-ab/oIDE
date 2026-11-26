# MCP tools and risk labels

Agent tools are the main reason to write an extension. You ship an MCP server; oIDE tells each
agent's CLI about it; the agent calls your tools like any other tool.

## How your server reaches an agent

When an agent starts in a project where your extension is enabled (and the user ticked it in Spawn
under **Tools from extensions**), oIDE:

1. adds your servers to the agent's generated `mcp.json`, passed to the CLI as `--mcp-config`:
   ```json
   { "mcpServers": { "postgres": { "type": "stdio", "command": "node", "args": ["/.../dist/mcp.js"], "cwd": "/.../@you/postgres-inspector@1.2.0" } } }
   ```
2. adds your `read` tools to `--allowedTools`, and tools the user turned off to `--disallowedTools`.

The **CLI** starts and stops your server process, not oIDE. Each agent gets its own server process.
Changes to your server affect agents started afterwards.

## Tool names

Agents see your tools as `mcp__<server>__<tool>`. Characters outside `[A-Za-z0-9_-]` become `_`, as
the CLI does it: `db.schema` on server `postgres` is `mcp__postgres__db_schema`. Permission rules,
the Marketplace's per-tool switches and `--allowedTools` all use that name.

List **every** tool your server offers in the manifest. For marketplace entries, the validator checks
that the index lists exactly the manifest's tools with the same labels.

## Risk labels

| Label | Meaning | Prompt |
| --- | --- | --- |
| `read` | Reads only. No writes, no side effects, nothing sent on the user's behalf. | Pre-allowed: no prompt, in projects where the extension is enabled |
| `ask` | Anything else | Always a permission prompt on the agent's tile |

The label is **your claim**, and users rely on it. Rules oIDE applies:

- Labels are trusted only for marketplace installs, where the installer checks them against the
  reviewed index. Tools of extensions loaded from a folder or git URL **always ask first**, whatever
  the manifest says.
- An update that turns an `ask` tool into a `read` tool, or adds tools, needs the user's consent again.
- Users can turn any tool off per extension (Marketplace detail > Tools it gives agents).
- Untrusted projects do not apply `.oide/extensions.json`, so a cloned repository cannot turn your
  tools on by itself.

Also set MCP tool annotations (`readOnlyHint`, `destructiveHint`, `openWorldHint`) honestly: when
someone adds your server through **Add custom** instead of as an extension, oIDE derives the
suggested label from them (`readOnlyHint` means read; `destructiveHint` or no hint means ask).

## Writing good tools

- Validate every argument. Agents can be steered by untrusted content (a README, a web page), so
  treat tool input as untrusted.
- Do not assume the working directory is the agent's project; take paths as arguments and check
  them.
- Return errors as `{ isError: true, content: [...] }` results rather than crashing the server.
- Keep `read` tools truly read-only. If a tool can write, split it into a `read` and an `ask` tool.
- Secrets: read them in host code with `ctx.settings.get` (secret settings) or ask the user to
  configure your server through environment variables; never print them in tool results.

## Built-in example

[Browser preview](https://github.com/frostlogic-ab/oIDE/tree/main/extensions/browser-preview) ships a
dependency-free stdio server with one read-only tool, `preview_url`, that fetches a localhost URL and
reports its status, content type and page title (other hosts are refused).
