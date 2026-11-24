import { describe, expect, it } from 'vitest';
import { agents } from './fixtures';
import { diffsByAgent, worktrees } from './scm';

/**
 * The Wall tile, Source control row and Ready to review read `AgentSummary.diff` / `WorktreeInfo.diff`;
 * Review sums the parsed patches. In the app both come from the same git diff, so the mock must
 * agree too, or the dev build shows two totals for one agent (design review R1).
 */
describe('mock diff totals', () => {
  it('a ready-for-review agent has the same totals everywhere', () => {
    for (const agent of agents.filter((a) => a.status === 'ready-for-review')) {
      const files = diffsByAgent[agent.id];
      expect(files, agent.id).toBeDefined();
      const sum = files!.reduce((t, f) => ({ files: t.files + 1, additions: t.additions + f.additions, deletions: t.deletions + f.deletions }), { files: 0, additions: 0, deletions: 0 });
      expect(agent.diff).toEqual(sum);
      const wt = Object.values(worktrees)
        .flat()
        .find((w) => w.agentId === agent.id);
      expect(wt?.diff).toEqual(sum);
    }
  });
});
