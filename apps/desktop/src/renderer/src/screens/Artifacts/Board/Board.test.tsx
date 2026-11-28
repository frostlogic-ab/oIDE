// @vitest-environment jsdom
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { AgentSummary, applyBoardOps, ArtifactMeta, defaultBoard, parseBoard, serializeBoard, type BoardOp, type CommandOutput, type KanbanBoard, type OideBridge } from '@oide/protocol';
import { installFallbackBridge } from '../../../lib/bridge';
import { useAgents } from '../../../stores/agents';
import { useRouter } from '../../../stores/router';
import { BoardViewer } from './BoardViewer';

type Detail = CommandOutput<'artifacts.get'>;
const now = Date.now();

let board: KanbanBoard;
let version: number;
const calls: BoardOp[][] = [];
let refuse: string | null = null;

const meta = () => ArtifactMeta.parse({ id: 'art-b', slug: 'backlog', title: 'Product Backlog', kind: 'board', projectId: 'oide', location: 'repo', version, entry: 'board.json', createdAt: now, updatedAt: now });
const detailNow = (): Detail => ({ meta: meta(), content: serializeBoard(board), uses: [], versions: [{ version, ts: now, author: 'user' }] });

const invoke = vi.fn(async (command: string, input: unknown): Promise<unknown> => {
  if (command === 'artifacts.boardApply') {
    const { ops } = input as { ops: BoardOp[] };
    calls.push(ops);
    if (refuse) throw new Error(`[invalid_input] ${refuse}`);
    const out = applyBoardOps(board, ops, { author: 'user' });
    board = out.board;
    version++;
    return { meta: meta(), board, results: out.results };
  }
  throw new Error(`[not_implemented] ${command}`);
});
const bridge: OideBridge = { invoke: invoke as unknown as OideBridge['invoke'], on: (() => () => undefined) as OideBridge['on'], platform: 'win32' };

function Harness() {
  const [detail, setDetail] = useState<Detail>(detailNow);
  return <BoardViewer detail={detail} projectName="oide" onClose={() => undefined} onSaved={(m, content) => setDetail((d) => ({ ...d, meta: m, content }))} onRename={() => undefined} onDelete={() => undefined} />;
}

beforeEach(() => {
  installFallbackBridge(bridge);
  let n = 0;
  const newId = (p: string) => `${p}_${++n}`;
  board = applyBoardOps(
    defaultBoard(newId),
    [
      { op: 'add_card', title: 'Fix login', column: 'Approved', props: { Priority: 'P1' }, body: 'Users are logged out.' },
      { op: 'add_card', title: 'Dark mode', column: 'Approved' },
    ],
    { author: 'user', newId },
  ).board;
  version = 3;
  calls.length = 0;
  refuse = null;
  invoke.mockClear();
  useAgents.setState({ byId: {} });
  useRouter.setState({ route: { screen: 'artifacts', params: { artifactId: 'art-b' } }, back: [], forward: [] });
});
afterEach(cleanup);

const column = (name: RegExp) => screen.getByRole('listitem', { name });

describe('BoardViewer (ADR 0022)', () => {
  it('shows the columns with their counts and the cards with their property chips', () => {
    render(<Harness />);
    expect(screen.getByRole('heading', { name: 'Product Backlog' })).toBeTruthy();
    const approved = column(/^Approved, 2 cards/);
    expect(within(approved).getByRole('button', { name: 'Fix login' })).toBeTruthy();
    expect(within(approved).getByText('P1')).toBeTruthy();
    expect(column(/^Proposed, 0 cards/)).toBeTruthy();
  });

  it('moves a card to the next column with Alt+ArrowRight, saved as one operation, and keeps focus on it', async () => {
    render(<Harness />);
    const card = screen.getByRole('button', { name: 'Fix login' });
    card.focus();
    fireEvent.keyDown(card, { key: 'ArrowRight', altKey: true });
    await waitFor(() => expect(within(column(/^In progress, 1 card/)).getByRole('button', { name: 'Fix login' })).toBeTruthy());
    expect(calls).toEqual([[{ op: 'move_card', cardId: board.cards.find((c) => c.title === 'Fix login')!.id, column: board.columns[2]!.id }]]);
    await waitFor(() => expect(document.activeElement?.textContent).toBe('Fix login'));
    expect(screen.getByRole('status').textContent).toMatch(/Moved Fix login to In progress/);
  });

  it('reorders within a column with Alt+ArrowUp', async () => {
    render(<Harness />);
    fireEvent.keyDown(screen.getByRole('button', { name: 'Dark mode' }), { key: 'ArrowUp', altKey: true });
    await waitFor(() => expect(within(column(/^Approved/)).getAllByRole('button').filter((b) => b.hasAttribute('data-card-open')).map((b) => b.textContent)).toEqual(['Dark mode', 'Fix login']));
  });

  it('adds a card in a column', async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'New card in Proposed' }));
    const box = screen.getByLabelText('Title of the new card in Proposed');
    fireEvent.change(box, { target: { value: 'Backups' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(within(column(/^Proposed, 1 card/)).getByRole('button', { name: 'Backups' })).toBeTruthy());
    expect(calls[0]).toEqual([{ op: 'add_card', title: 'Backups', column: board.columns[0]!.id }]);
  });

  it('a refused change puts the board back and says why', async () => {
    refuse = 'No card with id c_9.';
    render(<Harness />);
    fireEvent.keyDown(screen.getByRole('button', { name: 'Fix login' }), { key: 'ArrowRight', altKey: true });
    await waitFor(() => expect(calls).toHaveLength(1));
    await waitFor(() => expect(within(column(/^Approved, 2 cards/)).getByRole('button', { name: 'Fix login' })).toBeTruthy());
  });

  it('the card panel edits properties, comments, and Start an agent opens Spawn with the ticket and the card', async () => {
    useAgents.setState({ byId: { a1: AgentSummary.parse({ id: 'a1', projectId: 'oide', title: 'Login agent', status: 'running', mode: 'default', model: 'sonnet', createdAt: now, updatedAt: now }) } });
    board = applyBoardOps(board, [{ op: 'link_agent', cardId: board.cards[0]!.id, agentId: 'a1' }], { author: 'user' }).board;
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Fix login' }));
    const panel = screen.getByRole('complementary', { name: 'Card' });
    expect(within(panel).getByRole('link', { name: 'Login agent' })).toBeTruthy();

    fireEvent.change(within(panel).getByRole('combobox', { name: 'Effort' }), { target: { value: board.properties[1]!.options![2]!.id } });
    await waitFor(() => expect(calls.at(-1)).toEqual([{ op: 'update_card', cardId: board.cards[0]!.id, props: { [board.properties[1]!.id]: board.properties[1]!.options![2]!.id } }]));

    fireEvent.change(within(panel).getByRole('textbox', { name: 'Add a comment' }), { target: { value: 'Please add a test' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Comment' }));
    await waitFor(() => expect(within(panel).getByText('Please add a test')).toBeTruthy());
    expect(parseBoard(serializeBoard(board)).cards[0]!.comments[0]).toMatchObject({ author: 'user', text: 'Please add a test' });

    fireEvent.click(within(panel).getByRole('button', { name: 'Start an agent' }));
    const route = useRouter.getState().route;
    expect(route.screen).toBe('spawn');
    const params = route.params as { projectId?: string; goal?: string; card?: { boardId: string; cardId: string }; context?: unknown[] };
    expect(params).toMatchObject({ projectId: 'oide', card: { boardId: 'art-b', cardId: board.cards[0]!.id }, context: [{ kind: 'artifact', id: 'art-b', title: 'Product Backlog' }] });
    expect(params.goal).toMatch(/^# Fix login/);
    expect(params.goal).toContain('Users are logged out.');
  });

  it('Columns and properties adds a property', async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Columns and properties' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'New property name' }), { target: { value: 'Due' } });
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Type' }), { target: { value: 'date' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add property' }));
    await waitFor(() => expect(calls.at(-1)).toEqual([{ op: 'add_property', name: 'Due', type: 'date' }]));
    await act(async () => undefined);
    expect(within(dialog).getByRole('textbox', { name: 'Name of property Due' })).toBeTruthy();
  });
});
