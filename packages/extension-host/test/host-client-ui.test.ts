import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ExtensionHostClient, nodeFork, type HostExtension, type HostServices } from '../src/host-client.js';
import { loadManifest } from '../src/manifest.js';

/** Panels, deploy targets and lazy activation of the UI sample fixture (one of every UI contribution). */
const here = path.dirname(fileURLToPath(import.meta.url));
const loaded = loadManifest(path.join(here, 'fixtures', 'ui-builtins', 'ext-ui'));
const ext: HostExtension = {
  name: loaded.manifest.name,
  version: loaded.manifest.version,
  dir: loaded.dir,
  main: loaded.main as string,
  activation: loaded.activation,
  panelIds: loaded.panels.map((p) => p.id),
  commandIds: loaded.manifest.oide.contributes.commands.map((c) => c.id),
  deployTargetIds: loaded.manifest.oide.contributes.deployTargets.map((d) => d.id),
};

function services() {
  const panelOut: Array<{ panelId: string; data: unknown }> = [];
  const opened: string[] = [];
  const s: HostServices = {
    settingsGet: (_e, key) =>
      key === 'uiSample.token' ? 'secret' : key === 'uiSample.limit' ? 7 : undefined,
    settingsSet: () => undefined,
    listAgents: () => [],
    postMessage: () => undefined,
    openPanel: (_e, id, o) => void opened.push(`${id} ${o.agentId ?? ''}`.trim()),
    postPanelMessage: (_e, panelId, data) => void panelOut.push({ panelId, data }),
    readArtifact: (_e, id) => ({ id, title: 'x', kind: 'doc', content: '' }),
    canSeeProject: () => true,
    log: () => undefined,
  };
  return { s, panelOut, opened };
}

let clients: ExtensionHostClient[] = [];
afterEach(async () => {
  await Promise.all(clients.map((c) => c.dispose()));
  clients = [];
});

function client(s: HostServices) {
  const c = new ExtensionHostClient({ fork: nodeFork(), services: s, timeoutMs: 10_000 });
  c.setExtensions([ext]);
  clients.push(c);
  return c;
}

const waitFor = async (cond: () => boolean, ms = 8000) => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe('ExtensionHostClient: UI contributions', () => {
  it('a panel message starts stopped host code (onPanel) and the reply comes back through postPanelMessage', async () => {
    const { s, panelOut } = services();
    const c = client(s);
    expect(c.state(ext.name)).toBe('stopped');
    expect(await c.sendPanelMessage(ext.name, 'uiSample.board', { type: 'ping', n: 3 })).toBe(true);
    expect(c.state(ext.name)).toBe('running');
    await waitFor(() => panelOut.length > 0);
    expect(panelOut[0]).toEqual({
      panelId: 'uiSample.board',
      data: { type: 'pong', n: 3, token: 'set', limit: 7 },
    });
  });

  it('refuses panel ids the manifest does not declare', async () => {
    const { s } = services();
    const c = client(s);
    expect(await c.sendPanelMessage(ext.name, 'other.panel', {})).toBe(false);
    expect(await c.sendPanelMessage('@oide-test/missing', 'uiSample.board', {})).toBe(false);
    expect(c.state(ext.name)).toBe('stopped');
  });

  it('runs a deploy target with its argument, and only declared targets', async () => {
    const { s } = services();
    const c = client(s);
    const r = (await c.runDeployTarget(ext.name, 'uiSample.deployPreview', {
      agentId: 'a1',
      branch: 'oide/feature',
      worktreePath: '/w',
    })) as { message: string; url: string };
    expect(r.message).toBe('Preview deploy of oide/feature from its worktree');
    expect(r.url).toBe('https://preview.example.invalid/a1');
    await expect(c.runDeployTarget(ext.name, 'uiSample.open', {})).rejects.toThrow(/no deploy target/);
    // A deploy target is not a command: the command bar cannot run it.
    await expect(c.runCommand('uiSample.deployPreview')).rejects.toThrow(/No extension provides/);
  });

  it('ctx.panels.open goes to services.openPanel with the agent', async () => {
    const { s, opened } = services();
    const c = client(s);
    expect(await c.runCommand('uiSample.open', [{ agentId: 'a9' }])).toBe('opened');
    expect(await c.runCommand('uiSample.open', [])).toBe('opened');
    expect(opened).toEqual(['uiSample.notes a9', 'uiSample.board']);
  });
});
