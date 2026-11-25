import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeRepo, tempDir, waitFor } from '../integration/harness.js';
import { driveTo, gateHarness, single, track, useGateCleanup } from './helpers.js';
import { localMarketplace, TEXTKIT, useLocalMarketplace } from './marketplace.js';

/**
 * M5 gate: "A third-party extension installed from the index gives an agent a tool it uses."
 *
 * A local marketplace index lists `@acme/oide-textkit` with the tarball's real integrity. The real
 * MarketplaceInstaller downloads, verifies and unpacks it; the user turns it on for one project; an
 * agent spawned there gets the extension's stdio MCP server in `--mcp-config` and the tool in
 * `--allowedTools` (risk `read`). fake-claude's `mcp-tool` scenario starts that server from the
 * config, loads `mcp__textkit__text_reverse` with ToolSearch and calls it; the result reaches the
 * transcript.
 */

useGateCleanup();

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

interface Launch {
  argv: string[];
  pid: number;
  cwd: string;
}

function launches(record: string): Launch[] {
  if (!existsSync(record)) return [];
  return readFileSync(record, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as Partial<Launch>)
    .filter((l): l is Launch => Array.isArray(l.argv));
}
const flagValue = (argv: string[], flag: string) => argv[argv.indexOf(flag) + 1];

describe('M5 gate: marketplace extension → agent tool', { timeout: 60_000 }, () => {
  it('installs from the index (integrity checked), enables per project, and the agent calls the tool', async () => {
    const market = localMarketplace();
    const recDir = tempDir('oide-gate-rec-');
    track(recDir);
    const record = join(recDir, 'launch.jsonl');
    const h = await gateHarness({ platform: { fetch: market.fetch } });
    useLocalMarketplace(h);
    await h.call('settings.update', {
      patch: { claude: { extraFlags: `--fake-scenario mcp-tool --fake-record ${JSON.stringify(record)}` } },
    });

    // The Marketplace lists it from the index.
    const index = await h.call('extensions.index', { refresh: true });
    expect(index.map((e) => e.name)).toContain(TEXTKIT.name);

    const installed = await h.call('extensions.install', { name: TEXTKIT.name });
    expect(market.requests).toContain(TEXTKIT.tarballUrl);
    expect(installed).toMatchObject({
      name: TEXTKIT.name,
      version: '1.0.0',
      source: 'marketplace',
      enabledGlobally: false,
    });
    expect(existsSync(join(h.userData, 'extensions', 'acme__oide-textkit@1.0.0', 'dist', 'server.mjs'))).toBe(
      true,
    );

    const repoA = makeRepo();
    const repoB = makeRepo();
    track(repoA, repoB);
    const a = (await h.call('projects.open', { path: repoA }))!;
    const b = (await h.call('projects.open', { path: repoB }))!;
    const on = await h.call('extensions.setEnabled', { id: installed.id, projectId: a.id, enabled: true });
    expect(on.enabledProjects).toEqual([a.id]);

    const goal = `Reverse a string with the textkit tool. [fake-tool:${TEXTKIT.cliTool}] [fake-args:{"text":"oIDE gate"}]`;
    const [spawned] = await h.call('agents.spawn', {
      projectId: a.id,
      title: 'Uses textkit',
      goal,
      mode: 'default',
      strategy: single,
    });
    const { agent, prompts } = await driveTo(h, spawned!.id, 'has-question');
    // `read` risk from a marketplace extension: pre-allowed, no permission prompt.
    expect(prompts).toEqual([]);

    // Launch: the extension's server in --mcp-config, its tool in --allowedTools.
    const [launch] = launches(record);
    expect(flagValue(launch!.argv, '--allowedTools')!.split(',')).toContain(TEXTKIT.cliTool);
    const mcp = JSON.parse(readFileSync(flagValue(launch!.argv, '--mcp-config')!, 'utf8')) as {
      mcpServers: Record<string, { type?: string; command?: string; args?: string[] }>;
    };
    expect(mcp.mcpServers[TEXTKIT.server]).toMatchObject({ type: 'stdio', command: 'node' });
    expect(mcp.mcpServers[TEXTKIT.server]!.args![0]).toBe(
      join(h.userData, 'extensions', 'acme__oide-textkit@1.0.0', 'dist', 'server.mjs'),
    );

    // Transcript: ToolSearch, the tool call, its result from the extension's own process, the reply.
    const events = await h.call('agents.events', { agentId: agent.id, limit: 500 });
    const use = events.find((e) => e.type === 'tool-use' && e.name === TEXTKIT.cliTool);
    expect(use).toMatchObject({ input: { text: 'oIDE gate' } });
    expect(
      events.some(
        (e) =>
          e.type === 'tool-use' &&
          e.name === 'ToolSearch' &&
          JSON.stringify(e.input).includes(`select:${TEXTKIT.cliTool}`),
      ),
    ).toBe(true);
    const res = events.find(
      (e) => e.type === 'tool-result' && use?.type === 'tool-use' && e.toolUseId === use.toolUseId,
    );
    expect(res).toMatchObject({ isError: false });
    const m = /^textkit pid (\d+): etag EDIo$/.exec(res?.type === 'tool-result' ? res.content : '');
    expect(m).not.toBeNull();
    const serverPid = Number(m![1]);
    expect(serverPid).not.toBe(launch!.pid);
    expect(events.some((e) => e.type === 'assistant-text' && e.text.includes('etag EDIo'))).toBe(true);

    // The server lives with the agent's CLI process and ends with it.
    expect(alive(serverPid)).toBe(true);
    await h.call('agents.stop', { agentId: agent.id });
    await waitFor(() => !alive(serverPid) && !alive(launch!.pid), 'CLI and MCP server exited', 15_000);

    // Not enabled in project B: no server, no tool.
    const [other] = await h.call('agents.spawn', {
      projectId: b.id,
      title: 'No textkit',
      goal: 'Reverse a string. [fake-scenario:mcp-tool]',
      mode: 'default',
      strategy: single,
    });
    const done = await driveTo(h, other!.id, 'has-question');
    const evB = await h.call('agents.events', { agentId: done.agent.id, limit: 200 });
    expect(evB.some((e) => e.type === 'assistant-text' && e.text === 'No MCP tool is available.')).toBe(true);
    const launchB = launches(record).at(-1)!;
    expect(
      JSON.parse(readFileSync(flagValue(launchB.argv, '--mcp-config')!, 'utf8')).mcpServers[TEXTKIT.server],
    ).toBeUndefined();
    expect(flagValue(launchB.argv, '--allowedTools')).not.toContain(TEXTKIT.cliTool);
  });

  it('refuses a tarball whose bytes do not match the index integrity', async () => {
    const market = localMarketplace({ tamper: true });
    const h = await gateHarness({ platform: { fetch: market.fetch } });
    useLocalMarketplace(h);
    expect(await h.fails('extensions.install', { name: TEXTKIT.name })).toBe('install_failed');
    expect(existsSync(join(h.userData, 'extensions', 'acme__oide-textkit@1.0.0'))).toBe(false);
    expect(await h.call('extensions.installed', undefined)).not.toContainEqual(
      expect.objectContaining({ name: TEXTKIT.name }),
    );
  });
});
