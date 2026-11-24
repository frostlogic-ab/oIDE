// A tiny stdio MCP server used by probeCommand tests.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { addTools } from './mcp-tools.mjs';

if (process.env.FIXTURE_REQUIRE && !process.env[process.env.FIXTURE_REQUIRE]) {
  console.error(`missing ${process.env.FIXTURE_REQUIRE}`);
  process.exit(3);
}
const server = new McpServer({ name: 'Fixture stdio', version: '0.4.1' });
addTools(server);
await server.connect(new StdioServerTransport());
