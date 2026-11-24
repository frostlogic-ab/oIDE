import { LaunchError, type PermissionBroker } from '@oide/agent-core';
import { describe, expect, it, vi } from 'vitest';
import { Redactor } from '../reliability/redact.js';
import { guardedBroker } from './agents.js';

const handlers = { onPermissionRequest: () => {}, onPermissionResolved: () => {}, onReview: () => {} };

function fakeMcp(): PermissionBroker & { registerAgent: ReturnType<typeof vi.fn> } {
  return {
    registerAgent: vi.fn(async () => ({ mcpConfigPath: '/tmp/mcp.json', env: { OIDE_MCP_SECRET: 'agent-mcp-secret-abcdef' } })),
    unregisterAgent: vi.fn(async () => {}),
    answer: vi.fn(() => true),
  };
}

describe('guardedBroker (every launch: spawn, resume, relaunch)', () => {
  it('refuses to register an agent while the MCP server is down', async () => {
    const mcp = fakeMcp();
    let ready = false;
    const b = guardedBroker(mcp, { mcpReady: () => ready });
    await expect(b.registerAgent('a1', handlers)).rejects.toBeInstanceOf(LaunchError);
    expect(mcp.registerAgent).not.toHaveBeenCalled();
    ready = true;
    await expect(b.registerAgent('a1', handlers)).resolves.toMatchObject({ mcpConfigPath: '/tmp/mcp.json' });
  });

  it("registers the agent's MCP secret and secret env with the log redactor", async () => {
    const redactor = new Redactor({ home: '/home/me' });
    const b = guardedBroker(fakeMcp(), { redactor });
    await b.registerAgent('a1', handlers, {}, { secretEnv: { CUSTOM_SERVER_KEY: 'custom-env-secret-xyz' } });
    const line = redactor.string('env agent-mcp-secret-abcdef and custom-env-secret-xyz');
    expect(line).not.toMatch(/agent-mcp-secret-abcdef|custom-env-secret-xyz/);
  });
});
