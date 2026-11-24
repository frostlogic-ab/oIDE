import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ExtensionHostClient, nodeFork, type HostExtension, type HostServices, type HostStateChange } from '../src/host-client.js';
import { loadManifest } from '../src/manifest.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const loaded = loadManifest(path.join(here, 'fixtures', 'ext-sample'));
const ext: HostExtension = {
  name: loaded.manifest.name,
  version: loaded.manifest.version,
  dir: loaded.dir,
  main: loaded.main as string,
  activation: loaded.activation,
  panelIds: loaded.panels.map((p) => p.id),
  commandIds: loaded.manifest.oide.contributes.commands.map((c) => c.id),
};

function services(over: Partial<HostServices> = {}) {
  const calls: string[] = [];
  const logs: string[] = [];
  const s: HostServices = {
    settingsGet: (e, key) => {
      calls.push(`get ${e} ${key}`);
      return key === 'sample.token' ? 'from-keychain' : undefined;
    },
    settingsSet: () => undefined,
    listAgents: (e) => {
      calls.push(`list ${e}`);
      return [{ id: 'a1', projectId: 'p1', title: 't', status: 'running', model: 'm' }];
    },
    postMessage: (e, agentId, text) => {
      calls.push(`post ${e} ${agentId} ${text}`);
    },
    openPanel: (e, id, o) => {
      calls.push(`panel ${e} ${id} ${o.agentId ?? ''}`);
    },
    postPanelMessage: () => undefined,
    readArtifact: (_e, id) => ({ id, title: 'x', kind: 'doc', content: '' }),
    canSeeProject: (_e, p) => p === 'p1',
    log: (_e, level, m) => logs.push(`${level}: ${m}`),
    ...over,
  };
  return { s, calls, logs };
}

let clients: ExtensionHostClient[] = [];
afterEach(async () => {
  await Promise.all(clients.map((c) => c.dispose()));
  clients = [];
});

function client(s: HostServices, backoff = { initialMs: 50, maxMs: 200, maxRestarts: 3 }) {
  const c = new ExtensionHostClient({ fork: nodeFork(), services: s, backoff, timeoutMs: 10_000 });
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

describe('ExtensionHostClient (child_process.fork)', () => {
  it('activates on startup and round-trips a command through the extension API', async () => {
    const { s, calls, logs } = services();
    const c = client(s);
    await c.activate('onStartup');
    expect(c.state(ext.name)).toBe('running');
    const r = await c.runCommand('sample.echo', [1, 'two']);
    expect(r).toEqual({ args: [1, 'two'], token: 'from-keychain', agents: ['a1'], ext: '@oide-test/sample' });
    expect(calls).toContain('get @oide-test/sample sample.token');
    await waitFor(() => logs.some((l) => l.includes('activated by onStartup')));
  });

  it('activates lazily on onCommand and checks panel ids', async () => {
    const { s, calls } = services();
    const c = client(s);
    expect(c.state(ext.name)).toBe('stopped');
    expect(await c.runCommand('sample.lazy')).toBe('opened');
    expect(calls).toContain('panel @oide-test/sample sample.panel a1');
    await expect(c.runCommand('nobody.has.this')).rejects.toThrow(/No extension/);
  });

  it('forwards agent events only for projects the extension can see', async () => {
    const { s, calls } = services();
    const c = client(s);
    await c.activate('onStartup');
    await new Promise((r) => setTimeout(r, 100)); // let the extension subscribe
    await c.dispatchAgentEvent({ agentId: 'a2', type: 'ping', seq: 1, ts: 0 }, 'p2');
    await c.dispatchAgentEvent({ agentId: 'a1', type: 'ping', seq: 2, ts: 0 }, 'p1');
    await waitFor(() => calls.some((x) => x.startsWith('post ')));
    expect(calls.filter((x) => x.startsWith('post '))).toEqual(['post @oide-test/sample a1 pong 1']);
  });

  it('restarts a crashed host with backoff and marks its panels reloading', async () => {
    const { s } = services();
    const c = client(s);
    const states: HostStateChange[] = [];
    c.onState((x) => states.push(x));
    await c.activate('onStartup');
    expect(await c.runCommand('sample.crash')).toBe('bye');
    await waitFor(() => states.some((x) => x.state === 'reloading'));
    const reloading = states.find((x) => x.state === 'reloading');
    expect(reloading?.panelIds).toEqual(['sample.panel']);
    await waitFor(() => c.state(ext.name) === 'running');
    expect(await c.runCommand('sample.echo')).toMatchObject({ args: [] });
  });

  it('gives up after too many crashes', async () => {
    const { s } = services();
    const c = client(s, { initialMs: 10, maxMs: 20, maxRestarts: 1 });
    const states: string[] = [];
    c.onState((x) => states.push(x.state));
    await c.activate('onStartup');
    await c.runCommand('sample.crash');
    await waitFor(() => states.includes('reloading'));
    await waitFor(() => c.state(ext.name) === 'running');
    await c.runCommand('sample.crash');
    await waitFor(() => c.state(ext.name) === 'failed');
  });

  it('restarts on demand (developer mode)', async () => {
    const { s, logs } = services();
    const c = client(s);
    await c.activate('onStartup');
    await c.restart(ext.name);
    expect(c.state(ext.name)).toBe('running');
    await waitFor(() => logs.filter((l) => l.includes('activated by')).length >= 2);
  });
});
