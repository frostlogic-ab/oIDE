# Your first extension

This walks through a complete extension, **Word count**, that gives agents one read-only tool
(`count_words`: count the words, lines and characters of a text) and adds one command to the
command bar. It has no dependencies, so `dist/` is the source.

```
word-count/
  package.json
  dist/
    mcp.js      the MCP server (agent tool)
    host.js     host code (the command)
  README.md
```

## package.json

```json
{
  "name": "@you/oide-word-count",
  "version": "0.1.0",
  "description": "Lets agents count the words in a text.",
  "license": "MIT",
  "type": "module",
  "files": ["dist", "README.md"],
  "repository": { "type": "git", "url": "https://github.com/you/oide-word-count.git" },
  "oide": {
    "engine": "^1.0.0",
    "displayName": "Word count",
    "publisher": "you",
    "categories": ["agent-tools"],
    "activation": [],
    "main": "dist/host.js",
    "mcpServers": {
      "wordcount": {
        "command": "node",
        "args": ["dist/mcp.js"],
        "tools": {
          "count_words": { "risk": "read", "description": "Count the words, lines and characters of a text" }
        }
      }
    },
    "contributes": {
      "commands": [{ "id": "wordCount.hello", "title": "Word count: say hello" }],
      "settings": {
        "wordCount.greeting": { "type": "string", "default": "Hello", "description": "What the command says" }
      }
    },
    "capabilities": { "network": [], "spawn": false }
  }
}
```

- `engine` is a semver range of the extension API this works with (`API_VERSION` is `1.0.0`).
- The tool is labelled `read`: it changes nothing, so agents may call it without a prompt in
  projects where the extension is on. Anything that writes, deletes, spends money or reaches the
  network on the user's behalf should be `ask`.
- `dist/mcp.js` in `args` is relative to the package; oIDE resolves it to an absolute path inside
  the package and refuses paths that escape it.
- Contributing a command implies the activation event `onCommand:wordCount.hello`, so the host
  process starts the first time someone runs it. `activation` can stay empty.

## dist/mcp.js: the agent tool

An MCP server over stdio speaks newline-delimited JSON-RPC 2.0. This one has no dependencies (you
can also bundle `@modelcontextprotocol/sdk` into `dist/` with esbuild or similar).

```js
#!/usr/bin/env node
import { createInterface } from 'node:readline';

const TOOLS = [
  {
    name: 'count_words',
    description: 'Count the words, lines and characters of a text.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'The text to count' } },
      required: ['text'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
];

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');

function count(text) {
  return {
    words: text.split(/\s+/).filter(Boolean).length,
    lines: text === '' ? 0 : text.split(/\r?\n/).length,
    characters: [...text].length,
  };
}

function handle({ id, method, params }) {
  const reply = (result) => id !== undefined && send({ jsonrpc: '2.0', id, result });
  const fail = (code, message) => id !== undefined && send({ jsonrpc: '2.0', id, error: { code, message } });
  switch (method) {
    case 'initialize':
      return reply({
        protocolVersion: params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'oide-word-count', version: '0.1.0' },
      });
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS });
    case 'tools/call': {
      if (params?.name !== 'count_words') return fail(-32602, `Unknown tool: ${params?.name}`);
      const text = params.arguments?.text;
      if (typeof text !== 'string') return reply({ isError: true, content: [{ type: 'text', text: 'text is required' }] });
      const r = count(text);
      return reply({ content: [{ type: 'text', text: JSON.stringify(r) }], structuredContent: r });
    }
    default:
      if (typeof method === 'string' && method.startsWith('notifications/')) return;
      return fail(-32601, `Method not found: ${method}`);
  }
}

createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  }
  handle(msg);
});
```

Agents see the tool as `mcp__wordcount__count_words`. The CLI starts the server (not oIDE), looking
up `node` on the user's `PATH`, with the extension's folder as the working directory. Do not assume
the working directory is the agent's project: take paths from tool arguments and validate them.

## dist/host.js: the command

```js
/** @param {import('@oide/extension-api').ExtensionContext} ctx */
export function activate(ctx) {
  ctx.subscriptions.push(
    ctx.commands.register('wordCount.hello', async () => {
      const greeting = await ctx.settings.get('wordCount.greeting'); // the manifest default until set
      const agents = await ctx.agents.list();
      ctx.log.info(`${greeting}: ${agents.length} agent(s) in projects where Word count is on`);
      return { greeting, agents: agents.length };
    }),
  );
}

export function deactivate() {}
```

Host code is optional. Remove `main` and `contributes.commands` and the extension is a pure tool
provider.

## Try it

1. In oIDE, open **Marketplace > Add custom > Extension from folder or git**, choose the
   `word-count` folder and keep **Developer mode** on.
2. Review the tools and capabilities, pick the projects, and click **Install extension**. Because it
   comes from a folder it is "not reviewed": oIDE asks before it first runs anything, and its tool
   **asks first** whatever the manifest says (only marketplace installs keep their `read` labels).
3. Spawn an agent in one of those projects, with "Word count" ticked under Tools from extensions, and
   ask it to count the words in its README. Approve the prompt.
4. Press Ctrl/Cmd+K and run "Word count: say hello". Edit `dist/host.js`; developer mode restarts the
   host code. New agents pick up changes to the MCP server.

Next: [publish it](/extensions/publishing).
