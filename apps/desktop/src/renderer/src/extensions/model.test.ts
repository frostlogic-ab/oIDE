import { describe, expect, it } from 'vitest';
import { ExtensionManifest, InstalledExtension } from '@oide/protocol';
import {
  artifactTypeOf,
  deployResultText,
  deployTargetsFor,
  isAppMessage,
  nextTheme,
  panelTabId,
  panelsAt,
  parsePanelTabId,
  themeForAccent,
  themeOptions,
} from './model';

function ext(
  name: string,
  contributes: Record<string, unknown>,
  over: Partial<InstalledExtension> = {},
): InstalledExtension {
  const manifest = ExtensionManifest.parse({
    name,
    version: '1.0.0',
    oide: { engine: '^1.0.0', displayName: name.split('/').pop(), contributes },
  });
  return InstalledExtension.parse({
    id: name,
    name,
    version: '1.0.0',
    displayName: manifest.oide.displayName,
    source: 'builtin',
    path: `/x/${name}`,
    enabledGlobally: true,
    manifest,
    ...over,
  });
}

const preview = ext('@oide/ext-browser-preview', {
  panels: [{ id: 'browserPreview.panel', title: 'Preview', entry: 'dist/panel.html', location: 'inspector' }],
});
const themes = ext('@oide/ext-themes', {
  themes: [
    { id: 'blue', label: 'Blue', tokens: { accent: '#7AA2F7', 'accent-contrast': '#0B0D10' } },
    { id: 'green', label: 'Green', tokens: { accent: '#7fc8a9', ground: '#FF0000' } },
    { id: 'bad', label: 'Bad', tokens: { accent: 'red' } },
  ],
});
const sample = ext(
  '@oide-test/ui',
  {
    panels: [{ id: 'board', title: 'Board', entry: 'dist/b.html', location: 'screen' }],
    artifactTypes: [{ id: 'diagram', label: 'Diagram', entry: 'dist/d.html' }],
    deployTargets: [{ id: 'deploy', title: 'Create preview deploy' }],
  },
  { enabledGlobally: false, enabledProjects: ['p1'] },
);

describe('extension UI model', () => {
  it('lists inspector panels per project and screens of extensions on anywhere', () => {
    expect(panelsAt([preview, sample], 'inspector', 'p1').map((p) => p.id)).toEqual(['browserPreview.panel']);
    expect(panelsAt([preview, sample], 'screen').map((p) => p.id)).toEqual(['board']);
    const off = { ...preview, disabledProjects: ['p2'] };
    expect(panelsAt([off], 'inspector', 'p2')).toEqual([]);
    expect(panelsAt([{ ...sample, enabledProjects: [] }], 'screen')).toEqual([]);
  });

  it('round-trips inspector tab ids', () => {
    const id = panelTabId('@oide/ext-browser-preview', 'browserPreview.panel');
    expect(id).toBe('ext:@oide/ext-browser-preview::browserPreview.panel');
    expect(parsePanelTabId(id)).toEqual({
      extension: '@oide/ext-browser-preview',
      panelId: 'browserPreview.panel',
    });
    expect(parsePanelTabId('plan')).toBeUndefined();
  });

  it('themes: valid accents only, allow-listed tokens only, cycling', () => {
    const opts = themeOptions([themes]);
    expect(opts.map((o) => [o.label, o.value])).toEqual([
      ['Blue', '#7AA2F7'],
      ['Green', '#7FC8A9'],
    ]);
    expect(opts[0]!.vars).toEqual({ '--color-accent': '#7AA2F7', '--color-on-accent': '#0B0D10' });
    expect(opts[1]!.vars).toEqual({ '--color-accent': '#7fc8a9' });
    expect(themeForAccent(opts, '#7fc8a9')?.id).toBe('green');
    expect(nextTheme(opts, '#7FC8A9')?.id).toBe('blue');
    expect(nextTheme(opts, '#123456')?.id).toBe('blue');
    expect(themeOptions([{ ...themes, enabledGlobally: false }])).toEqual([]);
  });

  it('artifact types resolve only for extensions that are on and declare them', () => {
    expect(artifactTypeOf([sample], '@oide-test/ui:diagram')).toMatchObject({
      extension: '@oide-test/ui',
      id: 'diagram',
      label: 'Diagram',
    });
    expect(artifactTypeOf([sample], '@oide-test/ui:other')).toBeUndefined();
    expect(artifactTypeOf([sample], undefined)).toBeUndefined();
    expect(artifactTypeOf([{ ...sample, enabledProjects: [] }], '@oide-test/ui:diagram')).toBeUndefined();
  });

  it('deploy targets per project, and their result text', () => {
    expect(deployTargetsFor([sample, preview], 'p1').map((d) => d.title)).toEqual(['Create preview deploy']);
    expect(deployTargetsFor([sample], 'p2')).toEqual([]);
    expect(deployResultText('Deploy', { message: 'Deployed', url: 'https://x.dev/1' })).toEqual({
      text: 'Deployed',
      url: 'https://x.dev/1',
    });
    expect(deployResultText('Deploy', { url: 'javascript:alert(1)' })).toEqual({ text: 'Deploy: done' });
    expect(deployResultText('Deploy', 'ok')).toEqual({ text: 'ok' });
    expect(deployResultText('Deploy', null)).toEqual({ text: 'Deploy: done' });
  });

  it('app messages are the oide:* namespace', () => {
    expect(isAppMessage({ type: 'oide:artifact.save' })).toBe(true);
    expect(isAppMessage({ type: 'navigate' })).toBe(false);
    expect(isAppMessage('oide:x')).toBe(false);
  });
});
