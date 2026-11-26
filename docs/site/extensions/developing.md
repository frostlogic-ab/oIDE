# Developing and testing

## Load your extension from a folder

1. **Marketplace > Add custom > Extension from folder or git > Choose a folder...** and pick your
   package folder (the one with `package.json`).
2. Keep **Developer mode: reload when its files change** on.
3. oIDE shows the manifest's tools (risk labels as declared), capabilities and a "not reviewed"
   badge. Choose projects and click **Install extension**.
4. The first time it is turned on, oIDE asks natively before running anything, listing the command
   lines it will run.

Manifest errors are reported right away with the field that failed (for example
`oide.activation: unknown event onLoad` or `path-escape`).

You can also install from a git URL (cloned with depth 1, no submodules; oIDE asks before cloning).
Git extensions are not watched.

## Developer mode

oIDE watches the folder you picked and, 300 ms after the last change:

- restarts your host code (it keeps the activation event that started it), and
- tells the agent supervisor your MCP servers changed. Running agents keep the server process the CLI
  already started; **new agents** get the new code.

Developer mode only works for folders you picked yourself, never for anything installed from the
marketplace.

## Remember while testing

- Tools of folder extensions **always ask first**, so you will see a prompt even for `read` tools.
  Their labels take effect once installed from the marketplace.
- The extension must be enabled for the agent's project and ticked in Spawn under Tools from
  extensions.
- The host process has a 15-second limit per command call, and restarts after crashes with backoff;
  after 5 crashes in 2 minutes it stays failed until you change a file (developer mode) or restart
  oIDE.

## Testing your MCP server without oIDE

Your server is a plain stdio MCP server, so any MCP client can test it, for example the
[MCP Inspector](https://github.com/modelcontextprotocol/inspector):

```sh
npx @modelcontextprotocol/inspector node dist/mcp.js
```

Or drive it by hand:

```sh
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | node dist/mcp.js
```

## Testing host code

Host code is a module with `activate(ctx)`; unit-test it with a fake `ctx` that records calls. The
built-in extensions test their manifests in `src/manifest.test.ts` with `loadManifest` from
`@oide/extension-host`; see
[extensions/browser-preview](https://github.com/frostlogic-ab/oIDE/tree/main/extensions/browser-preview).
