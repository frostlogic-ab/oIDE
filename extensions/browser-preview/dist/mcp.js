#!/usr/bin/env node
// oIDE Browser preview: a dependency-free stdio MCP server with one read-only tool.
// Speaks newline-delimited JSON-RPC 2.0 (the MCP stdio transport).
import { createInterface } from 'node:readline';
import { previewUrl } from './preview.js';

const VERSION = '1.0.0';
const KNOWN_PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const TOOLS = [
  {
    name: 'preview_url',
    title: 'Preview a local URL',
    description:
      'Fetch a localhost URL (for example the dev server) and report its HTTP status, content type and page title. Only localhost, 127.0.0.1 and [::1] are allowed.',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'A URL such as http://localhost:3000/' } },
      required: ['url'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
];

/** @param {unknown} msg */
function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

/** @param {any} req */
async function handle(req) {
  const { id, method, params } = req ?? {};
  /** @param {unknown} result */
  const reply = (result) => {
    if (id !== undefined) send({ jsonrpc: '2.0', id, result });
  };
  /** @param {number} code @param {string} message */
  const fail = (code, message) => {
    if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code, message } });
  };
  switch (method) {
    case 'initialize': {
      const asked = params?.protocolVersion;
      return reply({
        protocolVersion: KNOWN_PROTOCOLS.includes(asked) ? asked : KNOWN_PROTOCOLS[0],
        capabilities: { tools: {} },
        serverInfo: { name: 'oide-browser-preview', title: 'Browser preview', version: VERSION },
      });
    }
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS });
    case 'tools/call': {
      if (params?.name !== 'preview_url') return fail(-32602, `Unknown tool: ${params?.name}`);
      const url = params?.arguments?.url;
      if (typeof url !== 'string') return reply({ isError: true, content: [{ type: 'text', text: 'url is required' }] });
      try {
        const r = await previewUrl(url);
        return reply({ content: [{ type: 'text', text: JSON.stringify(r) }], structuredContent: r });
      } catch (e) {
        return reply({ isError: true, content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }] });
      }
    }
    default:
      if (typeof method === 'string' && method.startsWith('notifications/')) return;
      return fail(-32601, `Method not found: ${method}`);
  }
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  if (Array.isArray(msg)) for (const m of msg) void handle(m);
  else void handle(msg);
});
// When stdin closes nothing keeps the event loop alive, so the process ends on its own.
// (Calling process.exit here trips a libuv assertion on Windows while the pipe is closing.)
