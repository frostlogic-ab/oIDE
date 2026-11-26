// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommitDialog } from './CommitDialog';
import { setupMockApp } from './testing';

afterEach(cleanup);

const commit = { sha: 'abc1234def', message: 'Fix it', author: 'me', ts: Date.now() };

function dialog(onClose: () => void, open = true) {
  return <CommitDialog open={open} onClose={onClose} projectId="oide" projectName="oide" branch="main" files={['a.ts', 'b.ts']} />;
}

describe('CommitDialog', () => {
  it('stays open while the commit is in flight, then closes when it resolves', async () => {
    const { invoke, real } = await setupMockApp();
    let finish!: () => void;
    invoke.mockImplementation(((command: string, input: never) =>
      command === 'git.commit'
        ? new Promise((resolve) => {
            finish = () => resolve(commit);
          })
        : real(command as never, input)) as never);
    const onClose = vi.fn();
    render(dialog(onClose));

    fireEvent.change(screen.getByRole('textbox', { name: 'Commit message' }), { target: { value: 'Fix it' } });
    fireEvent.click(screen.getByRole('button', { name: 'Commit' }));
    const committing = await screen.findByRole('button', { name: 'Committing…' });
    expect((committing as HTMLButtonElement).disabled).toBe(true);

    const cancel = screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement;
    expect(cancel.disabled).toBe(true);
    fireEvent.click(cancel);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    fireEvent.mouseDown(screen.getByRole('dialog').parentElement!);
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => finish());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('stays open and shows the error when the commit fails, and closing works again', async () => {
    const { invoke, real } = await setupMockApp();
    invoke.mockImplementation(((command: string, input: never) =>
      command === 'git.commit' ? Promise.reject(new Error('nothing to commit')) : real(command as never, input)) as never);
    const onClose = vi.fn();
    render(dialog(onClose));

    fireEvent.change(screen.getByRole('textbox', { name: 'Commit message' }), { target: { value: 'Fix it' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Commit' }));
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(await screen.findByText(/nothing to commit/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps a typed message when closed and reopened', async () => {
    await setupMockApp();
    const { rerender } = render(dialog(() => {}));
    fireEvent.change(screen.getByRole('textbox', { name: 'Commit message' }), { target: { value: 'Half-written' } });
    rerender(dialog(() => {}, false));
    rerender(dialog(() => {}, true));
    expect((screen.getByRole('textbox', { name: 'Commit message' }) as HTMLTextAreaElement).value).toBe('Half-written');
  });
});
