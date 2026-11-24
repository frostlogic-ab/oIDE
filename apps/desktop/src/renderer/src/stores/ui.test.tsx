// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Toasts } from '../components/frame/Toasts';
import { MAX_TOASTS, retireStaleToasts, toast, useUi } from './ui';

const messages = () => useUi.getState().toasts.map((t) => t.message);

beforeEach(() => {
  vi.useFakeTimers();
  for (const t of useUi.getState().toasts) useUi.getState().dismissToast(t.id);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('toasts', () => {
  it('info and success leave after 5 s, warnings after 10 s, errors stay until dismissed', () => {
    toast('Saved', 'success');
    toast('Heads up', 'warning');
    toast('Broke', 'error');
    vi.advanceTimersByTime(5_001);
    expect(messages()).toEqual(['Heads up', 'Broke']);
    vi.advanceTimersByTime(5_000);
    expect(messages()).toEqual(['Broke']);
    vi.advanceTimersByTime(60_000);
    expect(messages()).toEqual(['Broke']);
  });

  it('dedupes a repeat (count, timer restarted) and keeps at most 3, dropping the oldest non-error first', () => {
    toast('Same', 'info');
    vi.advanceTimersByTime(4_000);
    toast('Same', 'info');
    expect(useUi.getState().toasts).toHaveLength(1);
    expect(useUi.getState().toasts[0]!.count).toBe(2);
    vi.advanceTimersByTime(4_000);
    expect(messages()).toEqual(['Same']);

    toast('Error A', 'error');
    toast('Two', 'info');
    toast('Three', 'info');
    expect(useUi.getState().toasts).toHaveLength(MAX_TOASTS);
    expect(messages()).toEqual(['Error A', 'Two', 'Three']);
  });

  it('a needs-permission toast is retired when its prompt resolves; a newer prompt replaces it', () => {
    const perm = (requestId: string) =>
      useUi.getState().pushToast({ level: 'warning', message: `Fix needs permission (${requestId})`, agentId: 'a1', kind: 'needs-permission', requestId, key: 'needs-permission:a1' });
    perm('r1');
    retireStaleToasts({ a1: { status: 'needs-permission', pendingPermission: { requestId: 'r1' } } });
    expect(messages()).toEqual(['Fix needs permission (r1)']);
    perm('r2');
    expect(messages()).toEqual(['Fix needs permission (r2)']);
    retireStaleToasts({ a1: { status: 'running' } });
    expect(messages()).toEqual([]);

    perm('r3');
    retireStaleToasts({}, false); // agents not loaded yet: keep it
    expect(messages()).toHaveLength(1);
    retireStaleToasts({}, true); // agent removed
    expect(messages()).toEqual([]);
  });

  it('renders in a polite live region at the bottom left; errors are alerts; hover holds the timer', () => {
    toast('Merged', 'info');
    toast('Push failed', 'error');
    render(<Toasts />);
    const region = screen.getByTestId('toasts');
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(region.className).toMatch(/left-\[calc\(var\(--spacing-rail\)\+16px\)\]/);
    expect(region.className).toMatch(/bottom-\[calc\(var\(--spacing-status\)\+12px\)\]/);
    expect(region.className).not.toMatch(/\bright-/);
    expect(screen.getByRole('alert').textContent).toContain('Push failed');

    const info = screen.getByRole('status');
    fireEvent.mouseEnter(info);
    act(() => void vi.advanceTimersByTime(20_000));
    expect(messages()).toContain('Merged');
    fireEvent.mouseLeave(info);
    act(() => void vi.advanceTimersByTime(5_001));
    expect(messages()).toEqual(['Push failed']);

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss: Push failed' }));
    expect(messages()).toEqual([]);
  });
});
