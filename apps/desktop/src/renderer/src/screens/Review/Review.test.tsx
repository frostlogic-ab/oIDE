// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FileDiff } from '@oide/protocol';
import { setupMockApp } from '../SourceControl/testing';
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

  it('clicking a line opens the composer for that line', () => {
    const open = vi.fn();
    render(<UnifiedDiff file={FILE} comments={[]} composer={null} onOpenComposer={open} onCancelComposer={() => {}} onAddComment={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Comment on line 3' }));
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ path: 'src/x.ts', line: 3, removed: false }));
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
      expect(invoke).toHaveBeenCalledWith('review.addComment', { agentId: 'a-webhook', path: 'src/webhooks/retry.ts', line: 7, body: 'Name the attempt parameter' }),
    );
    expect(await screen.findByRole('heading', { name: 'Your feedback · 2 comments' })).toBeTruthy();
    expect(screen.queryByLabelText('Comment for the agent')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Send feedback to agent' }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('review.sendFeedback', { agentId: 'a-webhook' }));
    expect(await screen.findByRole('button', { name: 'Feedback sent · agent is revising' })).toBeTruthy();
  });

  it('toggles Viewed through review.setViewed', async () => {
    const { invoke } = await setupMockApp({ screen: 'review', params: { agentId: 'a-webhook' } });
    render(<ReviewScreen />);
    const box = await screen.findByRole('checkbox', { name: 'Viewed' });
    await waitFor(() => expect(box).toHaveProperty('checked', true));
    fireEvent.click(box);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('review.setViewed', { agentId: 'a-webhook', path: 'src/webhooks/retry.ts', viewed: false }));
  });
});
