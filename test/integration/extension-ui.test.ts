import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { extensionOrigin, resolveExtensionUrl } from '../../apps/desktop/src/main/services/extension-ui.js';
import { nodeFork } from '../../packages/extension-host/src/index.js';
import { REPO, cleanup, makeRepo, startHarness, waitFor, type Harness } from './harness.js';

/**
 * Extension UI contribution points through the real IPC router and services, with the built-in
 * extensions plus the UI sample fixture (one of every point) and host code in forked processes.
 */

const UI = '@oide-test/ui';
const PREVIEW = '@oide/ext-browser-preview';
const open: Harness[] = [];
const dirs: string[] = [];
afterEach(async () => {
  while (open.length)
    await open
      .pop()!
      .close()
      .catch(() => undefined);
  cleanup(...dirs.splice(0));
});

async function harness(): Promise<Harness> {
  // The deploy-target flow sets --fake-scenario extra flags, which main confirms natively (SEC-07): accept.
  const h = await startHarness({
    confirm: 'accept',
    platform: {
      builtinExtensionDirs: [
        join(REPO, 'extensions'),
        join(REPO, 'packages', 'extension-host', 'test', 'fixtures', 'ui-builtins'),
      ],
      forkHost: nodeFork(),
    },
  });
  open.push(h);
  dirs.push(h.userData);
  return h;
}

describe('extension UI contributions (plain Node, real router)', () => {
  it('panels: oide-ext:// URLs served only from the extension folder, loopback frames only for Browser preview', async () => {
    const h = await harness();
    const names = (await h.call('extensions.installed', undefined)).map((e) => e.name);
    expect(names).toEqual(expect.arrayContaining([UI, PREVIEW, '@oide/ext-themes', '@oide/ext-git']));

    const { url } = await h.call('extensions.uiUrl', {
      extension: PREVIEW,
      kind: 'panel',
      id: 'browserPreview.panel',
    });
    expect(url).toBe(`oide-ext://${extensionOrigin(PREVIEW)}/dist/panel.html`);
    const lookup = (o: string) => h.services.extensions.uiSite(o);
    const hit = resolveExtensionUrl(lookup, url);
    expect(hit?.file.replace(/\\/g, '/')).toMatch(/extensions\/browser-preview\/dist\/panel\.html$/);
    expect(hit?.csp).toContain('frame-src http://localhost:*');
    expect(hit?.csp).toContain("connect-src 'none'");

    const board = await h.call('extensions.uiUrl', { extension: UI, kind: 'panel', id: 'uiSample.board' });
    expect(resolveExtensionUrl(lookup, board.url)?.csp).toContain("frame-src 'none'");
    const viewer = await h.call('extensions.uiUrl', { extension: UI, kind: 'artifactType', id: 'diagram' });
    expect(viewer.url).toMatch(/\/dist\/diagram\.html$/);
    expect(
      resolveExtensionUrl(
        lookup,
        viewer.url.replace('dist/diagram.html', 'package.json/../../../browser-preview/dist/panel.html'),
      ),
    ).toBeNull();
    expect(await h.fails('extensions.uiUrl', { extension: UI, kind: 'panel', id: 'nope' })).toBe('not_found');

    // Turned off: no URL, and the protocol stops serving it.
    await h.call('extensions.setEnabled', { id: UI, enabled: false });
    expect(await h.fails('extensions.uiUrl', { extension: UI, kind: 'panel', id: 'uiSample.board' })).toBe(
      'not_found',
    );
    expect(resolveExtensionUrl(lookup, board.url)).toBeNull();
  });

  it('panels: the bridge reaches host code (started on demand) and host replies come back as events', async () => {
    const h = await harness();
    await h.call('extensions.setSetting', { id: UI, key: 'uiSample.token', value: 'tok-123' });
    await h.call('extensions.panelMessage', {
      extension: UI,
      panelId: 'uiSample.board',
      data: { type: 'ping', n: 1 },
    });
    const reply = await waitFor(
      () => h.eventsOf('extensions.panelMessage').find((e) => e.extension === UI),
      'pong',
    );
    expect(reply).toEqual({
      extension: UI,
      panelId: 'uiSample.board',
      data: { type: 'pong', n: 1, token: 'set', limit: 5 },
    });

    expect(await h.fails('extensions.panelMessage', { extension: UI, panelId: 'other', data: {} })).toBe(
      'not_found',
    );
    expect(
      await h.fails('extensions.panelMessage', {
        extension: UI,
        panelId: 'uiSample.board',
        data: 'x'.repeat(300 * 1024),
      }),
    ).toBe('invalid_input');

    // ctx.panels.open from a command: the renderer gets extensions.panelOpen.
    expect(await h.call('extensions.runCommand', { commandId: 'uiSample.open', args: [] })).toBe('opened');
    expect(h.eventsOf('extensions.panelOpen')).toContainEqual({ extension: UI, panelId: 'uiSample.board' });
    // An unknown agent id is dropped rather than passed on.
    await h.call('extensions.runCommand', {
      commandId: 'uiSample.open',
      args: [{ agentId: 'no-such-agent' }],
    });
    expect(h.eventsOf('extensions.panelOpen').at(-1)).toEqual({ extension: UI, panelId: 'uiSample.notes' });
  });

  it('settings: fields with defaults, secret values in the keychain and never sent back', async () => {
    const h = await harness();
    const before = await h.call('extensions.settings', { id: UI });
    expect(before).toEqual([
      { key: 'uiSample.token', type: 'string', secret: true, description: 'API token', hasValue: false },
      {
        key: 'uiSample.limit',
        type: 'number',
        secret: false,
        description: 'Rows to show',
        default: 5,
        hasValue: false,
      },
      { key: 'uiSample.verbose', type: 'boolean', secret: false, default: false, hasValue: false },
    ]);
    await h.call('extensions.setSetting', { id: UI, key: 'uiSample.token', value: 'very-secret' });
    await h.call('extensions.setSetting', { id: UI, key: 'uiSample.limit', value: 9 });
    const after = await h.call('extensions.settings', { id: UI });
    expect(after[0]).toEqual({
      key: 'uiSample.token',
      type: 'string',
      secret: true,
      description: 'API token',
      hasValue: true,
    });
    expect(after[1]).toMatchObject({ value: 9, hasValue: true });
    expect(JSON.stringify(after)).not.toContain('very-secret');
    expect(JSON.stringify(h.events)).not.toContain('very-secret');
    expect(h.services.secrets.get(`ext:${UI}/uiSample.token`)).toBe('very-secret');
    expect(h.eventsOf('extensions.settingChanged')).toEqual([
      { id: UI, key: 'uiSample.token' },
      { id: UI, key: 'uiSample.limit' },
    ]);

    expect(await h.fails('extensions.setSetting', { id: UI, key: 'uiSample.limit', value: 'ten' })).toBe(
      'invalid_input',
    );
    expect(await h.fails('extensions.setSetting', { id: UI, key: 'uiSample.other', value: 1 })).toBe(
      'not_found',
    );
    await h.call('extensions.setSetting', { id: UI, key: 'uiSample.token', value: null });
    expect((await h.call('extensions.settings', { id: UI }))[0]?.hasValue).toBe(false);

    // Browser preview's default URL, as the panel's host code reads it.
    const preview = await h.call('extensions.settings', { id: PREVIEW });
    expect(preview).toEqual([
      expect.objectContaining({ key: 'browserPreview.defaultUrl', default: 'http://localhost:3000' }),
    ]);
  });

  it('techniques: contributed ones join Settings and Spawn, read-only', async () => {
    const h = await harness();
    const list = await h.call('settings.techniques', {});
    const t = list.find((x) => x.id === `ext:${UI}:tidy`);
    expect(t).toMatchObject({
      name: 'Tidy imports',
      extension: 'UI sample',
      placement: 'first-message',
      enabledByDefault: false,
    });
    expect(await h.fails('settings.saveTechnique', { technique: { ...t!, text: 'changed' } })).toBe(
      'forbidden',
    );
    expect(await h.fails('settings.deleteTechnique', { id: t!.id })).toBe('forbidden');
    await h.call('extensions.setEnabled', { id: UI, enabled: false });
    expect((await h.call('settings.techniques', {})).some((x) => x.extension)).toBe(false);
  });

  it('deploy targets: run host code with the agent and its worktree; refused for unknown agents and targets', async () => {
    const repo = makeRepo();
    dirs.push(repo);
    const h = await harness();
    await h.call('settings.update', { patch: { claude: { extraFlags: '--fake-scenario review' } } });
    h.allowOpen(repo); // stands in for the folder-picker pick (SEC-08)
    const project = (await h.call('projects.open', { path: repo }))!;
    const [a] = await h.call('agents.spawn', {
      projectId: project.id,
      title: 'Ship it',
      goal: 'Add feature.txt',
      mode: 'acceptEdits',
      strategy: { kind: 'single', lead: { model: 'sonnet' } },
      techniques: [`ext:${UI}:tidy`],
    });
    const agent = await waitFor(
      async () => (await h.call('agents.list', undefined)).find((x) => x.id === a!.id && x.worktreePath),
      'worktree',
    );
    // The extension's technique reached the agent's first message like any other technique.
    await waitFor(
      async () =>
        JSON.stringify(await h.call('agents.events', { agentId: agent.id })).includes(
          'Sort and dedupe imports',
        ),
      'technique text in the first message',
    );
    const r = (await h.call('extensions.runDeployTarget', {
      extension: UI,
      targetId: 'uiSample.deployPreview',
      agentId: agent.id,
    })) as { message: string; arg: Record<string, unknown> };
    expect(r.message).toBe(`Preview deploy of ${agent.branch} from its worktree`);
    expect(r.arg).toMatchObject({
      agentId: agent.id,
      projectId: project.id,
      title: 'Ship it',
      worktreePath: agent.worktreePath,
    });
    expect(
      await h.fails('extensions.runDeployTarget', {
        extension: UI,
        targetId: 'uiSample.open',
        agentId: agent.id,
      }),
    ).toBe('not_found');
    expect(
      await h.fails('extensions.runDeployTarget', {
        extension: UI,
        targetId: 'uiSample.deployPreview',
        agentId: 'nobody',
      }),
    ).toBe('not_found');
    // A deploy target cannot be run as a plain command (no agent check there).
    expect(await h.fails('extensions.runCommand', { commandId: 'uiSample.deployPreview', args: [] })).toBe(
      'command_failed',
    );
    await h.call('extensions.setEnabled', { id: UI, enabled: false, projectId: project.id });
    expect(
      await h.fails('extensions.runDeployTarget', {
        extension: UI,
        targetId: 'uiSample.deployPreview',
        agentId: agent.id,
      }),
    ).toBe('forbidden');
    await h.call('agents.stop', { agentId: agent.id }).catch(() => undefined);
  });

  it('artifact types: the type in artifact.json survives rescan and save', async () => {
    const h = await harness();
    const meta = await h.call('artifacts.create', { title: 'Flow', kind: 'doc', content: 'A -> B\n' });
    const file = join(h.services.artifacts.dirOf(meta.id), 'artifact.json');
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), type: `${UI}:diagram` }));
    await h.services.artifacts.rescan([]);
    expect((await h.call('artifacts.get', { id: meta.id })).meta.type).toBe(`${UI}:diagram`);
    const saved = await h.call('artifacts.save', { id: meta.id, content: 'A -> B\nB -> C\n' });
    expect(saved.type).toBe(`${UI}:diagram`);
    expect((await h.call('artifacts.list', {})).find((m) => m.id === meta.id)?.type).toBe(`${UI}:diagram`);
  });
});
