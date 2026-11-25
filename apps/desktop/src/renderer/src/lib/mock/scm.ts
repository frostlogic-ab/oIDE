/**
 * Dev mock for Source control, Review and Files (docs/wiki/raw/design/SourceControl.dc.html,
 * Review.dc.html, Files.dc.html): sync state, agent worktrees, overlaps, commits, the "Retry failed
 * Stripe webhooks" diff, review comments, file trees and contents. Used only by the mock bridge
 * (`pnpm dev:web`) and renderer tests. Every value goes through the protocol schemas.
 */
import {
  AgentSummary,
  applyReplacements,
  buildSearchRegExp,
  findMatches,
  pathFilter,
  scorePath,
  type ArtifactMeta,
  type ContentFileResult,
  type FileNameMatch,
  CommitInfo,
  FileDiff,
  OverlapWarning,
  ReviewComment,
  SyncState,
  WorktreeInfo,
  type CommandInput,
  type CommandName,
  type CommandOutput,
  type EventName,
  type EventPayload,
  type FileNode,
} from '@oide/protocol';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const now = Date.now();
const ago = (ms: number) => now - ms;

export const PROJECT_PATHS: Record<string, string> = {
  oide: '/Users/you/code/oide',
  'billing-api': '/Users/you/code/billing-api',
  'docs-site': '/Users/you/code/docs-site',
};
const WT_ROOT = '/Users/you/.oide/worktrees';

// ---------------------------------------------------------------- sync state

export const sync: Record<string, SyncState> = {
  oide: SyncState.parse({ branch: 'main', upstream: 'origin/main', behind: 2, dirtyFiles: ['CLAUDE.md'], lastFetchAt: ago(4 * MIN) }),
  'billing-api': SyncState.parse({ branch: 'main', upstream: 'origin/main', lastFetchAt: ago(6 * MIN) }),
  'docs-site': SyncState.parse({ branch: 'main', upstream: 'origin/main', ahead: 1, lastFetchAt: ago(2 * MIN) }),
};

// ---------------------------------------------------------------- worktrees

const wt = (w: Omit<WorktreeInfo, 'orphaned' | 'ahead' | 'behind' | 'changedFiles'> & Partial<WorktreeInfo>) => WorktreeInfo.parse(w);

export const worktrees: Record<string, WorktreeInfo[]> = {
  oide: [
    wt({
      agentId: 'a-shell', projectId: 'oide', path: `${WT_ROOT}/oide/shell-layout`, branch: 'oide/shell-layout', baseRef: 'main', ahead: 4,
      diff: { files: 7, additions: 214, deletions: 37 },
      changedFiles: ['src/shell/Layout.tsx', 'src/shell/SessionGrid.tsx', 'src/shell/StatusBar.tsx', 'src/shell/SessionGrid.test.tsx', 'src/shell/index.ts', 'src/styles/tokens.css', 'package.json'],
    }),
    wt({
      agentId: 'a-bridge', projectId: 'oide', path: `${WT_ROOT}/oide/cli-bridge`, branch: 'oide/cli-bridge', baseRef: 'main', ahead: 2, behind: 2,
      diff: { files: 3, additions: 127, deletions: 4 },
      changedFiles: ['src/main/cli/SessionHost.ts', 'src/main/cli/parser.ts', 'package.json'],
    }),
    wt({
      agentId: 'a-manifest', projectId: 'oide', path: `${WT_ROOT}/oide/ext-manifest`, branch: 'oide/ext-manifest', baseRef: 'main', ahead: 1,
      diff: { files: 2, additions: 310, deletions: 0 },
      changedFiles: ['docs/rfc/extension-manifest.md', 'schema/manifest.schema.json'],
    }),
  ],
  'billing-api': [
    wt({
      agentId: 'a-webhook', projectId: 'billing-api', path: `${WT_ROOT}/billing-api/webhook-retry`, branch: 'billing-api/webhook-retry', baseRef: 'main', ahead: 3,
      diff: { files: 8, additions: 128, deletions: 24 },
      changedFiles: ['src/webhooks/retry.ts', 'src/webhooks/handler.ts', 'src/queue/deadLetter.ts', 'db/migrations/0042.sql', 'src/config/stripe.ts', 'test/retry.test.ts', 'test/handler.test.ts', 'README.md'],
    }),
    wt({
      agentId: 'a-invoice', projectId: 'billing-api', path: `${WT_ROOT}/billing-api/invoice-test`, branch: 'billing-api/invoice-test', baseRef: 'main',
      diff: { files: 1, additions: 6, deletions: 2 },
      changedFiles: ['test/invoice.test.ts'],
    }),
  ],
  'docs-site': [
    wt({
      agentId: 'a-docs', projectId: 'docs-site', path: `${WT_ROOT}/docs-site/getting-started`, branch: 'docs-site/getting-started', baseRef: 'main', ahead: 2,
      diff: { files: 4, additions: 120, deletions: 96 },
      changedFiles: ['content/docs/start/install.mdx', 'content/docs/start/quickstart.mdx', 'content/docs/start/index.mdx', 'astro.config.mjs'],
      pr: { state: 'draft', number: 18, url: 'https://github.com/you/docs-site/pull/18' },
    }),
  ],
};

export const overlaps: Record<string, OverlapWarning[]> = {
  oide: [OverlapWarning.parse({ projectId: 'oide', agentIds: ['a-shell', 'a-bridge'], files: ['package.json'], conflicts: true })],
  'billing-api': [],
  'docs-site': [],
};

// ---------------------------------------------------------------- commits

const commit = (sha: string, message: string, at: number, agent?: string) => CommitInfo.parse({ sha, message, author: 'You', agent, ts: ago(at) });

export const commitsByProject: Record<string, CommitInfo[]> = {
  oide: [
    commit('a41c9e2', 'Add focus view keyboard shortcuts', 2 * HOUR),
    commit('7d03b15', 'Merge oide/status-bar: plan usage meters', 26 * HOUR),
    commit('c9e2210', 'Scaffold the desktop shell', 3 * DAY, 'Scaffold'),
  ],
  'billing-api': [commit('5be8d01', 'Bump Stripe SDK', 4 * DAY), commit('19af7c3', 'Add invoice PDF export', 8 * DAY, 'Invoice')],
  'docs-site': [commit('e02d4aa', 'Fix typo in install page', HOUR), commit('b7710c2', 'Add search', 15 * DAY, 'Search')],
};

// ---------------------------------------------------------------- the webhook diff

function filePatch(path: string, status: FileDiff['status'], lines: string[]): FileDiff {
  let additions = 0;
  let deletions = 0;
  for (const l of lines) {
    if (l.startsWith('@@')) continue;
    if (l.startsWith('+')) additions++;
    else if (l.startsWith('-')) deletions++;
  }
  return FileDiff.parse({ path, status, additions, deletions, patch: lines.join('\n') + '\n' });
}

const added = (body: string[]) => [`@@ -0,0 +1,${body.length} @@`, ...body.map((l) => '+' + l)];

export const RETRY_TS_NEW = [
  "import { stripe } from '../config/stripe';",
  "import { deadLetter } from '../queue/deadLetter';",
  '',
  'const MAX_ATTEMPTS = 6;',
  'const BASE_DELAY_MS = 30_000;',
  '',
  'export async function retry(event, attempt = 1) {',
  '  try {',
  '    return await handle(event);',
  '  } catch (err) {',
  '    if (attempt >= MAX_ATTEMPTS) return deadLetter.push(event, err);',
  '    const delay = BASE_DELAY_MS * 2 ** (attempt - 1);',
  '    await schedule(() => retry(event, attempt + 1), delay);',
  '  }',
  '}',
  '',
  '/**',
  ' * Run `fn` after `ms`, keeping the timer referenced so the',
  ' * worker does not exit while retries are pending.',
  ' */',
  'export function schedule(fn: () => Promise<unknown>, ms: number) {',
  '  return new Promise<void>((resolve, reject) => {',
  '    setTimeout(() => {',
  '      fn().then(() => resolve(), reject);',
  '    }, ms);',
  '  });',
  '}',
  '',
  'export function isRetryable(err: unknown): boolean {',
  '  if (!(err instanceof Error)) return true;',
  '  const status = (err as { statusCode?: number }).statusCode;',
  '  if (status === undefined) return true;',
  '  return status >= 500 || status === 429;',
  '}',
  '',
  'export async function retryAll(events: StripeEvent[]) {',
  '  const results = await Promise.allSettled(events.map((e) => retry(e)));',
  "  const failed = results.filter((r) => r.status === 'rejected');",
  '  if (failed.length) {',
  '    console.warn(`[webhooks] ${failed.length} events failed`);',
  '  }',
  '  return {',
  '    total: events.length,',
  '    failed: failed.length,',
  '    dead: await deadLetter.size(),',
  '  };',
  '  // Dead events stay queued until someone replays them.',
  '}',
];

const retryPatch = [
  '@@ -1,6 +1,48 @@',
  " import { stripe } from '../config/stripe';",
  "+import { deadLetter } from '../queue/deadLetter';",
  ' ',
  '+const MAX_ATTEMPTS = 6;',
  '+const BASE_DELAY_MS = 30_000;',
  ' ',
  '-export async function retry(event) {',
  '-  return handle(event);',
  ...RETRY_TS_NEW.slice(6, 47).map((l) => '+' + l),
  ' }',
];

export const webhookDiff: FileDiff[] = [
  filePatch('src/webhooks/retry.ts', 'modified', retryPatch),
  filePatch('src/webhooks/handler.ts', 'modified', [
    '@@ -1,14 +1,11 @@',
    " import type { Request, Response } from 'express';",
    "-import { stripe, WEBHOOK_SECRET } from '../config/stripe';",
    "-import { log } from '../log';",
    "+import { stripe, webhookSecret } from '../config/stripe';",
    "+import { retry } from './retry';",
    ' ',
    ' export async function handler(req: Request, res: Response) {',
    "-  const sig = req.headers['stripe-signature'];",
    '-  let event;',
    '-  try {',
    '-    event = stripe.webhooks.constructEvent(req.body, sig, WEBHOOK_SECRET);',
    '-  } catch (err) {',
    "-    log.error('bad signature', err);",
    '-    return res.status(400).end();',
    '-  }',
    "+  const sig = String(req.headers['stripe-signature'] ?? '');",
    '+  const event = verify(req.body, sig);',
    '+  if (!event) return res.status(400).end();',
    '+  void retry(event);',
    '   res.status(200).end();',
    ' }',
    '@@ -30,9 +27,19 @@ export async function handle(event) {',
    '   switch (event.type) {',
    "     case 'invoice.paid':",
    '       return markPaid(event.data.object);',
    "-    case 'invoice.payment_failed':",
    '-      return notifyFailed(event.data.object);',
    "+    case 'invoice.payment_failed': {",
    '+      await notifyFailed(event.data.object);',
    '+      return;',
    '+    }',
    '     default:',
    '       return;',
    '   }',
    ' }',
    '+',
    '+function verify(body: Buffer, sig: string) {',
    '+  try {',
    '+    return stripe.webhooks.constructEvent(body, sig, webhookSecret());',
    '+  } catch {',
    '+    return null;',
    '+  }',
    '+}',
  ]),
  filePatch(
    'src/queue/deadLetter.ts',
    'added',
    added([
      "import { db } from '../db';",
      '',
      'export interface DeadEvent {',
      '  id: string;',
      '  type: string;',
      '  payload: unknown;',
      '  error: string;',
      '  failedAt: Date;',
      '}',
      '',
      'export const deadLetter = {',
      '  async push(event: { id: string; type: string }, err: unknown) {',
      "    await db('dead_letter').insert({",
      '      id: event.id,',
      '      type: event.type,',
      '      payload: JSON.stringify(event),',
      '      error: err instanceof Error ? err.message : String(err),',
      '      failed_at: new Date(),',
      '    });',
      '  },',
      '  async size() {',
      "    const [{ count }] = await db('dead_letter').count({ count: '*' });",
      '    return Number(count);',
      '  },',
      '};',
    ]),
  ),
  filePatch(
    'db/migrations/0042.sql',
    'added',
    added([
      '-- Dead-letter queue for webhook events that ran out of retries.',
      'CREATE TABLE dead_letter (',
      '  id         TEXT PRIMARY KEY,',
      '  type       TEXT NOT NULL,',
      '  payload    JSONB NOT NULL,',
      '  error      TEXT NOT NULL,',
      '  failed_at  TIMESTAMPTZ NOT NULL DEFAULT now()',
      ');',
      '',
      'CREATE INDEX dead_letter_failed_at ON dead_letter (failed_at);',
    ]),
  ),
  filePatch('src/config/stripe.ts', 'modified', [
    '@@ -1,6 +1,11 @@',
    " import Stripe from 'stripe';",
    ' ',
    "-export const stripe = new Stripe(process.env.STRIPE_KEY!, { apiVersion: '2024-06-20' });",
    '-export const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET!;',
    "+export const stripe = new Stripe(process.env.STRIPE_KEY!, { apiVersion: '2025-01-27' });",
    '+',
    '+export function webhookSecret(): string {',
    "+  const s = process.env.STRIPE_WEBHOOK_SECRET;",
    "+  if (!s) throw new Error('STRIPE_WEBHOOK_SECRET is not set');",
    '+  return s;',
    '+}',
    ' ',
    ' export const currency = "usd";',
  ]),
  filePatch(
    'test/retry.test.ts',
    'added',
    added([
      "import { describe, expect, it, vi } from 'vitest';",
      "import { retry, isRetryable } from '../src/webhooks/retry';",
      "import { deadLetter } from '../src/queue/deadLetter';",
      '',
      "describe('retry', () => {",
      "  it('dead-letters after six attempts', async () => {",
      "    const push = vi.spyOn(deadLetter, 'push').mockResolvedValue();",
      "    await retry({ id: 'evt_1', type: 'invoice.paid' }, 6);",
      '    expect(push).toHaveBeenCalledOnce();',
      '  });',
      '',
      "  it('retries 5xx and 429', () => {",
      '    expect(isRetryable(Object.assign(new Error(), { statusCode: 503 }))).toBe(true);',
      '    expect(isRetryable(Object.assign(new Error(), { statusCode: 429 }))).toBe(true);',
      '    expect(isRetryable(Object.assign(new Error(), { statusCode: 400 }))).toBe(false);',
      '  });',
      '});',
    ]),
  ),
  filePatch('test/handler.test.ts', 'modified', [
    '@@ -4,11 +4,6 @@ import { handler } from "../src/webhooks/handler";',
    " describe('handler', () => {",
    "-  it('rejects a bad signature', async () => {",
    '-    const res = mockRes();',
    "-    await handler(mockReq({ sig: 'nope' }), res);",
    '-    expect(res.status).toHaveBeenCalledWith(400);',
    '-  });',
    '-',
    "-  it('logs the error', async () => {",
    "-    expect(log.error).toHaveBeenCalled();",
    "+  it('answers 400 on a bad signature', async () => {",
    "+    const res = await call(handler, { sig: 'nope' });",
    '+    expect(res.statusCode).toBe(400);',
    '   });',
    ' });',
  ]),
  filePatch('README.md', 'modified', [
    '@@ -18,3 +18,7 @@ ## Webhooks',
    ' Stripe sends events to `/webhooks/stripe`.',
    ' ',
    ' Set `STRIPE_WEBHOOK_SECRET` in `.env`.',
    '+',
    '+Failed events retry up to 6 times with exponential backoff (30 s, 1 min, 2 min, …).',
    '+After that they land in the `dead_letter` table with the error. Replay them with',
    '+`pnpm webhooks:replay`.',
  ]),
];

export const diffsByAgent: Record<string, FileDiff[]> = {
  'a-webhook': webhookDiff,
  'a-invoice': [
    filePatch('test/invoice.test.ts', 'modified', [
      '@@ -12,5 +12,9 @@ describe("invoice dates", () => {',
      "   it('uses the billing day', () => {",
      "-    const d = new Date('2026-03-01T00:00:00');",
      '-    expect(dueDate(d).getDate()).toBe(15);',
      "+    vi.useFakeTimers();",
      "+    vi.setSystemTime(new Date('2026-03-01T00:00:00Z'));",
      "+    const d = new Date('2026-03-01T00:00:00Z');",
      '+    expect(dueDate(d).getUTCDate()).toBe(15);',
      '+    vi.useRealTimers();',
      '+    // TODO: customer timezone or UTC?',
      '   });',
      ' });',
    ]),
  ],
};

export const reviewComments: ReviewComment[] = [
  ReviewComment.parse({ id: 'rc-1', agentId: 'a-webhook', path: 'src/webhooks/retry.ts', line: 12, body: "Add jitter so retries from many events don't line up.", createdAt: ago(2 * MIN) }),
];

export const viewed: Record<string, string[]> = { 'a-webhook': ['src/webhooks/retry.ts'] };

// ---------------------------------------------------------------- file trees and contents

const STATUS_BAR = `import { usePlanUsage } from '../usage';
import { Meter } from './Meter';

export function StatusBar() {
  const { session, week } = usePlanUsage();
  const agents = useSessions().filter((s) => s.running);
  return (
    <footer className="status">
      <CliStatus />
      <Meter label="Session" value={session.used} resetsAt={session.resetsAt} />
      <Meter label="Week" value={week.used} resetsAt={week.resetsAt} />
    </footer>
  );
}
`;

const OIDE_FILES: Record<string, string> = {
  'src/main/cli/SessionHost.ts': "import { spawn } from 'node:child_process';\n\nexport class SessionHost {\n  start(worktree: string) {\n    return spawn('claude', ['--output-format', 'stream-json'], { cwd: worktree });\n  }\n}\n",
  'src/main/cli/parser.ts': "export function parseLine(line: string) {\n  try {\n    return JSON.parse(line);\n  } catch {\n    return undefined;\n  }\n}\n",
  'src/shell/Layout.tsx': "import { Rail } from './Rail';\nimport { StatusBar } from './StatusBar';\n\nexport function Layout({ children }) {\n  return (\n    <div className=\"frame\">\n      <Rail />\n      {children}\n      <StatusBar />\n    </div>\n  );\n}\n",
  'src/shell/SessionGrid.tsx': "export function SessionGrid({ sessions }) {\n  return <div className=\"grid\">{sessions.map((s) => <Tile key={s.id} session={s} />)}</div>;\n}\n",
  'src/shell/StatusBar.tsx': STATUS_BAR,
  'src/shell/Rail.tsx': "export function Rail() {\n  return <nav aria-label=\"Primary\" className=\"rail\" />;\n}\n",
  'src/extensions/registry.ts': 'export const registry = new Map<string, unknown>();\n',
  'src/extensions/loader.ts': "import { registry } from './registry';\n\nexport async function load(name: string) {\n  registry.set(name, await import(name));\n}\n",
  'docs/rfc/extension-manifest.md': '# Extension manifest\n\nEvery extension ships an `oide.json` next to its `package.json`.\n',
  'package.json': '{\n  "name": "oide",\n  "version": "0.1.0",\n  "private": true,\n  "scripts": {\n    "dev": "electron-vite dev",\n    "typecheck": "tsc --noEmit"\n  }\n}\n',
  'CLAUDE.md': '# oIDE: instructions for Claude Code\n\nRun `pnpm test` before you submit for review.\n',
};

const BILLING_FILES: Record<string, string> = {
  'src/webhooks/retry.ts': "import { stripe } from '../config/stripe';\n\n\nexport async function retry(event) {\n  return handle(event);\n}\n",
  'src/webhooks/handler.ts': "import type { Request, Response } from 'express';\n\nexport async function handler(req: Request, res: Response) {\n  res.status(200).end();\n}\n",
  'src/invoices/invoice.ts': 'export function dueDate(d: Date) {\n  return new Date(d.getFullYear(), d.getMonth(), 15);\n}\n',
  'src/invoices/pdf.ts': "export async function renderPdf(invoiceId: string) {\n  return Buffer.from(invoiceId);\n}\n",
  'src/config/stripe.ts': "import Stripe from 'stripe';\n\nexport const stripe = new Stripe(process.env.STRIPE_KEY!);\n",
  'test/invoice.test.ts': "import { dueDate } from '../src/invoices/invoice';\n\ntest('due on the 15th', () => {\n  expect(dueDate(new Date()).getDate()).toBe(15);\n});\n",
  'test/handler.test.ts': "import { handler } from '../src/webhooks/handler';\n",
  'package.json': '{\n  "name": "billing-api",\n  "version": "2.3.0"\n}\n',
  'README.md': '# billing-api\n\nStripe sends events to `/webhooks/stripe`.\n',
};

const DOCS_FILES: Record<string, string> = {
  'content/docs/start/install.mdx': '---\ntitle: Install\n---\n\nRun `npm install -g oide`, then open a project.\n',
  'content/docs/start/quickstart.mdx': '---\ntitle: Quickstart\n---\n\nSpawn your first agent with Ctrl K.\n',
  'astro.config.mjs': "import { defineConfig } from 'astro/config';\n\nexport default defineConfig({ site: 'https://docs.example.com' });\n",
};

/** Root path → { relative path → content }. Worktrees start as copies of main plus the agent's files. */
export const files = new Map<string, Map<string, string>>();
function addRoot(root: string, base: Record<string, string>, extra: Record<string, string> = {}) {
  files.set(root, new Map(Object.entries({ ...base, ...extra })));
}
addRoot(PROJECT_PATHS.oide!, OIDE_FILES);
addRoot(PROJECT_PATHS['billing-api']!, BILLING_FILES);
addRoot(PROJECT_PATHS['docs-site']!, DOCS_FILES);
addRoot(`${WT_ROOT}/oide/shell-layout`, OIDE_FILES, {
  'src/shell/StatusBar.tsx': STATUS_BAR.replace('<CliStatus />', '<CliStatus />\n      <AgentCount value={agents.length} />'),
  'src/shell/SessionGrid.test.tsx': "test('renders a tile per session', () => {});\n",
  'src/shell/index.ts': "export * from './Layout';\n",
  'src/styles/tokens.css': ':root {\n  --ground: #0e1013;\n}\n',
});
addRoot(`${WT_ROOT}/oide/cli-bridge`, OIDE_FILES);
addRoot(`${WT_ROOT}/oide/ext-manifest`, OIDE_FILES, { 'schema/manifest.schema.json': '{\n  "$schema": "https://json-schema.org/draft/2020-12/schema"\n}\n' });
addRoot(`${WT_ROOT}/billing-api/webhook-retry`, BILLING_FILES, {
  'src/webhooks/retry.ts': RETRY_TS_NEW.join('\n') + '\n',
  'src/queue/deadLetter.ts': "export const deadLetter = { push: async () => {}, size: async () => 0 };\n",
  'db/migrations/0042.sql': 'CREATE TABLE dead_letter (id TEXT PRIMARY KEY);\n',
  'test/retry.test.ts': "import { retry } from '../src/webhooks/retry';\n",
});
addRoot(`${WT_ROOT}/billing-api/invoice-test`, BILLING_FILES);
addRoot(`${WT_ROOT}/docs-site/getting-started`, DOCS_FILES, { 'content/docs/start/index.mdx': '---\ntitle: Getting started\n---\n' });

export function listDir(root: string, dir: string): FileNode[] {
  const all = files.get(root);
  if (!all) throw new Error(`[forbidden_path] ${root} is not a known project or worktree`);
  const prefix = dir ? dir.replace(/\/$/, '') + '/' : '';
  const dirs = new Set<string>();
  const out: FileNode[] = [];
  for (const p of all.keys()) {
    if (!p.startsWith(prefix)) continue;
    const rest = p.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash === -1) out.push({ name: rest, path: p, kind: 'file' });
    else dirs.add(rest.slice(0, slash));
  }
  const dirNodes: FileNode[] = [...dirs].sort().map((name) => ({ name, path: prefix + name, kind: 'dir' }));
  return [...dirNodes, ...out.sort((a, b) => a.name.localeCompare(b.name))];
}

export function fileHistory(path: string, root: string): CommitInfo[] {
  const isWorktree = root.startsWith(WT_ROOT);
  const base = [
    commit('3e1f0c7', `Update ${path.split('/').pop()}`, 26 * HOUR),
    commit('c9e2210', 'Scaffold the desktop shell', 3 * DAY, 'Scaffold'),
  ];
  if (isWorktree) base.unshift(commit('f00ba12', 'WIP from the agent', 20 * MIN, 'Window shell layout'));
  return base;
}

export const mentions: Record<string, ArtifactMeta[]> = {};

/** 64 hex chars from a string (stand-in for main's sha256: changes whenever the content does). */
export function mockHash(text: string): string {
  let out = '';
  for (let seed = 0; out.length < 64; seed++) {
    let h = 0x811c9dc5 ^ seed;
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
    out += (h >>> 0).toString(16).padStart(8, '0');
  }
  return out.slice(0, 64);
}

// ---------------------------------------------------------------- handlers

type Handlers = { [K in CommandName]?: (input: CommandInput<K>) => CommandOutput<K> | Promise<CommandOutput<K>> };

export interface ScmMockDeps {
  agents: Map<string, AgentSummary>;
  emit: <K extends EventName>(event: K, payload: EventPayload<K>) => void;
  /** Fallback diffs (fixtures.diffs) for agents this module has none for. */
  fallbackDiffs?: Record<string, FileDiff[]>;
  /** Fallback artifacts for "Mentioned in". */
  artifacts?: ArtifactMeta[];
}

export function createScmHandlers({ agents, emit, fallbackDiffs = {}, artifacts = [] }: ScmMockDeps): Handlers {
  const state = {
    sync: structuredClone(sync),
    worktrees: structuredClone(worktrees),
    overlaps: structuredClone(overlaps),
    commits: structuredClone(commitsByProject),
    comments: structuredClone(reviewComments),
    viewed: structuredClone(viewed),
  };
  let nextId = 100;
  const need = <T>(v: T | undefined, what: string): T => {
    if (v === undefined) throw new Error(`[not_found] ${what}`);
    return v;
  };
  const syncOf = (projectId: string) => need(state.sync[projectId], `No project ${projectId}`);
  const changed = (projectId: string) => setTimeout(() => emit('git.changed', { projectId }), 0);
  const worktreeOf = (agentId: string) => Object.values(state.worktrees).flat().find((w) => w.agentId === agentId);
  const rootOf = (absPath: string) => [...files.keys()].sort((a, b) => b.length - a.length).find((r) => absPath === r || absPath.startsWith(r + '/'));

  return {
    'git.sync': ({ projectId }) => syncOf(projectId),
    'git.fetch': ({ projectId }) => ({ ...syncOf(projectId), lastFetchAt: Date.now() }),
    'git.pull': ({ projectId }) => {
      const s = (state.sync[projectId] = { ...syncOf(projectId), behind: 0, lastFetchAt: Date.now() });
      emit('notify', { level: 'info', message: `Pulled ${projectId} (fast-forward).` });
      changed(projectId);
      return s;
    },
    'git.push': ({ projectId }) => {
      const s = (state.sync[projectId] = { ...syncOf(projectId), ahead: 0 });
      emit('notify', { level: 'info', message: `Pushed ${projectId} to ${s.upstream ?? 'origin'}.` });
      changed(projectId);
      return s;
    },
    'git.commit': ({ projectId, message, files: picked }) => {
      const s = syncOf(projectId);
      const committed = picked ?? s.dirtyFiles;
      state.sync[projectId] = { ...s, ahead: s.ahead + 1, dirtyFiles: s.dirtyFiles.filter((f) => !committed.includes(f)) };
      const c = commit(Math.random().toString(16).slice(2, 9), message.split('\n')[0]!, 0);
      state.commits[projectId] = [c, ...(state.commits[projectId] ?? [])];
      changed(projectId);
      return c;
    },
    'git.log': ({ projectId, limit }) => (state.commits[projectId] ?? []).slice(0, limit ?? 20),
    'git.worktrees': ({ projectId }) => state.worktrees[projectId] ?? [],
    'git.overlaps': ({ projectId }) => state.overlaps[projectId] ?? [],
    'git.prAvailable': () => ({ available: true }),
    'git.diff': ({ agentId }) => diffsByAgent[agentId] ?? fallbackDiffs[agentId] ?? [],
    'git.mergeLocal': ({ agentId }) => {
      const w = need(worktreeOf(agentId), `No worktree for ${agentId}`);
      const conflict = (state.overlaps[w.projectId] ?? []).find((o) => o.conflicts && o.agentIds[1] === agentId);
      if (conflict) return { ok: false, conflicts: conflict.files };
      state.commits[w.projectId] = [commit(Math.random().toString(16).slice(2, 9), `Merge ${w.branch}`, 0), ...(state.commits[w.projectId] ?? [])];
      const s = syncOf(w.projectId);
      state.sync[w.projectId] = { ...s, ahead: s.ahead + 1 };
      changed(w.projectId);
      return { ok: true, conflicts: [] };
    },
    'git.openPr': ({ agentId }) => {
      const w = need(worktreeOf(agentId), `No worktree for ${agentId}`);
      const number = nextId++;
      const url = `https://github.com/you/${w.projectId}/pull/${number}`;
      w.pr = { state: 'open', number, url };
      changed(w.projectId);
      return { url };
    },
    'git.reconcile': ({ projectId, agentIds }) => {
      const [a, b] = agentIds.map((id) => agents.get(id)?.title ?? id);
      const id = `a-reconcile-${nextId++}`;
      const summary = AgentSummary.parse({
        id, projectId, title: `Reconcile ${a} with ${b}`, status: 'starting', mode: 'auto', model: 'opus',
        branch: `${projectId}/reconcile-${nextId}`, baseRef: 'main', createdAt: Date.now(), updatedAt: Date.now(),
      });
      agents.set(id, summary);
      emit('agents.summary', summary);
      return [summary];
    },
    'git.pruneOrphans': ({ projectId }) => {
      const removed = (state.worktrees[projectId] ?? []).filter((w) => w.orphaned).map((w) => w.path);
      state.worktrees[projectId] = (state.worktrees[projectId] ?? []).filter((w) => !w.orphaned);
      changed(projectId);
      return { removed };
    },

    'review.comments': ({ agentId }) => state.comments.filter((c) => c.agentId === agentId),
    'review.addComment': ({ agentId, path, line, side, body }) => {
      const c = ReviewComment.parse({ id: `rc-${nextId++}`, agentId, path, line, side, body, createdAt: Date.now() });
      state.comments.push(c);
      return c;
    },
    'review.deleteComment': ({ commentId }) => {
      state.comments = state.comments.filter((c) => c.id !== commentId);
      return { ok: true as const };
    },
    'review.sendFeedback': ({ agentId }) => {
      const pending = state.comments.filter((c) => c.agentId === agentId && !c.sent);
      if (!pending.length) throw new Error('[invalid_input] No comments to send');
      for (const c of pending) c.sent = true;
      const a = agents.get(agentId);
      if (a) {
        const next = { ...a, status: 'running' as const, activity: ['Revising after your review'], updatedAt: Date.now() };
        agents.set(agentId, next);
        emit('agents.summary', next);
      }
      return { ok: true as const };
    },
    'review.setViewed': ({ agentId, path, viewed: v }) => {
      const set = new Set(state.viewed[agentId] ?? []);
      if (v) set.add(path);
      else set.delete(path);
      state.viewed[agentId] = [...set];
      return { ok: true as const };
    },
    'review.viewed': ({ agentId }) => state.viewed[agentId] ?? [],

    'files.tree': ({ root, dir }) => listDir(root, dir ?? ''),
    'files.read': ({ root, path }) => {
      const content = files.get(root)?.get(path);
      if (content === undefined) throw new Error(`[not_found] ${path}`);
      return { content, binary: false };
    },
    'files.write': ({ root, path, content }) => {
      const tree = need(files.get(root), `[forbidden_path] ${root}`);
      tree.set(path, content);
      return { ok: true as const };
    },
    'files.history': ({ root, path }) => fileHistory(path, root),
    'files.findByName': ({ roots, query, limit = 50, recent = [] }) => {
      const rank = new Map(recent.map((r, i) => [`${r.root}
${r.path}`, i]));
      const out: FileNameMatch[] = [];
      let total = 0;
      for (const root of roots) {
        const tree = need(files.get(root), `[forbidden_path] ${root}`);
        total += tree.size;
        for (const path of tree.keys()) {
          const s = scorePath(query, path);
          if (!s || !query.trim()) continue;
          const r = rank.get(`${root}
${path}`);
          out.push({ root, path, score: r !== undefined ? 1_000_000 - r * 1000 + s.score / 100 : s.score, positions: s.positions, recent: r !== undefined });
        }
      }
      return { results: out.sort((a, b) => b.score - a.score).slice(0, limit), total, stale: false };
    },
    'files.searchContent': ({ searchId, roots, query, isRegex = false, matchCase = false, wholeWord = false, include = '', exclude = '', maxResults = 2000 }) => {
      const re = buildSearchRegExp({ query, isRegex, matchCase, wholeWord });
      const keep = pathFilter(include, exclude);
      const found: ContentFileResult[] = [];
      let count = 0;
      for (const root of roots) {
        const tree = need(files.get(root), `[forbidden_path] ${root}`);
        for (const [path, content] of [...tree].sort((a, b) => a[0].localeCompare(b[0]))) {
          if (!keep(path) || count >= maxResults) continue;
          const matches = findMatches(content, re, maxResults - count);
          if (!matches.length) continue;
          count += matches.length;
          found.push({ root, path, hash: mockHash(content), mtimeMs: now, matches });
        }
      }
      // Two batches, like main's streaming.
      const half = Math.ceil(found.length / 2);
      setTimeout(() => emit('files.searchResults', { searchId, files: found.slice(0, half), done: false, truncated: false }), 0);
      setTimeout(() => emit('files.searchResults', { searchId, files: found.slice(half), done: true, truncated: count >= maxResults, stats: { files: found.length, matches: count, ms: 3, engine: 'git-grep' } }), 5);
      return { ok: true as const };
    },
    'files.cancelSearch': () => ({ ok: true as const }),
    'files.replace': ({ files: list, query, isRegex = false, matchCase = false, wholeWord = false, replacement }) => {
      const o = { query, isRegex, matchCase, wholeWord };
      return {
        results: list.map((f) => {
          const tree = need(files.get(f.root), `[forbidden_path] ${f.root}`);
          const content = tree.get(f.path);
          if (content === undefined) return { root: f.root, path: f.path, status: 'stale' as const, replaced: 0, message: 'The file is gone.' };
          if (mockHash(content) !== f.hash) return { root: f.root, path: f.path, status: 'stale' as const, replaced: 0, message: 'The file changed since the search. Search again.' };
          const r = applyReplacements(content, o, replacement, f.matches);
          if (r.missing) return { root: f.root, path: f.path, status: 'stale' as const, replaced: 0, message: 'A match moved.' };
          tree.set(f.path, r.content);
          return { root: f.root, path: f.path, status: 'replaced' as const, replaced: r.replaced };
        }),
      };
    },
    'files.editingAgents': ({ path }) => {
      const root = rootOf(path);
      const rel = root ? path.slice(root.length + 1) : path;
      return Object.values(state.worktrees)
        .flat()
        .filter((w) => w.agentId && w.changedFiles.includes(rel) && agents.get(w.agentId)?.status !== 'done')
        .map((w) => w.agentId!);
    },
    'files.mentionedIn': ({ path }) => mentions[path] ?? (path.endsWith('StatusBar.tsx') ? artifacts.filter((a) => a.id === 'art-main-v2') : []),
    'agents.remove': ({ agentId }) => {
      agents.delete(agentId);
      for (const [projectId, list] of Object.entries(state.worktrees)) {
        const next = list.filter((w) => w.agentId !== agentId);
        if (next.length !== list.length) {
          state.worktrees[projectId] = next;
          state.overlaps[projectId] = (state.overlaps[projectId] ?? []).filter((o) => !o.agentIds.includes(agentId));
          changed(projectId);
        }
      }
      emit('agents.removed', { agentId });
      return { ok: true as const };
    },
    'shell.revealPath': ({ path }) => {
      emit('notify', { level: 'info', message: `Would open ${path} in the file manager.` });
      return { ok: true as const };
    },
  };
}
