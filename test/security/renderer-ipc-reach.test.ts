import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, makeRepo, startHarness, tempDir, type Harness } from '../integration/harness.js';

/**
 * What a compromised renderer (XSS in a markdown/transcript/extension surface) can do through
 * the real IPC router. Each test states the secure behaviour; `it.fails` marks today's gap.
 * See docs/wiki/pages/review-security.md.
 */
const open: Harness[] = [];
const dirs: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close().catch(() => undefined);
  while (servers.length) await new Promise((r) => servers.pop()!.close(r));
  cleanup(...dirs.splice(0));
});
async function harness(opts: Parameters<typeof startHarness>[0] = {}): Promise<Harness> {
  const h = await startHarness(opts);
  open.push(h);
  dirs.push(h.userData);
  return h;
}

describe('compromised renderer → main', () => {
  // SEC-04 (high): custom.probeCommand spawns any command line the renderer sends.
  it('custom.probeCommand does not run an arbitrary renderer-supplied command', async () => {
    const h = await harness();
    const dir = tempDir('oide-sec-probe-');
    dirs.push(dir);
    const marker = join(dir, 'pwned');
    const code = await h
      .fails('custom.probeCommand', { command: process.execPath, args: ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`], env: {} })
      .catch(() => 'succeeded');
    expect(existsSync(marker)).toBe(false);
    expect(code).toBe('forbidden');
  });

  // SEC-05 (high): terminal.create takes any `command`, and any registered root as cwd, including app-data (userData).
  it('terminal.create refuses a renderer-chosen command line in the app-data folder', async () => {
    const h = await harness();
    h.ctx.roots.add(h.userData, 'app-data'); // as apps/desktop/src/main/index.ts:95 does
    const code = await h.fails('terminal.create', { cwd: h.userData, command: 'calc.exe' }).catch(() => 'succeeded');
    expect(code).not.toBe('succeeded');
  });

  // SEC-08 (medium): projects.open({ path }) accepts any path the renderer names (no dialog),
  // adds it to the file-access roots, and runs git there.
  it('projects.open refuses an explicit path that was never picked in a dialog', async () => {
    const h = await harness();
    const repo = makeRepo();
    dirs.push(repo);
    writeFileSync(join(repo, 'id_rsa'), 'PRIVATE');
    const code = await h.fails('projects.open', { path: repo }).catch(() => 'succeeded');
    expect(code).toBe('forbidden_path');
  });

  // SEC-09 (medium): a stored custom-model key can be exfiltrated by re-pointing baseUrl and
  // pressing "Test connection" (the key is kept when apiKey is omitted).
  it('settings.testCustomModel does not send a stored key to a changed base URL', async () => {
    const h = await harness({ confirm: 'accept' }); // even when the user accepts the new endpoint
    let seen: string | undefined;
    const srv = createServer((req, res) => {
      seen = String(req.headers['x-api-key'] ?? '');
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    });
    servers.push(srv);
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const port = (srv.address() as AddressInfo).port;
    const model = { id: 'm1', name: 'Mine', provider: 'compatible-api' as const, baseUrl: 'https://llm.example.invalid', model: 'x', hasKey: false, extraEnv: {} };
    await h.call('settings.saveCustomModel', { model, apiKey: 'sk-victim-secret' });
    await h.call('settings.saveCustomModel', { model: { ...model, baseUrl: `http://127.0.0.1:${port}` } });
    await h.call('settings.testCustomModel', { id: 'm1' });
    expect(seen).not.toBe('sk-victim-secret');
  });
});
