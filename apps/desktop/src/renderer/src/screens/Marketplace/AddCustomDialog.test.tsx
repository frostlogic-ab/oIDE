// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { CustomServer, OideBridge, Project } from '@oide/protocol';
import { installFallbackBridge } from '../../lib/bridge';
import { AddCustomDialog } from './AddCustomDialog';

const projects: Project[] = [
  { id: 'oide', name: 'oide', path: '/code/oide', trusted: true, createdAt: 0 },
  { id: 'billing-api', name: 'billing-api', path: '/code/billing-api', trusted: true, createdAt: 0 },
];

const probe = {
  reached: true,
  transport: 'Streamable HTTP',
  serverName: 'Metrics API',
  serverVersion: '2.3',
  serverInfo: 'Metrics API v2.3',
  needsAuth: false,
  tools: [
    { name: 'metrics.query', description: 'Run a metrics query', readOnlyHint: true },
    { name: 'alerts.silence', description: 'Silence an alert', destructiveHint: true },
    { name: 'annotations.create', description: 'Mark a deploy on graphs' },
  ],
};

let invoke: ReturnType<typeof vi.fn>;

beforeEach(() => {
  invoke = vi.fn(async (command: string, input: unknown) => {
    switch (command) {
      case 'custom.scanImports':
        return [];
      case 'custom.probeUrl':
        return probe;
      case 'custom.save':
        return (input as { server: CustomServer }).server;
      default:
        throw new Error(`[not_implemented] ${command}`);
    }
  });
  installFallbackBridge({ invoke, on: () => () => {}, platform: 'win32' } as unknown as OideBridge);
});

afterEach(cleanup);

describe('Add custom › From a URL', () => {
  it('probes the URL, labels tools from annotations, and saves edited risk labels and on/off', async () => {
    const onSaved = vi.fn();
    const onClose = vi.fn();
    render(<AddCustomDialog projects={projects} onSaved={onSaved} onClose={onClose} />);

    fireEvent.change(screen.getByLabelText('MCP server URL'), { target: { value: 'https://mcp.example.com/mcp' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));

    await screen.findByText('Metrics API');
    expect(invoke).toHaveBeenCalledWith('custom.probeUrl', { url: 'https://mcp.example.com/mcp' });
    expect(screen.getByText(/Reached/)).toBeTruthy();
    expect(screen.getByText(/Streamable HTTP · server v2\.3/)).toBeTruthy();
    expect(screen.getByText('3 tools found · 3 turned on', { exact: false })).toBeTruthy();

    const list = screen.getByRole('list', { name: 'Tools agents can use' });
    const row = (name: string) => within(list).getByText(name).closest('li') as HTMLElement;
    // readOnlyHint → read only; destructiveHint → asks first; no hint → asks first.
    expect(within(row('metrics.query')).getByText('read only')).toBeTruthy();
    expect(within(row('alerts.silence')).getByText('asks first')).toBeTruthy();
    expect(within(row('annotations.create')).getByText('asks first')).toBeTruthy();

    // Click a label to flip it.
    fireEvent.click(within(row('annotations.create')).getByRole('button', { name: /annotations\.create: asks first/ }));
    expect(within(row('annotations.create')).getByText('read only')).toBeTruthy();
    fireEvent.click(within(row('metrics.query')).getByRole('button', { name: /metrics\.query: read only/ }));
    expect(within(row('metrics.query')).getByText('asks first')).toBeTruthy();

    // Turn one tool off.
    const silence = screen.getByRole('checkbox', { name: 'Allow alerts.silence' });
    fireEvent.click(silence);
    expect(silence.getAttribute('aria-checked')).toBe('false');
    expect(screen.getByText('3 tools found · 2 turned on', { exact: false })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Add tool' }));

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const saveCall = invoke.mock.calls.find(([c]) => c === 'custom.save');
    const { server, secrets } = saveCall![1] as { server: CustomServer; secrets: Record<string, string> };
    expect(secrets).toEqual({});
    expect(server).toMatchObject({
      name: 'Metrics-API',
      route: 'url',
      transport: { kind: 'http', url: 'https://mcp.example.com/mcp', auth: 'none' },
      savedTo: 'my-settings',
      allProjects: true,
      projects: ['oide', 'billing-api'],
      reviewed: false,
    });
    expect(server.tools).toEqual([
      { name: 'metrics.query', description: 'Run a metrics query', risk: 'ask', enabled: true },
      { name: 'alerts.silence', description: 'Silence an alert', risk: 'ask', enabled: false },
      { name: 'annotations.create', description: 'Mark a deploy on graphs', risk: 'read', enabled: true },
    ]);
    expect(onClose).toHaveBeenCalled();
  });

  it('shows the error when the server cannot be reached and keeps Add tool disabled', async () => {
    invoke.mockImplementation(async (command: string) =>
      command === 'custom.scanImports' ? [] : command === 'custom.probeUrl' ? { reached: false, needsAuth: false, tools: [], error: 'ECONNREFUSED' } : undefined,
    );
    render(<AddCustomDialog projects={projects} onSaved={vi.fn()} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('MCP server URL'), { target: { value: 'https://down.example/mcp' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect((await screen.findByRole('alert')).textContent).toContain('ECONNREFUSED');
    expect((screen.getByRole('button', { name: 'Add tool' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('sends a header token once and never renders it after saving', async () => {
    invoke.mockImplementation(async (command: string, input: unknown) => {
      if (command === 'custom.scanImports') return [];
      if (command === 'custom.probeUrl') return { ...probe, needsAuth: true };
      if (command === 'custom.save') return (input as { server: CustomServer }).server;
      if (command === 'custom.setHeaderToken') return { ok: true };
      throw new Error(`[not_implemented] ${command}`);
    });
    const { container } = render(<AddCustomDialog projects={projects} onSaved={vi.fn()} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('MCP server URL'), { target: { value: 'https://mcp.example.com/mcp' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Use a token instead' }));
    fireEvent.change(screen.getByLabelText('Token'), { target: { value: 'tok-SECRET-123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add tool' }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('custom.setHeaderToken', expect.objectContaining({ token: 'tok-SECRET-123', header: 'Authorization' })));
    const save = invoke.mock.calls.find(([c]) => c === 'custom.save')![1] as { server: CustomServer };
    expect(save.server.transport).toMatchObject({ kind: 'http', auth: 'header' });
    expect(container.innerHTML).not.toContain('tok-SECRET-123');
  });
});
