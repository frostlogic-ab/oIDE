import { useCallback, useEffect, useState } from 'react';
import type { FileDiff, ReviewComment } from '@oide/protocol';
import { invokeOr, ipcErrorMessage, oide } from '../../lib/bridge';

/** Diff, comments and Viewed state for one agent's worktree (git.diff, review.*). */
export function useReview(agentId: string | undefined) {
  const [files, setFiles] = useState<FileDiff[]>([]);
  const [comments, setComments] = useState<ReviewComment[]>([]);
  const [viewed, setViewed] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  const reload = useCallback(async () => {
    if (!agentId) return;
    setLoading(true);
    try {
      const [d, c, v] = await Promise.all([
        oide.invoke('git.diff', { agentId }),
        invokeOr('review.comments', { agentId }, [] as ReviewComment[]),
        invokeOr('review.viewed', { agentId }, [] as string[]),
      ]);
      setFiles(d);
      setComments(c);
      setViewed(new Set(v));
      setError(undefined);
    } catch (err) {
      setError(ipcErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const addComment = useCallback(
    async (path: string, line: number | undefined, body: string, side: 'old' | 'new' = 'new') => {
      if (!agentId) return;
      const c = await oide.invoke('review.addComment', { agentId, path, line, side, body });
      setComments((prev) => [...prev, c]);
      return c;
    },
    [agentId],
  );

  const deleteComment = useCallback(async (commentId: string) => {
    await oide.invoke('review.deleteComment', { commentId });
    setComments((prev) => prev.filter((c) => c.id !== commentId));
  }, []);

  const toggleViewed = useCallback(
    async (path: string, on: boolean) => {
      if (!agentId) return;
      setViewed((prev) => {
        const next = new Set(prev);
        if (on) next.add(path);
        else next.delete(path);
        return next;
      });
      try {
        await oide.invoke('review.setViewed', { agentId, path, viewed: on });
      } catch {
        /* keep the local tick; it is a reading aid */
      }
    },
    [agentId],
  );

  const sendFeedback = useCallback(async () => {
    if (!agentId) return;
    await oide.invoke('review.sendFeedback', { agentId });
    setComments((prev) => prev.map((c) => ({ ...c, sent: true })));
  }, [agentId]);

  return { files, comments, viewed, loading, error, reload, addComment, deleteComment, toggleViewed, sendFeedback };
}
