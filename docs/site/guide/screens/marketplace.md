# Marketplace

Extensions and custom MCP tools that give agents new abilities.

## Browse

Categories: Agent tools, Review & testing, Deploy targets, Artifact types, Views & panels, Themes,
Languages. **Yours**: Installed, Custom and Updates. Sort by most installed, recently updated or
name.

The list comes from a public static index (the
[oide-marketplace](https://github.com/oide-dev/oide-marketplace) repository), refreshed daily, with a
copy shipped inside oIDE for offline use.

## Detail

Name, publisher, a **not reviewed** badge where it applies, description, **Install** (or Uninstall,
Remove, Built in), **Tools it gives agents** with their risk label, **Enabled for** (all projects or
some), and **Declared capabilities**.

| Risk label | Meaning |
| --- | --- |
| read only | Pre-allowed for agents in projects where the extension is on |
| asks first | Always shows a permission prompt on the agent's tile |

## Install and update

Installing shows a consent dialog with every tool, its risk label and the declared capabilities.
oIDE downloads the npm tarball, checks its integrity hash against the index before unpacking, and
never runs install scripts. An update that adds tools or capabilities asks for consent again.

## Add custom

Bring any MCP server or extension that is not in the marketplace. Custom tools are not reviewed;
only add ones you trust.

| Route | What you do |
| --- | --- |
| From a URL | Paste an MCP server URL. oIDE connects, lists its tools and, if the server needs it, signs you in through your browser (OAuth) or takes a header token. |
| Found on this computer | oIDE reads, read-only, the MCP servers configured in other apps (Claude Desktop, Claude Code's user settings and each project's `.mcp.json`, VS Code, Cursor, Windsurf) and copies only the ones you pick. Nothing in those apps changes. |
| Local command or JSON | A command line such as `npx ...` with env variables, or pasted `mcpServers` JSON. **Test it** starts the server once to list its tools (after you confirm the exact command). |
| Extension from folder or git | Load an extension you are developing, optionally with developer mode (reload on change). See [Developing extensions](/extensions/developing). |

Risk labels come from the server's tool hints (read-only hint means read only; anything else asks
first); click a label to change it. Save the server to **My settings** (all your projects) or to the
**project's `.mcp.json`** (shared through git, with secrets left as `${VAR}` placeholders).

Details: [screen-marketplace](https://github.com/oide-dev/oide/blob/main/docs/wiki/pages/screen-marketplace.md)
and [marketplace](https://github.com/oide-dev/oide/blob/main/docs/wiki/pages/marketplace.md).
