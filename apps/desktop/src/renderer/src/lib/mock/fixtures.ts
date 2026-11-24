/**
 * Sample data from the Mission Control canvas (docs/wiki/raw/design/Main.dc.html, Focus.dc.html,
 * Review.dc.html). Used only by the dev mock bridge when the renderer runs in a plain browser.
 * Every value goes through the protocol schemas so fixtures cannot drift from the contract.
 * Extend freely: add events, diffs, files, artifacts for your screen.
 */
import {
  AgentEvent,
  AgentSummary,
  ArtifactMeta,
  CliInfo,
  CommitInfo,
  FileDiff,
  Project,
  Settings,
  type AgentEventDraft,
  type SubagentInfo,
} from '@oide/protocol';

const MIN = 60_000;
export const NOW = Date.now();
const ago = (m: number) => NOW - m * MIN;

export const projects: Project[] = [
  { id: 'oide', name: 'oide', path: '/Users/you/code/oide', trusted: true, createdAt: ago(60 * 24 * 30) },
  { id: 'billing-api', name: 'billing-api', path: '/Users/you/code/billing-api', trusted: true, createdAt: ago(60 * 24 * 20) },
  { id: 'docs-site', name: 'docs-site', path: '/Users/you/code/docs-site', trusted: true, createdAt: ago(60 * 24 * 10) },
].map((p) => Project.parse(p));

type Sub = Omit<SubagentInfo, 'agentId'>;
const sub = (s: Sub): Sub => s;

const tokens = (input: number, output = Math.round(input / 8)) => ({ input, output, cacheRead: 0, cacheCreation: 0 });

const rawAgents = [
  {
    id: 'a-shell',
    projectId: 'oide',
    title: 'Build the window shell layout',
    status: 'running',
    mode: 'auto',
    model: 'opus',
    branch: 'oide/shell-layout',
    worktreePath: '/Users/you/.oide/worktrees/oide/shell-layout',
    baseRef: 'main',
    activity: [
      'Edit src/shell/Layout.tsx +38 −12',
      'Bash npm run typecheck',
      '⎿ 0 errors',
      'Writing SessionGrid.tsx…',
      '↳ Grid tests · Write SessionGrid.test.tsx',
    ],
    contextUsed: 108_000,
    diff: { files: 7, additions: 214, deletions: 37 },
    subagents: [
      sub({ id: 'sa-explore', name: 'Explore layout', task: 'Map the existing layout components.', tier: 'simple', model: 'haiku', effort: 'low', status: 'done', startedAt: ago(13), endedAt: ago(11), usage: tokens(14_000) }),
      sub({ id: 'sa-grid', name: 'Grid tests', task: 'Write tests for SessionGrid.', tier: 'standard', model: 'sonnet', effort: 'medium', status: 'running', startedAt: ago(4), usage: tokens(22_000) }),
      sub({ id: 'sa-tokens', name: 'Style tokens', task: 'Move colours into tokens.', tier: 'simple', model: 'haiku', effort: 'low', status: 'running', startedAt: ago(1), usage: tokens(6_000) }),
    ],
    createdAt: ago(14),
  },
  {
    id: 'a-bridge',
    projectId: 'oide',
    title: 'Wire the Claude Code CLI bridge',
    status: 'needs-permission',
    mode: 'auto',
    model: 'opus',
    branch: 'oide/cli-bridge',
    worktreePath: '/Users/you/.oide/worktrees/oide/cli-bridge',
    baseRef: 'main',
    activity: ['Read 4 files', 'Edit src/main/cli/SessionHost.ts +86 −4', 'Bash npm run typecheck', '⎿ 0 errors'],
    contextUsed: 162_000,
    diff: { files: 3, additions: 127, deletions: 4 },
    pendingPermission: {
      requestId: 'perm-1',
      agentId: 'a-bridge',
      subagentId: 'sa-deps',
      toolName: 'Bash',
      input: { command: 'npm install node-pty', description: 'Needed to host each CLI session in a real terminal.' },
      summary: 'Run npm install node-pty',
      suggestedRule: 'Bash(npm install:*)',
      createdAt: ago(1),
    },
    subagents: [
      sub({ id: 'sa-flags', name: 'CLI flags', task: 'List every claude CLI flag oIDE needs for headless sessions: output format, permission mode, model and resume. Report each name with a one-line meaning.', tier: 'simple', model: 'haiku', effort: 'low', status: 'done', startedAt: ago(18), endedAt: ago(16), usage: tokens(18_000), contextUsed: 62_000, report: 'Reported 9 flags to the lead agent' }),
      sub({ id: 'sa-deps', name: 'Dependency setup', task: 'Add node-pty to the project and make sure it builds on Linux, Windows and macOS.', tier: 'standard', model: 'sonnet', effort: 'medium', status: 'needs-permission', startedAt: ago(8), usage: tokens(9_000), contextUsed: 24_000 }),
      sub({ id: 'sa-parser', name: 'Parser tests', task: 'Write tests for src/main/cli/parser.ts covering partial chunks, multi-line JSON events and unknown event types.', tier: 'standard', model: 'sonnet', effort: 'medium', status: 'running', startedAt: ago(5), usage: tokens(41_000), contextUsed: 68_000 }),
    ],
    todos: [
      { content: 'Find how sessions start today', status: 'completed' },
      { content: 'SessionHost spawns one CLI per worktree', status: 'completed' },
      { content: 'Add the node-pty dependency', status: 'in_progress', activeForm: 'Adding the node-pty dependency' },
      { content: 'Parse stream-json events', status: 'pending' },
      { content: 'Route permission prompts to tiles', status: 'pending' },
    ],
    createdAt: ago(19),
  },
  {
    id: 'a-manifest',
    projectId: 'oide',
    title: 'Draft the extension manifest schema',
    status: 'running',
    mode: 'auto',
    model: 'opus',
    branch: 'oide/ext-manifest',
    baseRef: 'main',
    activity: ['Fetch VS Code extension manifest docs', 'Write docs/rfc/extension-manifest.md', 'Write schema/manifest.schema.json', 'Thinking about agent-tool contributions…'],
    contextUsed: 46_000,
    diff: { files: 2, additions: 180, deletions: 0 },
    subagents: [sub({ id: 'sa-research', name: 'Research manifests', task: 'Survey extension manifests.', tier: 'simple', model: 'haiku', effort: 'low', status: 'done', startedAt: ago(6), endedAt: ago(3), usage: tokens(12_000) })],
    createdAt: ago(6),
  },
  {
    id: 'a-webhook',
    projectId: 'billing-api',
    title: 'Retry failed Stripe webhooks',
    status: 'ready-for-review',
    mode: 'acceptEdits',
    model: 'opus',
    branch: 'billing-api/webhook-retry',
    baseRef: 'main',
    activity: ['Submitted for review'],
    contextUsed: 134_000,
    diff: { files: 8, additions: 128, deletions: 24 },
    review: {
      agentId: 'a-webhook',
      summary: 'Added exponential backoff with a dead-letter queue. 18 tests pass.',
      checks: [
        { name: 'Tests', status: 'passed', detail: '18 passed' },
        { name: 'Typecheck', status: 'passed', detail: 'clean' },
        { name: 'Migration not run against staging', status: 'warning' },
      ],
      submittedAt: ago(3),
    },
    subagents: [
      sub({ id: 'sa-backoff', name: 'Backoff', task: 'Implement exponential backoff.', tier: 'standard', model: 'sonnet', effort: 'medium', status: 'done', startedAt: ago(30), endedAt: ago(21), usage: tokens(52_000) }),
      sub({ id: 'sa-reviewer', name: 'Reviewer', task: 'Review the change.', tier: 'complex', model: 'opus', effort: 'high', status: 'done', startedAt: ago(15), endedAt: ago(5), usage: tokens(40_000), report: '2 rounds, nothing left' }),
      sub({ id: 'sa-tests', name: 'Tests', task: 'Write tests for the retry queue.', tier: 'standard', model: 'sonnet', effort: 'medium', status: 'done', startedAt: ago(20), endedAt: ago(9), usage: tokens(33_000), report: '18 tests' }),
    ],
    createdAt: ago(41),
  },
  {
    id: 'a-invoice',
    projectId: 'billing-api',
    title: 'Fix the flaky invoice test',
    status: 'has-question',
    mode: 'auto',
    model: 'sonnet',
    branch: 'billing-api/invoice-test',
    baseRef: 'main',
    activity: ['Asked a question'],
    contextUsed: 184_000,
    lastMessage: "The test fails around midnight UTC. Should invoice dates use the customer's timezone or always UTC?",
    subagents: [],
    createdAt: ago(27),
  },
  {
    id: 'a-docs',
    projectId: 'docs-site',
    title: 'Rewrite the getting-started guide',
    status: 'running',
    mode: 'auto',
    model: 'opus',
    branch: 'docs-site/getting-started',
    baseRef: 'main',
    activity: ['Read content/docs/start/*.mdx (6)', 'Edit content/docs/start/install.mdx', 'Bash pnpm build', '⎿ built 48 pages', '↳ Link checker · Checking 48 pages…'],
    contextUsed: 82_000,
    diff: { files: 4, additions: 120, deletions: 96 },
    subagents: [
      sub({ id: 'sa-links', name: 'Link checker', task: 'Check every link in the built site.', tier: 'simple', model: 'haiku', effort: 'low', status: 'running', startedAt: ago(3), usage: tokens(8_000), report: '48 pages' }),
      sub({ id: 'sa-shots', name: 'Screenshots', task: 'Refresh screenshots.', tier: 'standard', model: 'sonnet', effort: 'medium', status: 'queued' }),
    ],
    createdAt: ago(22),
  },
] as const;

export const agents: AgentSummary[] = rawAgents.map((a) =>
  AgentSummary.parse({
    ...a,
    subagents: a.subagents.map((s) => ({ ...s, agentId: a.id })),
    contextWindow: 200_000,
    usage: tokens(a.contextUsed, Math.round(a.contextUsed / 6)),
    updatedAt: NOW,
  }),
);

/** Transcript for the Focus design (lead agent "Wire the Claude Code CLI bridge"). */
const bridgeDrafts: AgentEventDraft[] = [
  { type: 'init', sessionId: 'sess-bridge', model: 'claude-opus-4', cwd: '/Users/you/.oide/worktrees/oide/cli-bridge', tools: [], mcpServers: [{ name: 'oide', status: 'connected' }] },
  { type: 'user-text', text: 'Spawn each session as a real claude CLI process in its own worktree and stream its events into the tiles. Follow the Main window v2 design.' },
  { type: 'assistant-text', text: "I'll host each CLI in a pseudo-terminal so it behaves like your shell, and parse its streaming JSON for the tiles. SessionHost is done. Next is the terminal dependency." },
  { type: 'tool-use', toolUseId: 'tu-read', name: 'Read', input: { files: ['package.json', 'src/main/index.ts', 'src/main/cli/index.ts', 'src/main/cli/types.ts'] } },
  { type: 'tool-result', toolUseId: 'tu-read', isError: false, content: 'Read 4 files' },
  {
    type: 'tool-use',
    toolUseId: 'tu-edit',
    name: 'Edit',
    input: {
      file_path: 'src/main/cli/SessionHost.ts',
      old_string: '',
      new_string: "const pty = spawn('claude', ['--output-format', 'stream-json'], {\n  cwd: worktree.path, env: session.env,\n});",
    },
  },
  { type: 'tool-result', toolUseId: 'tu-edit', isError: false, content: 'Updated src/main/cli/SessionHost.ts (+86 −4)' },
  { type: 'tool-use', toolUseId: 'tu-tc', name: 'Bash', input: { command: 'npm run typecheck' } },
  { type: 'tool-result', toolUseId: 'tu-tc', isError: false, content: '0 errors' },
  { type: 'assistant-text', text: "I've split the remaining work into three subagents so they can run side by side." },
  { type: 'tool-use', toolUseId: 'sa-flags', name: 'Task', input: { description: 'CLI flags', subagent_type: 'general-purpose' } },
  { type: 'tool-use', toolUseId: 'sa-deps', name: 'Task', input: { description: 'Dependency setup', subagent_type: 'general-purpose' } },
  { type: 'tool-use', toolUseId: 'sa-parser', name: 'Task', input: { description: 'Parser tests', subagent_type: 'general-purpose' } },
  { type: 'tool-use', toolUseId: 'sf-1', name: 'Bash', input: { command: 'claude --help' }, parentToolUseId: 'sa-flags' },
  { type: 'tool-use', toolUseId: 'sf-2', name: 'Read', input: { file_path: 'docs/cli-reference.md' }, parentToolUseId: 'sa-flags' },
  { type: 'tool-use', toolUseId: 'sd-1', name: 'Read', input: { file_path: 'package.json' }, parentToolUseId: 'sa-deps' },
  { type: 'tool-use', toolUseId: 'sd-2', name: 'WebFetch', input: { url: 'https://github.com/microsoft/node-pty' }, parentToolUseId: 'sa-deps' },
  { type: 'tool-use', toolUseId: 'sp-1', name: 'Read', input: { file_path: 'src/main/cli/parser.ts' }, parentToolUseId: 'sa-parser' },
  { type: 'tool-use', toolUseId: 'sp-2', name: 'Write', input: { file_path: 'src/main/cli/parser.test.ts' }, parentToolUseId: 'sa-parser' },
  { type: 'tool-use', toolUseId: 'sp-3', name: 'Bash', input: { command: 'npx vitest parser' }, parentToolUseId: 'sa-parser' },
  { type: 'tool-result', toolUseId: 'sp-3', isError: true, content: '7 passed, 1 failed', parentToolUseId: 'sa-parser' },
  { type: 'permission-request', request: rawAgents[1].pendingPermission },
];

export const events: Record<string, AgentEvent[]> = {
  'a-bridge': bridgeDrafts.map((d, i) => AgentEvent.parse({ ...d, agentId: 'a-bridge', seq: i, ts: ago(19 - i * 0.8) })),
};

export const diffs: Record<string, FileDiff[]> = {
  'a-webhook': [
    FileDiff.parse({
      path: 'src/webhooks/retry.ts',
      status: 'modified',
      additions: 3,
      deletions: 1,
      patch: '@@ -10,7 +10,9 @@ export async function handle(event: StripeEvent) {\n   const attempt = event.attempt ?? 0;\n-  await deliver(event);\n+  const delay = backoff(attempt);\n+  await sleep(delay);\n+  await deliver(event);\n }\n',
    }),
    FileDiff.parse({ path: 'src/webhooks/deadLetter.ts', status: 'added', additions: 48, deletions: 0, patch: '@@ -0,0 +1,48 @@\n+export class DeadLetterQueue {}\n' }),
  ],
};

export const commits: CommitInfo[] = [
  { sha: '8f3c2a1', message: 'Add SessionHost', author: 'you', agent: 'Wire the Claude Code CLI bridge', ts: ago(50) },
  { sha: '1b7d9e4', message: 'Window shell skeleton', author: 'you', ts: ago(120) },
].map((c) => CommitInfo.parse(c));

export const artifacts: ArtifactMeta[] = [
  { id: 'art-main-v2', slug: 'main-window-v2', title: 'Main window v2', kind: 'design', projectId: 'oide', location: 'repo', version: 3, entry: 'index.html', createdAt: ago(600), updatedAt: ago(30) },
  { id: 'art-manifest-rfc', slug: 'extension-manifest-rfc', title: 'Extension manifest RFC', kind: 'doc', projectId: 'oide', location: 'repo', version: 1, entry: 'doc.md', createdAt: ago(5), updatedAt: ago(1) },
  { id: 'art-lifecycle', slug: 'session-lifecycle', title: 'Session lifecycle', kind: 'whiteboard', projectId: 'oide', location: 'app-data', version: 2, entry: 'board.excalidraw', createdAt: ago(900), updatedAt: ago(200) },
].map((a) => ArtifactMeta.parse(a));

export const cli: CliInfo = CliInfo.parse({ found: true, path: '/usr/local/bin/claude', version: '2.1.325', inTestedRange: true, signedIn: 'yes' });

export const usage = {
  sessions: 6,
  worktrees: 6,
  subagentsActive: 6,
  projectsOpen: 3,
  tokensToday: 1_284_000,
  rateLimitResetAt: undefined as number | undefined,
};

export const settings: Settings = Settings.parse({
  claude: {},
  models: {},
  agents: { notifications: {} },
  techniques: [],
  permissions: {},
  ui: {},
});
