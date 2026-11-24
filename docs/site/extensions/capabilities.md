# Capabilities and consent

## Declare what your code does

```json
"capabilities": { "network": ["localhost", "api.github.com"], "spawn": true, "fs": [] }
```

| Field | Declare |
| --- | --- |
| `network` | Every host your host code or MCP server talks to |
| `spawn` | `true` if you start other programs (`gh`, `git`, a language server) |
| `fs` | File system areas you read or write beyond the files passed to you |

## Not enforced

Capabilities are **shown for consent, not enforced**. Host code runs in its own process with full
Node access (files, network, child processes) as the user; your MCP server runs as a normal process
started by the CLI. (Electron's utility processes do not support Node's permission model today, so
there is no enforcing sandbox yet. A later version may add one.)

Declare honestly anyway: the install dialog, update consent and marketplace review depend on it, and
a mismatch between your manifest and the index entry fails validation.

## What users see and confirm

| Moment | What oIDE shows |
| --- | --- |
| Install from the marketplace | Every tool with its risk label, every declared capability, and a warning if the entry is not verified |
| Update | If the update adds tools, adds capabilities or turns an "asks first" tool read-only: the additions, and the user must consent again |
| Add from folder or git | The manifest's tools and capabilities, with a "not reviewed" badge, before anything runs |
| Add from git | A native confirmation naming the URL before cloning |
| First time a folder or git extension is turned on | A native confirmation listing exactly what will run (host code, MCP server and language server command lines) and the capabilities, marked "not enforced" |

## Trust rules that affect extensions

- A team can request extensions in `.oide/extensions.json` (name and version range). It is ignored in
  untrusted projects and never turns on folder or git extensions.
- A name installed from one source (marketplace, folder, git) cannot be replaced by the same name from
  another source; the user must uninstall first, which deletes that name's secrets.
- Custom MCP servers and folder or git extensions carry a "not reviewed" badge everywhere.
