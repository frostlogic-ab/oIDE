// A third-party extension's MCP server for the M5 gate test: stdio, newline-delimited JSON-RPC,
// no dependencies (marketplace installs never run npm install). One tool, `text.reverse`.
import { createInterface } from 'node:readline';

const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const TOOLS = [
  {
    name: 'text.reverse',
    description: 'Reverse a string',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    annotations: { readOnlyHint: true },
  },
];

createInterface({ input: process.stdin }).on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id === undefined) return; // notifications
  switch (msg.method) {
    case 'initialize':
      return send({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion: msg.params?.protocolVersion ?? '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'textkit', version: '1.0.0' },
        },
      });
    case 'tools/list':
      return send({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } });
    case 'tools/call': {
      if (msg.params?.name !== 'text.reverse')
        return send({
          jsonrpc: '2.0',
          id: msg.id,
          result: { isError: true, content: [{ type: 'text', text: `Unknown tool ${msg.params?.name}` }] },
        });
      const text = String(msg.params?.arguments?.text ?? '');
      return send({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          content: [{ type: 'text', text: `textkit pid ${process.pid}: ${[...text].reverse().join('')}` }],
        },
      });
    }
    default:
      return send({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32601, message: `Method not found: ${msg.method}` },
      });
  }
});
