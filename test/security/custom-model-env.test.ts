import { afterEach, describe, expect, it } from 'vitest';
import { setConfirmOverride, type ConfirmOptions } from '../../apps/desktop/src/main/security/confirm.js';
import { pathKey } from '../../packages/git/src/index.js';
import { cleanup, startHarness, type Harness } from '../integration/harness.js';

/**
 * SEC-28 (custom model env runs code / redirects traffic), SEC-29 (CLI path confirmation skipped
 * for paths picked for other purposes), SEC-30 (model key bound to the origin only).
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
/** Record every native confirmation and answer it with `answer`. */
function confirmations(answer: boolean): ConfirmOptions[] {
  const seen: ConfirmOptions[] = [];
  setConfirmOverride((o) => {
    seen.push(o);
    return answer;
  });
  return seen;
}
const base = { id: 'm1', name: 'Mine', provider: 'compatible-api' as const, baseUrl: 'https://llm.example.invalid', model: 'x', hasKey: false, extraEnv: {} as Record<string, string> };

describe('SEC-28: custom model env', () => {
  it('refuses denied env names at save time, whatever their case, through both commands', async () => {
    const h = await harness();
    const seen = confirmations(true);
    for (const extraEnv of [{ NODE_OPTIONS: '--require /tmp/x.js' }, { Path: 'C:\\evil' }, { https_proxy: 'http://evil' }, { LD_PRELOAD: '/x.so' }, { DYLD_INSERT_LIBRARIES: '/x' }, { ELECTRON_RUN_AS_NODE: '1' }, { CLAUDE_CODE_GIT_BASH_PATH: 'C:\\x' }, { ANTHROPIC_BASE_URL: 'https://evil' }, { NODE_TLS_REJECT_UNAUTHORIZED: '0' }, { GIT_SSH_COMMAND: 'x' }]) {
      expect(await h.fails('settings.saveCustomModel', { model: { ...base, extraEnv } })).toBe('invalid_input');
      expect(await h.fails('settings.update', { patch: { models: { custom: [{ ...base, extraEnv }] } } })).toBe('invalid_input');
    }
    expect(seen).toHaveLength(0);
    expect((await h.call('settings.get', undefined)).models.custom).toHaveLength(0);
  });

  it('a new or re-pointed model needs a native confirmation showing the values (secret values hidden)', async () => {
    const h = await harness();
    let seen = confirmations(false);
    const model = { ...base, extraEnv: { AWS_REGION: 'eu-west-1', MY_API_TOKEN: 'tok-should-not-show' } };
    expect(await h.fails('settings.saveCustomModel', { model })).toBe('forbidden');
    expect((await h.call('settings.get', undefined)).models.custom).toHaveLength(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.detail).toContain('https://llm.example.invalid');
    expect(seen[0]!.detail).toContain('compatible-api');
    expect(seen[0]!.detail).toContain('AWS_REGION=eu-west-1');
    expect(seen[0]!.detail).toContain('MY_API_TOKEN (value hidden)');
    expect(seen[0]!.detail).not.toContain('tok-should-not-show');

    seen = confirmations(true);
    await h.call('settings.saveCustomModel', { model });
    expect(seen).toHaveLength(1);
    // Name and model id changes need no confirmation.
    seen = confirmations(false);
    await h.call('settings.saveCustomModel', { model: { ...model, name: 'Renamed', model: 'y' } });
    await h.call('settings.update', { patch: { models: { custom: [{ ...model, name: 'Again' }] } } });
    expect(seen).toHaveLength(0);
    // Base URL, provider or env changes do, through either command.
    expect(await h.fails('settings.saveCustomModel', { model: { ...model, baseUrl: 'https://other.example.invalid' } })).toBe('forbidden');
    expect(await h.fails('settings.saveCustomModel', { model: { ...model, provider: 'local' } })).toBe('forbidden');
    expect(await h.fails('settings.update', { patch: { models: { custom: [{ ...model, extraEnv: { AWS_REGION: 'us-east-1' } }] } } })).toBe('forbidden');
    expect(seen).toHaveLength(3);
    expect((await h.call('settings.get', undefined)).models.custom[0]).toMatchObject({ name: 'Again', baseUrl: 'https://llm.example.invalid', extraEnv: { AWS_REGION: 'eu-west-1' } });
  });
});

describe('SEC-29: CLI path picks', () => {
  it('a path picked for another purpose does not skip the CLI confirmation; a dialog.pickCli pick does, once', async () => {
    const h = await harness();
    const seen = confirmations(false);
    const evil = process.platform === 'win32' ? 'C:\\Users\\me\\Downloads\\payload.exe' : '/tmp/payload';
    h.services.platform.pickFile = async () => evil;
    expect(await h.call('dialog.pickFile', { filters: [] })).toBe(evil); // e.g. artifacts import
    expect(h.services.picked.has(pathKey(evil))).toBe(true);
    expect(await h.fails('settings.update', { patch: { claude: { cliPath: evil } } })).toBe('forbidden');
    expect(seen).toHaveLength(1);

    const cli = process.platform === 'win32' ? 'C:\\tools\\claude.exe' : '/opt/claude/bin/claude';
    h.services.platform.pickFile = async () => cli;
    expect(await h.call('dialog.pickCli', undefined)).toBe(cli);
    expect(h.services.picked.has(pathKey(cli))).toBe(false);
    expect((await h.call('settings.update', { patch: { claude: { cliPath: cli } } })).claude.cliPath).toBe(cli);
    expect(seen).toHaveLength(1);
    // One pick covers one change: setting it again later asks again.
    await h.call('settings.update', { patch: { claude: { cliPath: null } } });
    expect(await h.fails('settings.update', { patch: { claude: { cliPath: cli } } })).toBe('forbidden');
    expect(seen).toHaveLength(2);
  });
});

describe('SEC-30: model keys are bound to origin, provider and env', () => {
  it('changing extraEnv (same origin) withholds the key until it is entered again', async () => {
    const h = await harness();
    confirmations(true);
    const model = { ...base, extraEnv: { AWS_REGION: 'eu-west-1' } };
    expect((await h.call('settings.saveCustomModel', { model, apiKey: 'sk-1' })).hasKey).toBe(true);
    // A raw settings.update that changes only the env: the key stays stored but is not released.
    await h.call('settings.update', { patch: { models: { custom: [{ ...model, extraEnv: { AWS_REGION: 'eu-west-1', EXTRA: '1' }, hasKey: true }] } } });
    expect((await h.call('settings.get', undefined)).models.custom[0]!.hasKey).toBe(false);
    const { boundModelKey } = await import('../../apps/desktop/src/main/security/model-keys.js');
    expect(boundModelKey(h.services.secrets, (await h.call('settings.get', undefined)).models.custom[0]!)).toBeUndefined();
    // Back to the env it was entered for: released again.
    await h.call('settings.update', { patch: { models: { custom: [model] } } });
    expect((await h.call('settings.get', undefined)).models.custom[0]!.hasKey).toBe(true);
    // saveCustomModel with a changed env and no new key deletes it.
    expect((await h.call('settings.saveCustomModel', { model: { ...model, extraEnv: {} } })).hasKey).toBe(false);
    expect(h.services.secrets.get('model:m1')).toBeUndefined();
    // A key entered with the new env works.
    expect((await h.call('settings.saveCustomModel', { model: { ...model, extraEnv: {} }, apiKey: 'sk-2' })).hasKey).toBe(true);
  });

  it('a key stored with an origin-only binding (before SEC-30) is not released', async () => {
    const h = await harness();
    confirmations(true);
    await h.call('settings.saveCustomModel', { model: base });
    h.services.secrets.set('model:m1', 'sk-old');
    h.services.secrets.set('model:m1:origin', 'https://llm.example.invalid');
    expect((await h.call('settings.get', undefined)).models.custom[0]!.hasKey).toBe(false);
    await h.call('settings.deleteCustomModel', { id: 'm1' });
    expect(h.services.secrets.get('model:m1:origin')).toBeUndefined();
  });
});
