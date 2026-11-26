// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Project, type OideBridge } from '@oide/protocol';
import { installFallbackBridge } from '../../lib/bridge';
import { NewArtifactDialog } from './Dialogs';

const now = Date.now();
const projects = ['oide', 'billing-api'].map((id) => Project.parse({ id, name: id, path: `/code/${id}`, trusted: true, createdAt: now }));

beforeEach(() => {
  installFallbackBridge({
    invoke: vi.fn(async (command: string) => {
      throw new Error(`[not_implemented] ${command}`);
    }) as unknown as OideBridge['invoke'],
    on: (() => () => {}) as OideBridge['on'],
    platform: 'win32',
  });
});
afterEach(cleanup);

/** The scrim is the dialog's parent: a mousedown whose target is the scrim itself. */
const scrim = () => screen.getByRole('dialog').parentElement as HTMLElement;

function setup() {
  const onClose = vi.fn();
  render(<NewArtifactDialog open onClose={onClose} projects={projects} defaultProjectId="oide" onCreated={() => {}} />);
  return { onClose };
}

describe('NewArtifactDialog scrim dismissal', () => {
  it('closes on a scrim click while the form is pristine', () => {
    const { onClose } = setup();
    fireEvent.mouseDown(scrim());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps the dialog open on a scrim click once a name is typed, and Esc, x and Cancel still close', () => {
    const { onClose } = setup();
    fireEvent.click(screen.getByRole('radio', { name: 'Blank' }));
    fireEvent.change(screen.getByRole('textbox', { name: /Title/ }), { target: { value: 'Checkout flow' } });
    fireEvent.mouseDown(scrim());
    expect(onClose).not.toHaveBeenCalled();
    expect((screen.getByRole('textbox', { name: /Title/ }) as HTMLInputElement).value).toBe('Checkout flow');

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it('keeps the dialog open after the project is changed, and closes again once it is back at the default', () => {
    const { onClose } = setup();
    fireEvent.change(screen.getByRole('combobox', { name: 'Project' }), { target: { value: 'billing-api' } });
    fireEvent.mouseDown(scrim());
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole('combobox', { name: 'Project' }), { target: { value: 'oide' } });
    fireEvent.mouseDown(scrim());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps the dialog open on a scrim click after a link is typed', () => {
    const { onClose } = setup();
    fireEvent.change(screen.getByRole('textbox', { name: 'Link' }), { target: { value: 'https://claude.ai/public/artifacts/abc' } });
    fireEvent.mouseDown(scrim());
    expect(onClose).not.toHaveBeenCalled();
  });

  it('keeps the dialog open on a scrim click when files were dropped in', () => {
    const onClose = vi.fn();
    render(
      <NewArtifactDialog
        open
        onClose={onClose}
        projects={projects}
        defaultProjectId="oide"
        onCreated={() => {}}
        initialDrop={{ files: [{ path: 'C:\\Downloads\\index.html', name: 'index.html' }], images: [], problems: [] }}
      />,
    );
    expect(screen.getByText('1 file')).toBeTruthy();
    fireEvent.mouseDown(scrim());
    expect(onClose).not.toHaveBeenCalled();
  });
});
