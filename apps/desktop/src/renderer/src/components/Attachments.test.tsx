// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MessageAttachment } from '@oide/protocol';
import { Dialog } from '@oide/ui';

vi.mock('../lib/bridge', () => ({ oide: { invoke: vi.fn() }, invokeOr: async (_c: string, _a: unknown, fallback: unknown) => fallback, ipcErrorMessage: (e: unknown) => String(e) }));

const { AttachmentTray, useAttachments } = await import('./Attachments');
const { ContextChips } = await import('../screens/Spawn/components/ContextChips');

/** Clicking a pending image's thumbnail opens it at full size (Spawn context row and prompt trays). */

const png: MessageAttachment = { kind: 'image', mediaType: 'image/png', dataBase64: 'iVBORw0KGgo=', name: 'Pasted image 7.png' };
const file: MessageAttachment = { kind: 'file', path: '/tmp/notes.txt', name: 'notes.txt', size: 12 };

function Harness({ where }: { where: 'tray' | 'spawn' }) {
  const atts = useAttachments();
  const [open, setOpen] = useState(true);
  useEffect(() => atts.add([png, file]), []); // eslint-disable-line react-hooks/exhaustive-deps
  if (where === 'tray') return <AttachmentTray state={atts} />;
  // The Spawn dialog: the preview opens on top of it.
  return (
    <Dialog open={open} onClose={() => setOpen(false)} title="New agent" position="top">
      <ContextChips value={[]} onChange={() => {}} projectId="p1" attachments={atts} />
    </Dialog>
  );
}

afterEach(cleanup);

describe('image attachment preview', () => {
  it('opens a pending image from the prompt tray and closes it', async () => {
    render(<Harness where="tray" />);
    await act(async () => {});
    expect(screen.queryByRole('button', { name: 'Preview notes.txt' })).toBeNull(); // files have no preview
    fireEvent.click(screen.getByRole('button', { name: 'Preview Pasted image 7.png' }));
    const dialog = screen.getByRole('dialog', { name: 'Pasted image 7.png' });
    expect(dialog.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,iVBORw0KGgo=');
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('opens from the Spawn context chips, and Esc closes only the preview', async () => {
    render(<Harness where="spawn" />);
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'Preview Pasted image 7.png' }));
    const preview = screen.getByRole('dialog', { name: 'Pasted image 7.png' });
    fireEvent.keyDown(preview, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Pasted image 7.png' })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'New agent' })).toBeTruthy();
  });
});
