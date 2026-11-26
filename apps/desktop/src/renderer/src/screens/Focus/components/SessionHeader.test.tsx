// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentSummary } from '@oide/protocol';
import { LeadHeader } from './SessionHeader';

afterEach(cleanup);

const REASON = 'Its worktree was deleted, so this session cannot be resumed.';

function header(over: Record<string, unknown>) {
  const agent = AgentSummary.parse({ id: 'a-1', projectId: 'oide', title: 'Fix it', status: 'running', mode: 'auto', model: 'opus', branch: 'oide/fix-it', createdAt: 1, updatedAt: 2, ...over });
  const fns = { onPause: vi.fn(), onResume: vi.fn(), onStop: vi.fn() };
  render(<LeadHeader agent={agent} project="oide" now={10} modeShortcut="Shift+Tab" modes={[]} onSetMode={() => {}} onCompact={() => {}} onRawTerminal={() => {}} {...fns} />);
  return fns;
}

describe('LeadHeader Pause / Resume', () => {
  it('offers Pause while the agent is running', () => {
    const { onPause } = header({ status: 'running' });
    fireEvent.click(screen.getByRole('button', { name: /pause/i }));
    expect(onPause).toHaveBeenCalled();
  });

  it('shows a disabled Resume that explains itself when the session cannot be resumed', () => {
    const { onResume } = header({ status: 'stopped', resumeBlocked: REASON });
    expect(screen.queryByRole('button', { name: /pause/i })).toBeNull();
    const resume = screen.getByRole('button', { name: /resume/i });
    expect(resume.getAttribute('aria-disabled')).toBe('true');
    const tip = document.getElementById(resume.getAttribute('aria-describedby') ?? '');
    expect(tip?.getAttribute('role')).toBe('tooltip');
    expect(tip?.textContent).toBe(REASON);
    fireEvent.click(resume);
    expect(onResume).not.toHaveBeenCalled();
  });

  it('offers no Pause once there is nothing to pause', () => {
    for (const status of ['ready-for-review', 'has-question', 'done']) {
      header({ status });
      expect(screen.queryByRole('button', { name: /pause|resume/i })).toBeNull();
      cleanup();
    }
  });
});
