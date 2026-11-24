// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AgentSummary,
  ExtensionManifest,
  InstalledExtension,
  Settings,
  type ExtensionSettingField,
  type OideBridge,
} from '@oide/protocol';
import { installFallbackBridge } from '../lib/bridge';
import { useRouter } from '../stores/router';
import { useSettings } from '../stores/settings';
import { Inspector, type InspectorTab } from '../screens/Focus/components/Inspector';
import { AppearanceSection } from '../screens/Settings/OtherSections';
import { DeployActions } from './DeployActions';
import { ExtensionSettingsSection } from './ExtensionSettingsSection';
import { applyTheme, openPanel, useExtensions } from './store';
import { useState } from 'react';

function ext(name: string, displayName: string, contributes: Record<string, unknown>): InstalledExtension {
  const manifest = ExtensionManifest.parse({
    name,
    version: '1.0.0',
    oide: { engine: '^1.0.0', displayName, contributes },
  });
  return InstalledExtension.parse({
    id: name,
    name,
    version: '1.0.0',
    displayName,
    source: 'builtin',
    path: `/x/${name}`,
    enabledGlobally: true,
    manifest,
  });
}

const PREVIEW = ext('@oide/ext-browser-preview', 'Browser preview', {
  panels: [{ id: 'browserPreview.panel', title: 'Preview', entry: 'dist/panel.html', location: 'inspector' }],
  settings: {
    'browserPreview.defaultUrl': {
      type: 'string',
      default: 'http://localhost:3000',
      description: 'URL the preview panel opens first',
    },
  },
});
const SAMPLE = ext('@oide-test/ui', 'UI sample', {
  settings: { 'uiSample.token': { type: 'string', secret: true, description: 'API token' } },
  deployTargets: [{ id: 'uiSample.deployPreview', title: 'Create preview deploy' }],
  themes: [
    { id: 'rose', label: 'Rose', tokens: { accent: '#E8A0B4', 'accent-contrast': '#101010' } },
    { id: 'sky', label: 'Sky', tokens: { accent: '#88C0F0' } },
  ],
});

let fields: Record<string, ExtensionSettingField[]>;
const invoke = vi.fn(async (command: string, input?: unknown): Promise<unknown> => {
  const i = input as Record<string, unknown>;
  switch (command) {
    case 'extensions.uiUrl':
      return { url: `oide-ext://xabc/${String(i.id)}.html` };
    case 'extensions.settings':
      return fields[i.id as string] ?? [];
    case 'extensions.setSetting': {
      const list = fields[i.id as string]!;
      fields[i.id as string] = list.map((f) =>
        f.key !== i.key
          ? f
          : f.secret
            ? { ...f, hasValue: i.value !== null }
            : { ...f, value: i.value as string, hasValue: true },
      );
      return { ok: true };
    }
    case 'extensions.runDeployTarget':
      return { message: 'Preview deployed', url: 'https://preview.example.dev/1' };
    case 'settings.update':
      return Settings.parse({
        claude: {},
        models: {},
        agents: { notifications: {} },
        permissions: {},
        ui: (i.patch as { ui: unknown }).ui,
      });
    case 'git.diff':
    case 'artifacts.list':
    case 'extensions.installed':
      return [];
    default:
      return { ok: true };
  }
});

const agent = AgentSummary.parse({
  id: 'a1',
  projectId: 'p1',
  title: 'Preview work',
  status: 'running',
  mode: 'auto',
  model: 'sonnet',
  branch: 'oide/preview',
  worktreePath: '/w/preview',
  createdAt: 0,
  updatedAt: 0,
});

function InspectorHost({ initial = 'plan' as InspectorTab }) {
  const [tab, setTab] = useState<InspectorTab>(initial);
  return (
    <Inspector
      agent={agent}
      events={[]}
      subEvents={new Map()}
      tab={tab}
      onTab={setTab}
      now={0}
      stopRequested={new Set()}
      onOpenSubagent={() => {}}
      onStopSubagent={() => {}}
    />
  );
}

beforeEach(() => {
  installFallbackBridge({
    invoke: invoke as unknown as OideBridge['invoke'],
    on: () => () => {},
    platform: 'win32',
  });
  invoke.mockClear();
  fields = {
    '@oide/ext-browser-preview': [
      {
        key: 'browserPreview.defaultUrl',
        type: 'string',
        secret: false,
        default: 'http://localhost:3000',
        description: 'URL the preview panel opens first',
        hasValue: false,
      },
    ],
    '@oide-test/ui': [
      { key: 'uiSample.token', type: 'string', secret: true, description: 'API token', hasValue: false },
    ],
  };
  useExtensions.setState({ installed: [PREVIEW, SAMPLE], loaded: true, hostState: {}, panelRequest: null });
  useSettings.setState({
    settings: Settings.parse({
      claude: {},
      models: {},
      agents: { notifications: {} },
      permissions: {},
      ui: { accent: '#E8A0B4' },
    }),
  });
});
afterEach(() => cleanup());

describe('extension UI', () => {
  it('Focus inspector: a Preview tab with a sandboxed oide-ext:// iframe', async () => {
    render(<InspectorHost />);
    const tab = screen.getByRole('tab', { name: 'Preview' });
    fireEvent.click(tab);
    const frame = await waitFor(() => screen.getByTitle('Preview') as HTMLIFrameElement);
    expect(frame.tagName).toBe('IFRAME');
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame.getAttribute('src')).toBe('oide-ext://xabc/browserPreview.panel.html');
    expect(invoke).toHaveBeenCalledWith('extensions.uiUrl', {
      extension: '@oide/ext-browser-preview',
      kind: 'panel',
      id: 'browserPreview.panel',
    });
    // Switching away keeps the frame mounted (hidden), so the preview keeps its page.
    fireEvent.click(screen.getByRole('tab', { name: 'Plan' }));
    expect(screen.getByTitle('Preview')).toBeTruthy();
  });

  it('ctx.panels.open for this agent selects its inspector tab', async () => {
    act(() =>
      useRouter.setState({ route: { screen: 'focus', params: { agentId: 'a1' } }, back: [], forward: [] }),
    );
    render(<InspectorHost />);
    act(() => openPanel('@oide/ext-browser-preview', 'browserPreview.panel', 'a1'));
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: 'Preview' }).getAttribute('aria-selected')).toBe('true'),
    );
    expect(useExtensions.getState().panelRequest).toBeNull();
  });

  it('Settings › Extensions: plain fields save on blur; secrets go out once and are never shown', async () => {
    render(<ExtensionSettingsSection />);
    const url = await screen.findByRole('textbox', { name: 'browserPreview.defaultUrl' });
    expect((url as HTMLInputElement).value).toBe('http://localhost:3000');
    fireEvent.change(url, { target: { value: 'http://localhost:5173' } });
    fireEvent.blur(url);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('extensions.setSetting', {
        id: '@oide/ext-browser-preview',
        key: 'browserPreview.defaultUrl',
        value: 'http://localhost:5173',
      }),
    );

    const token = screen.getByLabelText('uiSample.token') as HTMLInputElement;
    expect(token.type).toBe('password');
    fireEvent.change(token, { target: { value: 's3cret' } });
    fireEvent.keyDown(token, { key: 'Enter' });
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('extensions.setSetting', {
        id: '@oide-test/ui',
        key: 'uiSample.token',
        value: 's3cret',
      }),
    );
    await screen.findByText('Stored in keychain');
    expect((screen.getByLabelText('uiSample.token') as HTMLInputElement).value).toBe('');
    expect(document.body.textContent).not.toContain('s3cret');
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('extensions.setSetting', {
        id: '@oide-test/ui',
        key: 'uiSample.token',
        value: null,
      }),
    );
  });

  it('Review: deploy targets run with the agent', async () => {
    render(<DeployActions agent={agent} />);
    fireEvent.click(screen.getByRole('button', { name: 'Create preview deploy' }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('extensions.runDeployTarget', {
        extension: '@oide-test/ui',
        targetId: 'uiSample.deployPreview',
        agentId: 'a1',
      }),
    );
  });

  it('Appearance lists contributed themes and the chosen theme’s tokens are applied', async () => {
    render(<AppearanceSection settings={useSettings.getState().settings!} />);
    const radios = screen.getAllByRole('radio');
    expect(radios.map((r) => r.getAttribute('aria-label'))).toEqual(['Rose', 'Sky']);
    expect(radios[0]!.getAttribute('aria-checked')).toBe('true');
    applyTheme();
    expect(document.documentElement.style.getPropertyValue('--color-accent')).toBe('#E8A0B4');
    expect(document.documentElement.style.getPropertyValue('--color-on-accent')).toBe('#101010');
    fireEvent.click(radios[1]!);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('settings.update', { patch: { ui: { accent: '#88C0F0' } } }),
    );
    applyTheme();
    expect(document.documentElement.style.getPropertyValue('--color-accent')).toBe('#88C0F0');
    expect(document.documentElement.style.getPropertyValue('--color-on-accent')).toBe('');
  });
});
