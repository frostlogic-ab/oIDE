// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FileDiff } from '@oide/protocol';
import { setupMockApp } from '../SourceControl/testing';
import { useAgents } from '../../stores/agents';
import { useArchive } from '../../stores/archive';
import { useRouter } from '../../stores/router';
import { parseHunks, reverseApply, sidesFromHunks } from './diff';
import ReviewScreen from './index';
import { UnifiedDiff } from './UnifiedDiff';

afterEach(cleanup);

const PATCH = ['@@ -1,4 +1,5 @@', ' a', '-b', '+B', '+c', ' d', ' e', '@@ -10,2 +11,2 @@ fn x()', ' x', '-y', '+Y', ''].join('\n');
const FILE: FileDiff = { path: 'src/x.ts', status: 'modified', additions: 3, deletions: 2, binary: false, patch: PATCH };

describe('diff model', () => {
  it('numbers lines from the hunk headers', () => {
    const [h1, h2] = parseHunks(PATCH);
    expect(h1!.lines.map((l) => [l.kind, l.oldLine, l.newLine])).toEqual([
      ['context', 1, 1],
      ['del', 2, undefined],
      ['add', undefined, 2],
      ['add', undefined, 3],
      ['context', 3, 4],
      ['context', 4, 5],
    ]);
    expect(h2!.section).toBe('fn x()');
    expect(h2!.lines.map((l) => l.newLine ?? `-${l.oldLine}`)).toEqual([11, '-11', 12]);
  });

  it('reverse-applies a patch to rebuild the original file', () => {
    const modified = ['a', 'B', 'c', 'd', 'e', '6', '7', '8', '9', '10', 'x', 'Y', ''].join('\n');
    expect(reverseApply(modified, parseHunks(PATCH))).toBe(['a', 'b', 'd', 'e', '6', '7', '8', '9', '10', 'x', 'y', ''].join('\n'));
    expect(reverseApply('nope\n', parseHunks(PATCH))).toBeUndefined();
    const sides = sidesFromHunks(parseHunks(PATCH));
    expect(sides.modified.split('\n')[10]).toBe('x'); // padded so line 11 is line 11
  });
});

describe('UnifiedDiff', () => {
  it('renders hunk headers, new-side line numbers and add/del rows with the canvas colours', () => {
    const { container } = render(
      <UnifiedDiff file={FILE} comments={[]} composer={null} onOpenComposer={() => {}} onCancelComposer={() => {}} onAddComment={() => {}} />,
    );
    expect(screen.getByText('@@ -1,4 +1,5 @@')).toBeTruthy();
    expect(screen.getByText('@@ -10,2 +11,2 @@ fn x()')).toBeTruthy();
    const adds = container.querySelectorAll<HTMLElement>('[data-kind="add"]');
    const dels = container.querySelectorAll<HTMLElement>('[data-kind="del"]');
    expect(adds).toHaveLength(3);
    expect(dels).toHaveLength(2);
    expect(adds[0]!.style.background).toBe('rgb(18, 38, 29)'); // #12261D
    expect(adds[0]!.style.color).toBe('rgb(168, 224, 198)'); // #A8E0C6
    expect(dels[0]!.style.background).toBe('rgb(42, 22, 24)'); // #2A1618
    expect(adds[0]!.textContent).toBe('2+ B');
    // removed lines have no number in the single column
    expect(within(dels[0]!).getByRole('button', { name: 'Comment on removed line 2' }).textContent).toBe('');
    expect(screen.getByRole('button', { name: 'Comment on line 12' }).textContent).toBe('12');
  });

  it('a comment on a removed line sits under that removed line, not under the new line with the same number', () => {
    const at = (id: string, line: number, side: 'old' | 'new', body: string) => ({ id, agentId: 'a', path: 'src/x.ts', line, side, body, sent: false, createdAt: 1 });
    const { container } = render(
      <UnifiedDiff
        file={FILE}
        comments={[at('c-old', 2, 'old', 'Keep b'), at('c-new', 2, 'new', 'Why B?')]}
        composer={null}
        onOpenComposer={() => {}}
        onCancelComposer={() => {}}
        onAddComment={() => {}}
      />,
    );
    const delRow = container.querySelector<HTMLElement>('[data-kind="del"]')!.closest<HTMLElement>('[data-row]')!;
    const addRow = container.querySelector<HTMLElement>('[data-kind="add"]')!.closest<HTMLElement>('[data-row]')!;
    expect(within(delRow).getByRole('note', { name: 'Your comment on removed line 2' }).textContent).toContain('Keep b');
    expect(within(addRow).getByRole('note', { name: 'Your comment on line 2' }).textContent).toContain('Why B?');
    expect(within(delRow).queryByText('Why B?')).toBeNull();
  });

  it('clicking a line opens the composer for that line', () => {
    const open = vi.fn();
    render(<UnifiedDiff file={FILE} comments={[]} composer={null} onOpenComposer={open} onCancelComposer={() => {}} onAddComment={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Comment on line 3' }));
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ path: 'src/x.ts', line: 3, removed: false }));
  });
});

describe('Review screen for an agent that is not on the Wall', () => {
  it('an archived (merged) agent says so and opens read-only in Focus, instead of "gone"', async () => {
    await setupMockApp({ screen: 'review', params: { agentId: 'a-webhook' } });
    const live = useAgents.getState().byId['a-webhook']!;
    useAgents.setState((s) => {
      const { 'a-webhook': _drop, ...byId } = s.byId;
      return { byId };
    });
    useArchive.setState({ byId: { 'a-webhook': { ...live, archived: { at: 1, reason: 'merged', worktreeRemoved: false } } } });
    render(<ReviewScreen />);
    expect(await screen.findByText(`${live.title} was merged and archived`)).toBeTruthy();
    expect(screen.queryByText('This agent is gone')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Open in Focus' }));
    expect(useRouter.getState().route).toEqual({ screen: 'focus', params: { agentId: 'a-webhook' } });
    useArchive.setState({ byId: {} });
  });

  it('an unknown agent still says it is gone', async () => {
    await setupMockApp({ screen: 'review', params: { agentId: 'a-nope' } });
    useArchive.setState({ byId: {} });
    render(<ReviewScreen />);
    expect(await screen.findByText('This agent is gone')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Open in Focus' })).toBeNull();
  });
});

describe('Review screen', () => {
  it('adds a comment through review.addComment and sends feedback', async () => {
    const { invoke } = await setupMockApp({ screen: 'review', params: { agentId: 'a-webhook' } });
    render(<ReviewScreen />);

    // file list and the agent's submission
    expect(await screen.findByRole('heading', { name: '8 files changed' })).toBeTruthy();
    expect(screen.getByText('Tests · 18 passed')).toBeTruthy();
    expect(screen.getByText('Migration not run against staging')).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: 'Viewed' })).toHaveProperty('checked', true);

    fireEvent.click(await screen.findByRole('button', { name: 'Comment on line 7' }));
    expect(screen.getByText('Your comment on line 7 · goes to the agent')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Comment for the agent'), { target: { value: 'Name the attempt parameter' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add to feedback' }));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('review.addComment', { agentId: 'a-webhook', path: 'src/webhooks/retry.ts', line: 7, side: 'new', body: 'Name the attempt parameter' }),
    );
    expect(await screen.findByRole('heading', { name: 'Your feedback · 2 comments' })).toBeTruthy();
    expect(screen.queryByLabelText('Comment for the agent')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /^Send \d+ comments? to agent$/ }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('review.sendFeedback', { agentId: 'a-webhook' }));
    expect(await screen.findByText('Feedback sent · agent is revising')).toBeTruthy();
  });

  it('a comment on a removed line is saved with side "old" and shown under that line', async () => {
    const { invoke } = await setupMockApp({ screen: 'review', params: { agentId: 'a-webhook' } });
    render(<ReviewScreen />);
    const removed = (await screen.findAllByRole('button', { name: /^Comment on removed line \d+$/ }))[0]!;
    const line = Number(/(\d+)$/.exec(removed.getAttribute('aria-label')!)![1]);
    fireEvent.click(removed);
    fireEvent.change(screen.getByLabelText('Comment for the agent'), { target: { value: 'Keep this' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add to feedback' }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('review.addComment', expect.objectContaining({ line, side: 'old', body: 'Keep this' })));
    expect(await screen.findByRole('note', { name: `Your comment on removed line ${line}` })).toBeTruthy();
  });

  describe('comment drafts', () => {
    const textbox = () => screen.getByLabelText('Comment for the agent') as HTMLTextAreaElement;

    /** Opens line 7, types a draft, then opens another line; returns the other line's button label. */
    async function draftOnLine7ThenOpenAnother() {
      const mock = await setupMockApp({ screen: 'review', params: { agentId: 'a-webhook' } });
      render(<ReviewScreen />);
      fireEvent.click(await screen.findByRole('button', { name: 'Comment on line 7' }));
      fireEvent.change(textbox(), { target: { value: 'half written thought' } });
      const other = (await screen.findAllByRole('button', { name: /^Comment on line \d+$/ }))[0]!;
      fireEvent.click(other);
      return { ...mock, other };
    }

    it('keeps the text when another line is clicked, marks the line, and restores it on return', async () => {
      await draftOnLine7ThenOpenAnother();
      // the other line's composer is empty and the first line is marked as having a draft
      expect(textbox().value).toBe('');
      expect(screen.getAllByLabelText('Comment for the agent')).toHaveLength(1);
      fireEvent.click(screen.getByRole('button', { name: 'Comment on line 7 (draft)' }));
      expect(textbox().value).toBe('half written thought');
      expect(screen.getByText('Your comment on line 7 · goes to the agent')).toBeTruthy();
    });

    it('Cancel discards the draft', async () => {
      await draftOnLine7ThenOpenAnother();
      fireEvent.click(screen.getByRole('button', { name: 'Comment on line 7 (draft)' }));
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(screen.queryByLabelText('Comment for the agent')).toBeNull();
      expect(screen.queryByRole('button', { name: 'Comment on line 7 (draft)' })).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Comment on line 7' }));
      expect(textbox().value).toBe('');
    });

    it('Esc discards the draft', async () => {
      await draftOnLine7ThenOpenAnother();
      fireEvent.click(screen.getByRole('button', { name: 'Comment on line 7 (draft)' }));
      fireEvent.keyDown(textbox(), { key: 'Escape' });
      expect(screen.queryByRole('button', { name: 'Comment on line 7 (draft)' })).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Comment on line 7' }));
      expect(textbox().value).toBe('');
    });

    it('a successful add clears the draft', async () => {
      const { invoke } = await draftOnLine7ThenOpenAnother();
      fireEvent.click(screen.getByRole('button', { name: 'Comment on line 7 (draft)' }));
      fireEvent.click(screen.getByRole('button', { name: 'Add to feedback' }));
      await waitFor(() => expect(invoke).toHaveBeenCalledWith('review.addComment', expect.objectContaining({ line: 7, body: 'half written thought' })));
      await waitFor(() => expect(screen.queryByLabelText('Comment for the agent')).toBeNull());
      expect(screen.queryByRole('button', { name: 'Comment on line 7 (draft)' })).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Comment on line 7' }));
      expect(textbox().value).toBe('');
    });
  });

  it('toggles Viewed through review.setViewed', async () => {
    const { invoke } = await setupMockApp({ screen: 'review', params: { agentId: 'a-webhook' } });
    render(<ReviewScreen />);
    const box = await screen.findByRole('checkbox', { name: 'Viewed' });
    await waitFor(() => expect(box).toHaveProperty('checked', true));
    fireEvent.click(box);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('review.setViewed', { agentId: 'a-webhook', path: 'src/webhooks/retry.ts', viewed: false }));
  });

  it('with nothing to push, offers Archive session instead of a pull request or a merge', async () => {
    const { invoke, real } = await setupMockApp({ screen: 'review', params: { agentId: 'a-webhook' } });
    invoke.mockImplementation((async (command: string, input: unknown) => {
      if (command === 'git.diff') return [];
      const out = await real(command as never, input as never);
      if (command === 'git.worktrees') return (out as Array<{ agentId?: string }>).map((w) => (w.agentId === 'a-webhook' ? { ...w, ahead: 0, pr: undefined } : w));
      return out;
    }) as never);
    render(<ReviewScreen />);
    const archive = await screen.findByRole('button', { name: 'Archive session' });
    expect(screen.queryByRole('button', { name: /pull request/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Merge worktree into/ })).toBeNull();
    expect(screen.getByText(/Nothing to push: this worktree has no changes or commits against main/)).toBeTruthy();
    fireEvent.click(archive);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('agents.archive', { agentId: 'a-webhook' }));
    await waitFor(() => expect(useRouter.getState().route.screen).toBe('wall'));
  });

  it('when git.diff fails, shows an error with Try again instead of "No changes yet", and retry reloads', async () => {
    const { invoke, real } = await setupMockApp({ screen: 'review', params: { agentId: 'a-webhook' } });
    let failing = true;
    invoke.mockImplementation((async (command: string, input: unknown) => {
      if (command === 'git.diff' && failing) throw new Error('[git_failed] fatal: bad revision');
      return real(command as never, input as never);
    }) as never);
    render(<ReviewScreen />);

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText("Couldn't load the changes")).toBeTruthy();
    expect(within(alert).getByText('fatal: bad revision')).toBeTruthy();
    expect(screen.queryByText('No changes yet')).toBeNull();

    failing = false;
    const diffCalls = () => invoke.mock.calls.filter(([c]) => c === 'git.diff').length;
    const before = diffCalls();
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: '8 files changed' })).toBeTruthy();
    expect(diffCalls()).toBe(before + 1);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText("Couldn't load the changes")).toBeNull();
  });

  /** a-webhook with an open PR #21 and the given push state. */
  async function withOpenPr(push: { unpushed?: number; uncommitted?: number }) {
    const app = await setupMockApp({ screen: 'review', params: { agentId: 'a-webhook' } });
    const pr = { state: 'open', number: 21, url: 'https://github.com/you/billing-api/pull/21' };
    app.invoke.mockImplementation((async (command: string, input: unknown) => {
      if (command === 'git.pushToPr') return { url: pr.url, number: 21, state: 'open', committed: true, pushed: 3 };
      const out = await app.real(command as never, input as never);
      if (command === 'git.worktrees') return (out as Array<{ agentId?: string }>).map((w) => (w.agentId === 'a-webhook' ? { ...w, pr, ...push } : w));
      return out;
    }) as never);
    render(<ReviewScreen />);
    return app;
  }

  it('after the PR is open, offers Push to pull request for new commits and uncommitted files', async () => {
    const { invoke } = await withOpenPr({ unpushed: 2, uncommitted: 1 });
    const push = await screen.findByRole('button', { name: 'Push to pull request #21' });
    expect(screen.getByText('Not on pull request #21 yet: 2 new commits and 1 uncommitted file. oIDE commits the files for the agent first.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'View pull request #21' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Open pull request' })).toBeNull();
    fireEvent.click(push);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('git.pushToPr', { agentId: 'a-webhook' }));
  });

  it('a PR that has everything shows only View pull request', async () => {
    await withOpenPr({ unpushed: 0, uncommitted: 0 });
    expect(await screen.findByText('Pull request #21 has everything in this worktree.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'View pull request #21' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Push to pull request/ })).toBeNull();
  });

  it('does not offer Push when the push state is unknown and nothing is uncommitted', async () => {
    await withOpenPr({ unpushed: undefined, uncommitted: 0 });
    expect(await screen.findByRole('button', { name: 'View pull request #21' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Push to pull request/ })).toBeNull();
    expect(screen.queryByText(/has everything in this worktree/)).toBeNull();
  });

  it('keeps Open pull request when the branch has commits to push', async () => {
    await setupMockApp({ screen: 'review', params: { agentId: 'a-webhook' } });
    render(<ReviewScreen />);
    expect(await screen.findByRole('heading', { name: '8 files changed' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Archive session' })).toBeNull();
    expect(screen.getByRole('button', { name: /Merge worktree into .* locally/ })).toBeTruthy();
  });
});
