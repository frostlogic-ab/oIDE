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

const scrimOf = () => screen.getByRole('dialog').parentElement as HTMLElement;

describe('Add custom › scrim click', () => {
  it('closes on a scrim press while the form is pristine', () => {
    const onClose = vi.fn();
    render(<AddCustomDialog projects={projects} onSaved={vi.fn()} onClose={onClose} />);
    fireEvent.mouseDown(scrimOf());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps what was typed: a scrim press does nothing once something is entered, Cancel and Esc still close', () => {
    const onClose = vi.fn();
    render(<AddCustomDialog projects={projects} onSaved={vi.fn()} onClose={onClose} />);
    fireEvent.change(screen.getByLabelText('MCP server URL'), { target: { value: 'https://mcp.example.com/mcp' } });
    fireEvent.mouseDown(scrimOf());
    expect(onClose).not.toHaveBeenCalled();
    expect((screen.getByLabelText('MCP server URL') as HTMLInputElement).value).toBe('https://mcp.example.com/mcp');

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('ignores a press that starts inside the dialog even when the form is pristine', () => {
    const onClose = vi.fn();
    render(<AddCustomDialog projects={projects} onSaved={vi.fn()} onClose={onClose} />);
    fireEvent.mouseDown(screen.getByLabelText('MCP server URL'));
    fireEvent.mouseUp(scrimOf());
    fireEvent.click(scrimOf());
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('Add custom › Local command environment variables', () => {
  const openCmd = () => {
    render(<AddCustomDialog projects={projects} onSaved={vi.fn()} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Local command or JSON' }));
  };

  it('removes a row and keeps the others', () => {
    openCmd();
    fireEvent.click(screen.getByRole('button', { name: '+ Add variable' }));
    fireEvent.change(screen.getByLabelText('Variable 1 name'), { target: { value: 'ONE' } });
    fireEvent.change(screen.getByLabelText('Variable 2 name'), { target: { value: 'TWO' } });

    fireEvent.click(screen.getByRole('button', { name: 'Remove variable ONE' }));

    expect(screen.queryByLabelText('Variable 2 name')).toBeNull();
    expect((screen.getByLabelText('Variable 1 name') as HTMLInputElement).value).toBe('TWO');
  });

  it('leaves one empty row when the last one is removed, labelled by position when it has no name', () => {
    openCmd();
    fireEvent.change(screen.getByLabelText('Variable 1 name'), { target: { value: 'KEY' } });
    fireEvent.change(screen.getByLabelText('Variable 1 value'), { target: { value: 'secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Remove variable KEY' }));

    expect((screen.getByLabelText('Variable 1 name') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('Variable 1 value') as HTMLInputElement).value).toBe('');
    expect(screen.getAllByRole('button', { name: /^Remove variable/ })).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Remove variable 1' })).toBeTruthy();
  });
});

describe('Add custom › Extension from folder', () => {
  it('does not claim to accept drops: dropping says so and does not open the folder picker', () => {
    render(<AddCustomDialog projects={projects} onSaved={vi.fn()} onClose={vi.fn()} initialTab="ext" />);
    expect(screen.queryByText(/Drop an extension folder/)).toBeNull();
    const zone = screen.getByText('Choose an extension folder').parentElement as HTMLElement;
    fireEvent.drop(zone, { dataTransfer: { files: [] } });
    expect(screen.getByRole('status').textContent).toMatch(/not supported/);
    expect(invoke).not.toHaveBeenCalledWith('extensions.addFromFolder', expect.anything());
  });

  it('opens the picker from the button', async () => {
    invoke.mockImplementation(async (command: string) => (command === 'custom.scanImports' ? [] : null));
    render(<AddCustomDialog projects={projects} onSaved={vi.fn()} onClose={vi.fn()} initialTab="ext" />);
    fireEvent.click(screen.getByRole('button', { name: 'Choose a folder…' }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('extensions.addFromFolder', { devMode: true }));
  });
});
