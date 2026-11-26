// @vitest-environment jsdom
import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReviewComment } from '@oide/protocol';
import { setupMockApp } from '../SourceControl/testing';
import { useAgents } from '../../stores/agents';
import { SummaryPanel } from './SummaryPanel';

afterEach(cleanup);

const comment = (id: string, sent = false): ReviewComment => ({ id, agentId: 'a-webhook', path: 'src/x.ts', line: 1, side: 'new', body: `Note ${id}`, sent, createdAt: 1 });

describe('SummaryPanel send feedback', () => {
  it('goes back to "Send N comments" when comments are added after a send, and cannot resend nothing', async () => {
    await setupMockApp();
    const agent = useAgents.getState().byId['a-webhook']!;
    const send = vi.fn(async () => {});
    let add: () => void = () => {};
    function Harness() {
      const [comments, setComments] = useState<ReviewComment[]>([comment('c1')]);
      add = () => setComments((p) => [...p, comment(`c${p.length + 1}`)]);
      return (
        <SummaryPanel
          agent={agent}
          comments={comments}
          onSendFeedback={async () => {
            await send();
            setComments((p) => p.map((c) => ({ ...c, sent: true })));
          }}
          onJump={() => {}}
        />
      );
    }
    render(<Harness />);

    fireEvent.click(screen.getByRole('button', { name: 'Send 1 comment to agent' }));
    await waitFor(() => expect(screen.getByText('Feedback sent · agent is revising')).toBeTruthy());
    const idle = screen.getByRole('button', { name: 'Send feedback to agent' }) as HTMLButtonElement;
    expect(idle.disabled).toBe(true);
    fireEvent.click(idle);
    expect(send).toHaveBeenCalledTimes(1);

    act(() => add());
    const again = screen.getByRole('button', { name: 'Send 1 comment to agent' }) as HTMLButtonElement;
    expect(again.disabled).toBe(false);
    expect(screen.queryByText('Feedback sent · agent is revising')).toBeNull();
  });
});
