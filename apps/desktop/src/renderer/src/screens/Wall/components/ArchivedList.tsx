import { memo, useEffect, useRef, useState, type MouseEvent } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { AgentSummary, ArchiveReason, Scope } from '@oide/protocol';
import { Badge, Button, DiffStat, EmptyState, IconButton, LinkButton, Spinner, type BadgeTone } from '@oide/ui';
import { projectName, useProjects } from '../../../stores/projects';
import { navigate } from '../../../stores/router';
import { ARCHIVE_REASON_LABEL, deleteAgentPermanently, formatCost, formatEnded, unarchiveAgent, useArchive } from '../../../stores/archive';
import { branchLabel } from '../logic';
import { useWall } from '../wallState';

/**
 * Wall › Archived: finished, merged, discarded and hand-archived agents, newest first, searchable
 * by title, scoped like the Wall. Virtualized (TanStack Virtual) and paged from main
 * (`agents.listArchived`), so a long history costs one screenful of rows.
 */
const ROW_HEIGHT = 64;
const GAP = 8;

const REASON_TONE: Record<ArchiveReason, BadgeTone> = {
  merged: 'ok',
  completed: 'review',
  discarded: 'neutral',
  'archived-by-user': 'neutral',
};

export function ArchivedList({ scope }: { scope: Scope }) {
  const query = useWall((s) => s.archiveQuery);
  const items = useArchive((s) => s.items);
  const total = useArchive((s) => s.total);
  const loading = useArchive((s) => s.loading);
  const loaded = useArchive((s) => s.loaded);
  const error = useArchive((s) => s.error);
  const hasMore = useArchive((s) => Boolean(s.nextCursor));
  const heldScope = useArchive((s) => s.scope);
  const heldQuery = useArchive((s) => s.query);

  // Load the first page for this scope; a new query waits for typing to pause.
  useEffect(() => {
    const t = setTimeout(() => void useArchive.getState().load(scope, query), query === useArchive.getState().query ? 0 : 200);
    return () => clearTimeout(t);
  }, [scope, query]);

  const stale = heldScope !== scope || heldQuery.trim() !== query.trim();
  const scrollRef = useRef<HTMLDivElement>(null);
  const v = useVirtualizer({
    count: stale ? 0 : items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT + GAP,
    getItemKey: (i) => items[i]!.id,
    overscan: 6,
    // jsdom (tests) has no layout: render a screenful before the first measure.
    initialRect: { width: 900, height: 720 },
  });
  const virtualItems = v.getVirtualItems();
  const last = virtualItems[virtualItems.length - 1];

  // Near the end: the next page.
  useEffect(() => {
    if (!stale && hasMore && !loading && last && last.index >= items.length - 8) void useArchive.getState().loadMore();
  }, [stale, hasMore, loading, last, items.length]);

  if (error && !items.length) {
    return (
      <div role="alert" className="flex items-center gap-3 text-[12.5px] text-bad py-6">
        Could not load archived agents: {error}
        <Button onClick={() => void useArchive.getState().load(scope, query)}>Retry</Button>
      </div>
    );
  }
  if (!loaded || (stale && loading)) {
    return (
      <div className="flex items-center gap-2 text-[12.5px] text-ink-3 py-6">
        <Spinner size={14} /> Loading archived agents…
      </div>
    );
  }
  if (!stale && !items.length) {
    return query.trim() ? (
      <div className="flex items-center gap-3 text-[12.5px] text-ink-3 py-6">
        No archived agents match “{query.trim()}”.
        <Button onClick={() => useWall.getState().setArchiveQuery('')}>Clear search</Button>
      </div>
    ) : (
      <EmptyState
        icon="archive"
        title="No archived agents"
        description="Agents you merge, discard or archive show up here with their transcript, branch and changes. Unarchive one to put it back on the Wall."
        className="flex-1"
      />
    );
  }

  return (
    <section aria-label="Archived agents" className="flex-1 min-h-0 flex flex-col gap-2">
      <div className="flex items-center gap-2 text-[12px] text-ink-3" aria-live="polite">
        <span>
          {total} archived agent{total === 1 ? '' : 's'}
          {query.trim() ? ` matching “${query.trim()}”` : ''}
        </span>
        <span aria-hidden="true">·</span>
        <span>Most recent first</span>
        {loading && <Spinner size={12} label="Loading more" />}
      </div>
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto -mx-1 px-1" data-testid="archived-scroll">
        <ul role="list" aria-label="Archived agents, most recent first" className="relative m-0 p-0 list-none" style={{ height: v.getTotalSize() }}>
          {virtualItems.map((row) => {
            const a = items[row.index]!;
            return (
              <li key={row.key} data-index={row.index} className="absolute left-0 right-0" style={{ top: row.start, height: ROW_HEIGHT }}>
                <ArchivedRow agent={a} />
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}

const ArchivedRow = memo(function ArchivedRow({ agent }: { agent: AgentSummary }) {
  const project = useProjects((s) => projectName(s.list, agent.projectId));
  const [busy, setBusy] = useState(false);
  const info = agent.archived!;
  const cost = formatCost(agent.costUsd);
  const open = (e: MouseEvent) => {
    e.preventDefault();
    navigate('focus', { agentId: agent.id });
  };
  return (
    <article
      aria-label={`${agent.title}, ${ARCHIVE_REASON_LABEL[info.reason]}`}
      data-agent-id={agent.id}
      className="h-full box-border flex items-center gap-3 px-3.5 rounded-[10px] border border-line bg-card min-w-0"
    >
      <div className="flex flex-col gap-1 flex-1 min-w-0">
        <div className="flex items-center gap-2 min-w-0">
          <h2 className="m-0 text-[13.5px] font-semibold truncate min-w-0" title={agent.title}>
            {agent.title}
          </h2>
          <Badge tone={REASON_TONE[info.reason]} title={info.mergeCommit ? `Merge commit ${info.mergeCommit}` : undefined}>
            {ARCHIVE_REASON_LABEL[info.reason]}
          </Badge>
        </div>
        <div className="flex items-center gap-2 text-[11.5px] text-ink-3 min-w-0 whitespace-nowrap overflow-hidden">
          <span className="font-mono truncate min-w-[6ch]" title={agent.branch ?? 'project folder'}>
            {project} · {branchLabel(agent)}
          </span>
          <span aria-hidden="true">·</span>
          <span className="shrink-0" title={new Date(info.at).toLocaleString()}>
            Ended {formatEnded(info.at)}
          </span>
          {info.mergeCommit && (
            <>
              <span aria-hidden="true">·</span>
              <span className="font-mono shrink-0" title={`Merge commit ${info.mergeCommit}`}>
                {info.mergeCommit.slice(0, 7)}
              </span>
            </>
          )}
          {info.worktreeRemoved && (
            <>
              <span aria-hidden="true">·</span>
              <span className="shrink-0">worktree deleted</span>
            </>
          )}
        </div>
      </div>
      <div className="flex items-center gap-3 shrink-0 text-[12px] text-ink-3">
        {agent.diff ? <DiffStat additions={agent.diff.additions} deletions={agent.diff.deletions} files={agent.diff.files} /> : <span>No changes</span>}
        {cost && (
          <span className="font-mono text-ink-2 min-w-[5ch] text-right" title="Cost the Claude Code CLI reported for this agent">
            {cost}
          </span>
        )}
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        <LinkButton href={`#focus/${agent.id}`} onClick={open} aria-label={`Open ${agent.title}`}>
          Open
        </LinkButton>
        <Button
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            await unarchiveAgent(agent.id, agent.title);
            setBusy(false);
          }}
          aria-label={`Unarchive ${agent.title}`}
        >
          Unarchive
        </Button>
        <IconButton
          icon="trash"
          aria-label={`Delete ${agent.title} permanently`}
          title="Delete permanently"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            await deleteAgentPermanently(agent.id);
            setBusy(false);
          }}
        />
      </div>
    </article>
  );
});
