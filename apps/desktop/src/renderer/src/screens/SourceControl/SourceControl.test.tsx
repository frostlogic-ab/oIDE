// @vitest-environment jsdom
import { act, cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useScope } from '../../stores/scope';
import SourceControlScreen from './index';
import { ProjectCard } from './ProjectCard';
import { baseLabel, commitAuthor, prView, syncView } from './model';
import { setupMockApp } from './testing';

afterEach(cleanup);

describe('Source control screen', () => {
  it('shows one card per project, and scope switching filters them', async () => {
    const { invoke } = await setupMockApp({ screen: 'source-control', params: {} });
    render(<SourceControlScreen />);

    expect(await screen.findByRole('region', { name: 'oide' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'billing-api' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'docs-site' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: 'All projects' })).toBeTruthy();
    // canvas data: sync state with the matching action, worktree rows, the heads-up
    const oide = screen.getByRole('region', { name: 'oide' });
    expect(await within(oide).findByText('2 behind origin')).toBeTruthy();
    expect(within(oide).getByRole('button', { name: 'Pull oide' })).toBeTruthy();
    expect(within(oide).getByText('Build the window shell layout')).toBeTruthy();
    expect(screen.getByText('Two worktrees change the same file')).toBeTruthy();
    expect(screen.getByText('docs-site has 1 unpushed commit')).toBeTruthy();

    await act(async () => {
      await useScope.getState().setScope('billing-api');
    });
    expect(screen.queryByRole('region', { name: 'oide' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'docs-site' })).toBeNull();
    expect(screen.getByRole('region', { name: 'billing-api' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: 'billing-api' })).toBeTruthy();
    expect(screen.getByText(/1 project · 2 agent worktrees/)).toBeTruthy();
    // the heads-up about oide is out of scope now
    expect(screen.queryByText('Two worktrees change the same file')).toBeNull();
    expect(invoke).toHaveBeenCalledWith('scope.set', { scope: 'billing-api' });
  });
});

describe('Source control while git state loads (m2)', () => {
  it('says it is loading instead of "0 agent worktrees" and "No commits yet"', () => {
    const project = { id: 'p1', name: 'oide', path: '/r/oide', trusted: true, createdAt: 0 };
    const props = { project, agents: {}, open: true, onToggle: () => {}, logOpen: true, onToggleLog: () => {} };
    const { rerender } = render(<ProjectCard {...props} git={{ worktrees: [], log: [], overlaps: [], loading: true }} />);
    expect(screen.getByText('Loading agent worktrees…')).toBeTruthy();
    expect(screen.getByText('Loading commits…')).toBeTruthy();
    expect(screen.queryByText('No commits yet.')).toBeNull();
    expect(screen.queryByText(/Agent worktrees · 0/)).toBeNull();
    rerender(<ProjectCard {...props} git={{ worktrees: [], log: [], overlaps: [], loading: false, loadedAt: 1 }} />);
    expect(screen.getByText('No commits yet.')).toBeTruthy();
    expect(screen.getByText('Agent worktrees · 0')).toBeTruthy();
    expect(screen.queryByText('Loading agent worktrees…')).toBeNull();
  });

  it('shows "0 files" without a dangling separator when a worktree has no changes', () => {
    const project = { id: 'p1', name: 'oide', path: '/r/oide', trusted: true, createdAt: 0 };
    const wt = (branch: string, diff: { files: number; additions: number; deletions: number }) => ({
      projectId: 'p1', path: `/w/${branch}`, branch, baseRef: 'main', ahead: 0, behind: 0, diff, changedFiles: [], orphaned: false,
    });
    render(
      <ProjectCard
        project={project}
        agents={{}}
        open
        onToggle={() => {}}
        logOpen={false}
        onToggleLog={() => {}}
        git={{ worktrees: [wt('oide/empty', { files: 0, additions: 0, deletions: 0 }), wt('oide/one', { files: 1, additions: 2, deletions: 0 })], log: [], overlaps: [], loading: false, loadedAt: 1 }}
      />,
    );
    const counts = screen.getAllByText(/\bfiles?\b/, { selector: 'span.font-mono' }).map((e) => e.textContent?.replace(/\s+/g, ' ').trim());
    expect(counts).toEqual(['0 files', '1 file · +2']);
  });
});

describe('Source control labels', () => {
  it('maps sync state to the label and action from the canvas', () => {
    expect(syncView({ branch: 'main', upstream: 'origin/main', ahead: 0, behind: 2, dirtyFiles: [] })).toMatchObject({ label: '2 behind origin', action: 'Pull' });
    expect(syncView({ branch: 'main', upstream: 'origin/main', ahead: 1, behind: 0, dirtyFiles: [] })).toMatchObject({ label: '1 to push', action: 'Push' });
    expect(syncView({ branch: 'main', upstream: 'origin/main', ahead: 0, behind: 0, dirtyFiles: [] })).toMatchObject({ label: 'Up to date', action: 'Fetch' });
  });

  it('labels bases, PRs and commit authors', () => {
    expect(baseLabel({ baseRef: 'main', behind: 2 })).toBe('from main · 2 behind');
    expect(baseLabel({ baseRef: 'origin/main', behind: 0 })).toBe('from main · up to date');
    expect(prView(undefined, 'ready-for-review').label).toBe('Ready to open');
    expect(prView(undefined, 'running').label).toBe('No PR');
    expect(prView({ state: 'draft', number: 18 }, 'running').label).toBe('Draft PR #18');
    expect(commitAuthor({ message: 'Scaffold the desktop shell', agent: 'Scaffold' })).toBe('Scaffold agent');
    expect(commitAuthor({ message: 'Merge oide/status-bar: plan usage meters' })).toBe('You, from an agent');
    expect(commitAuthor({ message: 'Bump Stripe SDK' })).toBe('You');
  });
});
