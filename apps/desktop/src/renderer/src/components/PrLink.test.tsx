// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentPrInfo } from '@oide/protocol';

const invoke = vi.fn(async () => ({ ok: true }));
vi.mock('../lib/bridge', () => ({ oide: { invoke: (...a: unknown[]) => invoke(...(a as [])) }, ipcErrorMessage: (e: unknown) => String(e) }));

const { PrLink } = await import('./PrLink');

/** "View PR #12", its state, and the CI indicator (running / passed / failed) that opens the Checks tab. */

const URL = 'https://github.com/o/r/pull/12';
const pr = (checks?: AgentPrInfo['checks'], state: AgentPrInfo['state'] = 'open'): AgentPrInfo => ({ number: 12, url: URL, state, ...(checks ? { checks } : {}) });

afterEach(() => {
  cleanup();
  invoke.mockClear();
});

describe('PrLink CI checks', () => {
  it('shows running checks as finished/total and opens the Checks tab', () => {
    render(<PrLink pr={pr({ state: 'pending', total: 9, completed: 7, failed: 0 })} />);
    const ci = screen.getByRole('button', { name: /^CI running: 7 of 9 checks finished\./ });
    expect(ci.textContent).toBe('7/9');
    fireEvent.click(ci);
    expect(invoke).toHaveBeenCalledWith('shell.openExternal', { url: `${URL}/checks` });
  });

  it('says how many failed, and that all passed', () => {
    render(<PrLink pr={pr({ state: 'failure', total: 9, completed: 9, failed: 2 })} />);
    expect(screen.getByRole('button', { name: /^CI failed: 2 of 9 checks failed\./ }).textContent).toBe('2 failed');
    cleanup();
    render(<PrLink pr={pr({ state: 'success', total: 9, completed: 9, failed: 0 })} />);
    expect(screen.getByRole('button', { name: /^CI passed: all 9 checks passed\./ }).textContent).toBe('9/9');
  });

  it('shows nothing without checks, or once the PR is merged or closed', () => {
    render(<PrLink pr={pr()} />);
    expect(screen.queryByRole('button', { name: /^CI / })).toBeNull();
    cleanup();
    render(<PrLink pr={pr({ state: 'success', total: 1, completed: 1, failed: 0 }, 'merged')} />);
    expect(screen.queryByRole('button', { name: /^CI / })).toBeNull();
  });
});
