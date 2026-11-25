/**
 * Dev mock for the Wall and Spawn (docs/wiki/raw/design/Main.dc.html, Spawn.dc.html).
 *
 * The default fixtures (./fixtures.ts) are the six agents drawn on the canvas. Add `?wall=<mode>`
 * to the dev:web URL to see the other tile states and the empty states:
 *   ?wall=states       + queued, rate-limited, error, paused and Bypass-mode tiles
 *   ?wall=empty        projects but no agents
 *   ?wall=no-projects  nothing open yet
 * `agents.spawn` creates queued agents that start (up to Settings › Agents › Max running) and
 * stream a few activity lines; `projects.open` answers null (no folder picker in a browser).
 * Every value goes through the protocol schemas.
 */
import { AgentSpec, AgentSummary, type CommandInput, type CommandName, type CommandOutput, type EventName, type EventPayload, type Project, type Settings } from '@oide/protocol';

const MIN = 60_000;
const now = Date.now();
const ago = (m: number) => now - m * MIN;
const tokens = (input: number) => ({ input, output: Math.round(input / 6), cacheRead: 0, cacheCreation: 0 });

export type WallMockMode = 'design' | 'states' | 'empty' | 'no-projects';

export function wallMockMode(search = typeof location !== 'undefined' ? location.search : ''): WallMockMode {
  const v = new URLSearchParams(search).get('wall');
  return v === 'states' || v === 'empty' || v === 'no-projects' ? v : 'design';
}

/** Extra tiles for `?wall=states`: every state the Wall can draw beyond the canvas six. */
export const stateAgents: AgentSummary[] = [
  {
    id: 'a-queued',
    projectId: 'oide',
    title: 'Add keyboard shortcuts to Settings',
    status: 'queued',
    mode: 'auto',
    model: 'opus',
    branch: 'oide/settings-keys',
    activity: [],
    contextUsed: 0,
    createdAt: ago(1),
  },
  {
    id: 'a-ratelimit',
    projectId: 'billing-api',
    title: 'Migrate invoices to the new tax API',
    status: 'rate-limited',
    mode: 'auto',
    model: 'opus',
    branch: 'billing-api/tax-api',
    activity: ['Read src/tax/*.ts (5)', 'Edit src/tax/client.ts +44 −19'],
    contextUsed: 96_000,
    diff: { files: 3, additions: 61, deletions: 22 },
    rateLimitResetAt: now + 61 * MIN,
    subagents: [{ id: 'sa-tax', agentId: 'a-ratelimit', name: 'Tax fixtures', task: 'Record API fixtures.', tier: 'simple', model: 'haiku', effort: 'low', status: 'stopped', startedAt: ago(9), endedAt: ago(4) }],
    createdAt: ago(33),
  },
  {
    id: 'a-error',
    projectId: 'docs-site',
    title: 'Add a search page',
    status: 'error',
    mode: 'acceptEdits',
    model: 'sonnet',
    branch: 'docs-site/search',
    activity: ['Bash pnpm add @docsearch/react', '⎿ exit 1'],
    contextUsed: 31_000,
    exitCode: 1,
    error: 'API Error: 401 · Please run /login',
    createdAt: ago(12),
  },
  {
    id: 'a-bypass',
    projectId: 'oide',
    title: 'Regenerate the protocol JSON schemas',
    status: 'running',
    mode: 'bypassPermissions',
    model: 'haiku',
    branch: 'oide/gen-schemas',
    activity: ['Bash pnpm --filter @oide/store gen:schemas', '⎿ wrote 14 files', 'Writing schema/index.json…'],
    contextUsed: 22_000,
    diff: { files: 14, additions: 380, deletions: 371 },
    createdAt: ago(3),
  },
  {
    id: 'a-paused',
    projectId: 'billing-api',
    title: 'Speed up the CI pipeline',
    status: 'paused',
    mode: 'plan',
    model: 'sonnet',
    branch: 'billing-api/ci-speed',
    activity: ['Read .github/workflows/ci.yml', 'Thinking about caching pnpm store'],
    contextUsed: 40_000,
    createdAt: ago(50),
  },
].map((a) => AgentSummary.parse({ ...a, contextWindow: 200_000, usage: tokens(a.contextUsed), updatedAt: now }));

export function seedAgents(base: AgentSummary[], mode: WallMockMode): AgentSummary[] {
  if (mode === 'empty' || mode === 'no-projects') return [];
  return mode === 'states' ? [...base, ...stateAgents] : base;
}

/** Wall › Archived in dev:web: three finished agents built from the canvas agents' projects. */
export function seedArchived(base: AgentSummary[], now = Date.now()): AgentSummary[] {
  const p0 = base[0]?.projectId ?? 'oide';
  const p1 = base.find((a) => a.projectId !== p0)?.projectId ?? p0;
  const mk = (id: string, projectId: string, title: string, ago: number, archived: NonNullable<AgentSummary['archived']>, extra: Partial<AgentSummary> = {}) =>
    AgentSummary.parse({ id, projectId, title, status: 'ready-for-review', mode: 'acceptEdits', model: 'claude-sonnet-5-5', branch: `oide/${id.slice(4)}`, worktreePath: `/mock/worktrees/${id}`, createdAt: now - ago - 3_600_000, updatedAt: now - ago, archived: { ...archived, at: now - ago }, ...extra });
  return [
    mk('arc-status-bar', p0, 'Status bar usage meters', 2 * 3_600_000, { at: 0, reason: 'merged', mergeCommit: '4f9c2a1e7b3d', worktreeRemoved: true }, { diff: { files: 4, additions: 182, deletions: 37 }, costUsd: 1.84, pr: { number: 42, url: 'https://github.com/you/oide/pull/42', state: 'merged' } }),
    mk('arc-retry-spike', p1, 'Spike: retry webhook deliveries', 26 * 3_600_000, { at: 0, reason: 'discarded', worktreeRemoved: true }, { diff: { files: 2, additions: 64, deletions: 5 }, costUsd: 0.31, status: 'has-question' }),
    mk('arc-docs-pass', p0, 'Docs pass on the extension API', 5 * 24 * 3_600_000, { at: 0, reason: 'archived-by-user', worktreeRemoved: false }, { costUsd: 0.07, status: 'stopped' }),
  ];
}

export function seedProjects(base: Project[], mode: WallMockMode): Project[] {
  return mode === 'no-projects' ? [] : base;
}

type Handlers = { [K in CommandName]?: (input: CommandInput<K>) => CommandOutput<K> | Promise<CommandOutput<K>> };

export interface WallMockDeps {
  agents: Map<string, AgentSummary>;
  emit: <K extends EventName>(event: K, payload: EventPayload<K>) => void;
  getSettings: () => Settings;
}

const SCRIPT = ['Read 6 files', 'Search "StatusBar"', 'Edit src/shell/StatusBar.tsx +24 −3', 'Bash npm run typecheck', '⎿ 0 errors', 'Writing UsagePanel.tsx…'];

function slug(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .split('-')
      .slice(0, 3)
      .join('-') || 'agent'
  );
}

/** `agents.spawn` and `projects.open` for the mock bridge. */
export function wallHandlers({ agents, emit, getSettings }: WallMockDeps): Handlers {
  let seq = 0;
  const set = (a: AgentSummary) => {
    agents.set(a.id, a);
    emit('agents.summary', a);
  };
  const runningCount = () => [...agents.values()].filter((a) => ['starting', 'running', 'needs-permission'].includes(a.status)).length;

  const start = (id: string) => {
    const a = agents.get(id);
    if (!a || a.status !== 'queued') return;
    if (runningCount() >= getSettings().agents.maxRunning) return; // stays queued, like the supervisor
    set({ ...a, status: 'starting', updatedAt: Date.now() });
    let step = 0;
    const tick = setInterval(() => {
      const cur = agents.get(id);
      if (!cur || !['starting', 'running'].includes(cur.status)) return clearInterval(tick);
      const line = SCRIPT[step++];
      if (!line) return clearInterval(tick);
      set({
        ...cur,
        status: 'running',
        activity: [...cur.activity, line].slice(-6),
        contextUsed: cur.contextUsed + 9_000,
        diff: step > 2 ? { files: 1, additions: 24, deletions: 3 } : cur.diff,
        updatedAt: Date.now(),
      });
    }, 1500);
  };

  return {
    'agents.spawn': (input) => {
      const spec = AgentSpec.parse(input); // already parsed by the bridge; this applies the output type
      const group = spec.attempts > 1 ? (spec.attemptGroup ?? `grp-${Date.now()}`) : undefined;
      const created: AgentSummary[] = [];
      for (let i = 0; i < spec.attempts; i++) {
        const id = `a-new-${Date.now().toString(36)}-${seq++}`;
        const base = slug(spec.title);
        const a = AgentSummary.parse({
          id,
          projectId: spec.projectId,
          title: spec.attempts > 1 ? `${spec.title} (attempt ${i + 1})` : spec.title,
          status: 'queued',
          mode: spec.mode,
          model: spec.strategy.lead.model,
          sessionId: crypto.randomUUID(),
          branch: spec.workIn === 'project-folder' ? undefined : `${spec.projectId}/${base}${spec.attempts > 1 ? `-${i + 1}` : ''}`,
          attemptGroup: group,
          createdAt: Date.now() + i,
          updatedAt: Date.now(),
        });
        set(a);
        created.push(a);
      }
      created.forEach((a, i) => setTimeout(() => start(a.id), 1200 + i * 300));
      return created;
    },
    'projects.open': () => null,
  };
}
