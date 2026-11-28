// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { SCREENS } from '../../screens/registry';
import { useUi } from '../../stores/ui';
import { Header } from './Header';

afterEach(() => {
  cleanup();
  useUi.getState().closeCommandBar();
});

describe('Header command-bar trigger', () => {
  it('shows the file-search trigger on Files and opens the command bar', () => {
    render(<Header def={SCREENS.files} />);
    const trigger = screen.getByRole('button', { name: /search files, run a command, or jump to a session/i });
    fireEvent.click(trigger);
    expect(useUi.getState().commandBar.open).toBe(true);
    expect(useUi.getState().commandBar.mode).toBe('commands');
  });

  it('keeps the agent wording on the Wall', () => {
    render(<Header def={SCREENS.wall} />);
    expect(screen.getByRole('button', { name: /spawn an agent, jump to a session, or run a command/i })).toBeTruthy();
  });

  it('shows no trigger on title screens that do not ask for one', () => {
    render(<Header def={SCREENS.settings} />);
    expect(screen.queryByRole('button', { name: /run a command/i })).toBeNull();
  });
});
