import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentSpec, CustomServer } from '../../packages/protocol/src/index.js';
import { AGENT_SECRET_HEADER } from '../../packages/extension-host/src/mcp-proxy.js';
import { samplePkg } from '../../packages/extension-host/test/helpers.js';
import { setConfirmOverride, type ConfirmOptions } from '../../apps/desktop/src/main/security/confirm.js';
import { cleanup, REPO, startHarness, tempDir, type Harness } from '../integration/harness.js';

/**
 * Extension and custom-tool paths a compromised renderer could use to run code or move secrets
 * (review-security SEC-06, SEC-07, SEC-09, SEC-10, SEC-15). Every one now needs a native
 * confirmation in main; here the override stands in for the user's answer.
 */
const open: Harness[] = [];
const dirs: string[] = [];
afterEach(async () => {
  setConfirmOverride(null);
  while (open.length) await open.pop()!.close().catch(() => undefined);
  cleanup(...dirs.splice(0));
});
async function harness(): Promise<Harness> {
  const h = await startHarness();
  open.push(h);
  dirs.push(h.userData);
  return h;
}
/** Answer every confirmation with `answer`, recording what was asked. */
function answer(answer: boolean): ConfirmOptions[] {
  const asked: ConfirmOptions[] = [];
  setConfirmOverride((o) => {
    asked.push(o);
    return answer;
  });
  return asked;
}
function folderExtension(): string {
  const dir = tempDir('oide-sec-ext-');
  dirs.push(dir);
  mkdirSync(join(dir, 'dist'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify(samplePkg()));
  for (const f of ['host.js', 'mcp.js', 'panel.html']) writeFileSync(join(dir, 'dist', f), '');
  return dir;
}
const stdio = (over: Partial<CustomServer> = {}): CustomServer => ({
  id: 's1',
  name: 'local',
  route: 'command',
  transport: { kind: 'stdio', command: 'node', args: ['server.js'], envKeys: [] },
  tools: [],
  projects: [],
  allProjects: true,
  savedTo: 'my-settings',
  reviewed: false,
  ...over,
});
const spec = (projectId: string): AgentSpec => ({ projectId, title: 't', goal: 'g', context: [], workIn: 'project-folder', mode: 'auto', strategy: { kind: 'fixed', model: 'sonnet' }, techniques: [], extensions: [], attempts: 1 }) as unknown as AgentSpec;

describe('extensions and custom tools need a native confirmation in main', () => {
  it('SEC-06: extensions.addFromGit clones nothing until the URL is confirmed', async () => {
    const h = await harness();
    const asked = answer(false);
    expect(await h.fails('extensions.addFromGit', { url: 'https://git.example.invalid/evil.git' })).toBe('forbidden');
    expect(asked[0]?.detail).toContain('https://git.example.invalid/evil.git');
  });

  it('SEC-06/SEC-07: turning on an unreviewed folder extension asks once and shows what runs', async () => {
    const h = await harness();
    const ext = await h.services.extensions.addFromFolder(folderExtension(), false);
    let asked = answer(false);
    expect(await h.fails('extensions.setEnabled', { id: ext.id, enabled: true })).toBe('forbidden');
    expect(h.services.extensions.registry.get(ext.id)?.enabledGlobally).toBe(false);
    expect(asked[0]?.detail).toMatch(/Host code: dist[\\/]host\.js/);
    expect(asked[0]?.detail).toContain('MCP server "sample": node');
    asked = answer(true);
    await h.call('extensions.setEnabled', { id: ext.id, enabled: true });
    await h.call('extensions.setEnabled', { id: ext.id, projectId: 'p1', enabled: true });
    expect(asked).toHaveLength(1);
  });

  it('SEC-07: custom.save of a stdio command asks first, and asks again when the command changes', async () => {
    const h = await harness();
    let asked = answer(false);
    expect(await h.fails('custom.save', { server: stdio(), secrets: { API_KEY: 'k' } })).toBe('forbidden');
    expect(await h.call('custom.list', undefined)).toEqual([]);
    expect(asked[0]?.detail).toContain('node server.js');
    expect(asked[0]?.detail).toContain('API_KEY');
    asked = answer(true);
    await h.call('custom.save', { server: stdio(), secrets: { API_KEY: 'k' } });
    await h.call('custom.save', { server: stdio({ name: 'renamed' }), secrets: {} }); // same command: no prompt
    expect(asked).toHaveLength(1);
    // SEC-09: a changed command does not inherit the old command's secrets.
    await h.call('custom.save', { server: stdio({ transport: { kind: 'stdio', command: 'evil', args: [], envKeys: ['API_KEY'] } }), secrets: {} });
    expect(asked).toHaveLength(2);
    expect(h.services.extensions.hostSecrets.get('custom/s1/env/API_KEY')).toBeUndefined();
  });

  it('SEC-04: a probed command needs no second prompt when saved right after', async () => {
    const h = await harness();
    const asked = answer(true);
    const r = await h.call('custom.probeCommand', { command: process.execPath, args: ['-e', 'process.exit(0)'], env: { TOKEN: 'x' } });
    expect(r.started).toBe(false);
    expect(asked[0]?.message).toMatch(/Run this command/);
    expect(asked[0]?.detail).toContain('TOKEN');
    await h.call('custom.save', { server: stdio({ transport: { kind: 'stdio', command: process.execPath, args: ['-e', 'process.exit(0)'], envKeys: [] } }), secrets: {} });
    expect(asked).toHaveLength(1);
  });

  it('SEC-15: custom tools only become pre-allowed after the user confirms in main', async () => {
    const h = await harness();
    const http = (tools: CustomServer['tools']): CustomServer => ({ ...stdio(), route: 'url', transport: { kind: 'http', url: 'https://mcp.example.com/mcp', auth: 'none' }, tools });
    const asked = answer(false);
    await h.call('custom.save', { server: http([{ name: 'write', risk: 'ask', enabled: true }]), secrets: {} });
    expect(asked).toHaveLength(0);
    expect(await h.fails('custom.save', { server: http([{ name: 'write', risk: 'read', enabled: true }]), secrets: {} })).toBe('forbidden');
    expect(asked[0]?.detail).toContain('Runs without asking: write');
    expect((await h.call('custom.list', undefined))[0]?.tools[0]?.risk).toBe('ask');
  });

  it('SEC-15: tools of folder and git extensions always ask first, whatever their manifest says', async () => {
    const h = await harness();
    answer(true);
    const ext = await h.services.extensions.addFromFolder(folderExtension(), false);
    await h.call('extensions.setEnabled', { id: ext.id, enabled: true });
    const cfg = await h.services.extensions.agentConfig(spec('p1'), 'a-sec15');
    const schema = cfg.tools.find((t) => t.tool === 'db.schema');
    expect(schema?.risk).toBe('ask');
  });

  it('SEC-14: the consent copy and docs never claim capabilities are enforced', () => {
    const read = (p: string) => readFileSync(join(REPO, p), 'utf8');
    expect(read('apps/desktop/src/renderer/src/screens/Marketplace/AddCustomDialog.tsx')).toContain('oIDE does not enforce this');
    expect(read('docs/wiki/pages/security.md')).toMatch(/not a sandbox/);
    expect(read('packages/extension-api/README.md')).toMatch(/not enforced/);
  });

  it("SEC-09/SEC-10: a header token stays with its origin, and an agent's proxy secret opens only its own servers", async () => {
    const h = await harness();
    answer(true);
    const remote = (id: string, name: string, projects: string[], url = `https://${name}.example.com/mcp`): CustomServer => ({
      ...stdio(),
      id,
      name,
      route: 'url',
      transport: { kind: 'http', url, auth: 'header' },
      projects,
      allProjects: false,
    });
    await h.call('custom.save', { server: remote('a', 'alpha', ['pA']), secrets: {} });
    await h.call('custom.save', { server: remote('b', 'beta', ['pB']), secrets: {} });
    await h.call('custom.setHeaderToken', { id: 'a', header: 'Authorization', token: 'Bearer A' });
    await h.call('custom.setHeaderToken', { id: 'b', header: 'Authorization', token: 'Bearer B' });

    const cfg = await h.services.extensions.agentConfig(spec('pA'), 'agent-a');
    const entry = cfg.servers['alpha'];
    expect(entry?.type).toBe('http');
    const secret = entry?.type === 'http' ? entry.headers?.[AGENT_SECRET_HEADER] : undefined;
    expect(secret).toBeTruthy();
    const proxy = h.services.extensions.proxy;
    const res = await fetch(proxy.urlFor('beta'), { method: 'POST', headers: { [AGENT_SECRET_HEADER]: secret!, 'content-type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(403);

    // Re-pointing alpha to another host drops its token.
    await h.call('custom.save', { server: remote('a', 'alpha', ['pA'], 'https://attacker.example.net/mcp'), secrets: {} });
    expect(h.services.extensions.hostSecrets.get('custom/a/header')).toBeUndefined();
    expect(h.services.extensions.hostSecrets.get('custom/b/header')).toBeDefined();
  });
});
