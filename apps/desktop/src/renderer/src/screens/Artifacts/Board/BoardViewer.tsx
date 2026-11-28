/**
 * "Open" for a kanban board (ADR 0022): the Agent panel on the left (the board's own artifact agent,
 * which changes it with board_update), the columns in the middle and the open card on the right.
 *
 * Every change is a list of board operations sent with `artifacts.boardApply` and applied by main
 * under the artifact's lock, so a drag here and an agent's update never overwrite each other. The
 * change shows at once (applied locally first); main's answer replaces it, and a refusal puts the
 * board back and says why. Calls go one after another, in the order they were made. When an agent
 * changes the board, `artifacts.changed` reloads `detail` and the board follows.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { applyBoardOps, parseBoard, serializeBoard, type ArtifactMeta, type BoardOp, type BoardOpResult, type CommandOutput, type KanbanBoard } from '@oide/protocol';
import { Button, Dialog, Icon, Menu } from '@oide/ui';
import { ipcErrorMessage, oide } from '../../../lib/bridge';
import { plural } from '../../../lib/format';
import { useKeymapScope } from '../../../lib/useKeymap';
import { useAgents } from '../../../stores/agents';
import { toast } from '../../../stores/ui';
import { AgentPanel, AgentPanelStrip } from '../AgentPanel';
import { useArtifactFeedback } from '../feedbackStore';
import { authorLabel, relativeTime } from '../model';
import { filterCards } from './boardModel';
import { BoardSettings } from './BoardSettings';
import { BoardView } from './BoardView';
import { CardPanel } from './CardPanel';

type Detail = CommandOutput<'artifacts.get'>;

export interface BoardViewerProps {
  detail: Detail;
  projectName: string;
  onClose: () => void;
  onSaved: (meta: ArtifactMeta, content: string) => void;
  onRename: () => void;
  onDelete: () => void;
}

export function BoardViewer({ detail, projectName, onClose, onSaved, onRename, onDelete }: BoardViewerProps) {
  const { meta } = detail;
  const agents = useAgents((s) => s.byId);
  const agentTitle = (id: string) => agents[id]?.title;
  const panelOpen = useArtifactFeedback((s) => s.panelOpen);

  const saved = useMemo((): { board: KanbanBoard } | { error: string } => {
    try {
      return { board: parseBoard(detail.content) };
    } catch (err) {
      return { error: (err as Error).message };
    }
  }, [detail.content]);
  /** The board with changes not yet confirmed by main (null when everything is saved). */
  const [local, setLocal] = useState<KanbanBoard | null>(null);
  const pending = useRef(0);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const latest = useRef<KanbanBoard | null>(null);
  const board = local ?? ('board' in saved ? saved.board : null);
  latest.current = board;

  const [query, setQuery] = useState('');
  const [openCard, setOpenCard] = useState<string | null>(null);
  /** The open card has text typed and not saved (description or comment). */
  const cardDirty = useRef(false);
  const setCardDirty = useCallback((d: boolean) => {
    cardDirty.current = d;
  }, []);
  /** What to do once the user agreed to drop that text: open another card, close it, leave the board, start an agent. */
  const [leaving, setLeaving] = useState<{ run: () => void } | null>(null);
  const guard = (run: () => void) => (cardDirty.current ? setLeaving({ run }) : run());
  const goTo = (to: string | null) => {
    if (to !== openCard) guard(() => setOpenCard(to));
  };
  const close = () => guard(onClose);
  const [settings, setSettings] = useState(false);
  const [message, setMessage] = useState('');
  const announce = useCallback((m: string) => setMessage(m), []);

  const apply = useCallback(
    (ops: BoardOp[]): Promise<BoardOpResult[] | null> => {
      const current = latest.current;
      if (!current) return Promise.resolve(null);
      try {
        // Shown at once; the ids made here are stand-ins until main answers.
        setLocal(applyBoardOps(current, ops, { author: 'user' }).board);
      } catch (err) {
        toast((err as Error).message, 'error');
        return Promise.resolve(null);
      }
      pending.current++;
      const run = queue.current.then(async () => {
        try {
          const out = await oide.invoke('artifacts.boardApply', { id: meta.id, ops });
          onSaved(out.meta, serializeBoard(out.board));
          return out.results as BoardOpResult[];
        } catch (err) {
          toast(`Couldn't change the board: ${ipcErrorMessage(err)}`, 'error');
          return null;
        } finally {
          pending.current--;
          // The last answer in: show what main saved (the next detail), not the local guess.
          if (pending.current === 0) setLocal(null);
        }
      });
      queue.current = run.catch(() => undefined);
      return run;
    },
    [meta.id, onSaved],
  );

  // A card that is gone (deleted here, by an agent, or a restore) closes its panel.
  useEffect(() => {
    if (openCard && board && !board.cards.some((c) => c.id === openCard) && pending.current === 0) setOpenCard(null);
  }, [board, openCard]);

  useKeymapScope('artifact-viewer', {
    'view.back': () => {
      if (settings || leaving) return;
      if (openCard) goTo(null);
      else close();
    },
  });

  const addCard = async () => {
    if (!board) return;
    const res = await apply([{ op: 'add_card', title: 'Untitled', column: board.columns[0]!.id, index: 0 }]);
    const id = res?.[0]?.cardId;
    if (id) {
      goTo(id);
      announce(`Added a card to ${board.columns[0]!.name}. Its details are open.`);
    }
  };

  const cards = useMemo(() => (board ? filterCards(board, query) : []), [board, query]);
  // Cards shown but not saved yet (added here, waiting for main): their ids are stand-ins.
  const pendingIds = useMemo(() => {
    if (!local || !('board' in saved)) return new Set<string>();
    const known = new Set(saved.board.cards.map((c) => c.id));
    return new Set(local.cards.filter((c) => !known.has(c.id)).map((c) => c.id));
  }, [local, saved]);
  const card = board && openCard ? board.cards.find((c) => c.id === openCard) : undefined;
  const last = detail.versions[0];

  return (
    <section aria-label={`${meta.title} (open)`} className="flex-1 min-w-0 flex flex-col">
      <div className="flex items-center gap-3 px-5 py-3 border-b border-line bg-panel flex-wrap">
        <Button size={32} icon="chevron-left" onClick={close}>
          Artifacts
        </Button>
        <div className="flex flex-col gap-0.5 min-w-0">
          <h2 tabIndex={-1} className="m-0 text-[16px] font-semibold outline-none truncate">
            {meta.title}
          </h2>
          <span className="text-[12px] text-ink-3">
            Board · {projectName || 'Personal'} · v{meta.version}
            {board && ` · ${plural(board.cards.length, 'card')}`}
            {last && ` · last change by ${authorLabel(last.author, agentTitle)} ${relativeTime(last.ts)}`}
          </span>
        </div>
        <div className="flex-1" />
        <label className="flex items-center gap-1.5 h-8 px-2.5 rounded-md border border-line-3 bg-card text-ink-3 focus-within:border-accent">
          <Icon name="search" size={14} />
          <span className="sr-only">Search cards</span>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search cards"
            className="w-[180px] bg-transparent border-0 outline-none text-ink text-[12.5px] placeholder:text-ink-3"
          />
        </label>
        <Button size={32} icon="settings" onClick={() => setSettings(true)} disabled={!board}>
          Columns and properties
        </Button>
        <Button size={32} variant="primary" icon="plus" onClick={() => void addCard()} disabled={!board}>
          New card
        </Button>
        <Menu
          label={`More actions for ${meta.title}`}
          align="end"
          trigger={<Icon name="more" size={16} />}
          triggerClassName="h-8 w-8 rounded-md border border-line-3 text-ink-2 hover:bg-raised"
          items={[
            { id: 'rename', label: 'Rename', onSelect: onRename },
            { id: 'delete', label: 'Delete', danger: true, icon: 'trash', onSelect: onDelete },
          ]}
        />
      </div>
      <div role="status" aria-live="polite" className="sr-only">
        {message}
      </div>
      <div className="flex-1 min-h-0 flex">
        {panelOpen ? (
          <AgentPanel meta={meta} version={meta.version} onCollapse={() => useArtifactFeedback.getState().setPanelOpen(false)} />
        ) : (
          <AgentPanelStrip meta={meta} onExpand={() => useArtifactFeedback.getState().setPanelOpen(true)} />
        )}
        <main aria-label={`${meta.title} board`} className="flex-1 min-w-[360px] min-h-0 flex flex-col p-4">
          {board ? (
            <BoardView
              board={board}
              cards={cards}
              searching={query.trim() !== ''}
              pendingIds={pendingIds}
              selectedCardId={openCard}
              agents={agents}
              onOpenCard={goTo}
              apply={apply}
              announce={announce}
            />
          ) : (
            <div role="alert" className="max-w-[560px] rounded-lg border border-bad-line bg-bad-bg px-4 py-3 text-[12.5px] text-ink-2">
              <strong className="text-bad">Can't read this board.</strong> {'error' in saved ? saved.error : ''} Restore an earlier version from History in the
              Artifacts list.
            </div>
          )}
        </main>
        {board && card && (
          <CardPanel
            key={card.id}
            meta={meta}
            board={board}
            card={card}
            agents={agents}
            apply={apply}
            announce={announce}
            onClose={() => goTo(null)}
            guard={guard}
            onDirtyChange={setCardDirty}
            onEditProperties={() => setSettings(true)}
          />
        )}
      </div>
      {leaving && (
        <Dialog
          open
          onClose={() => setLeaving(null)}
          title="Discard what you typed?"
          width={420}
          description="The card has a description or comment you have not saved."
          footer={
            <>
              <Button size={32} variant="ghost" onClick={() => setLeaving(null)}>
                Keep editing
              </Button>
              <Button
                size={32}
                variant="danger"
                onClick={() => {
                  const l = leaving;
                  setLeaving(null);
                  cardDirty.current = false;
                  l.run();
                }}
              >
                Discard
              </Button>
            </>
          }
        />
      )}
      {settings && board && <BoardSettings board={board} apply={apply} onClose={() => setSettings(false)} />}
    </section>
  );
}
