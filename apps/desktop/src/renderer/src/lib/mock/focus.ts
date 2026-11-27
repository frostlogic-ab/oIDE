/**
 * Focus screen fixtures for the dev mock bridge (docs/wiki/raw/design/Focus.dc.html).
 *
 * - `a-bridge` ("Wire the Claude Code CLI bridge"): the transcript drawn on the canvas, with each
 *   subagent's own tagged events, usage, todos and the pending "npm install node-pty" prompt.
 * - `a-shell` ("Build the window shell layout"): a generated ~5,000-event transcript (tool calls,
 *   markdown, thinking, a /compact, subagents with their own events) to exercise virtualization
 *   and paging (`agents.events` pages of 500).
 * - `a-invoice`, `a-webhook`: short transcripts for the question and review states.
 * Every event is parsed through the protocol schema, like fixtures.ts.
 */
import { AgentEvent, FileDiff, type AgentEventDraft, type AgentSummary, type CommandInput, type CommandName, type CommandOutput, type EventName, type EventPayload, type ProjectScript } from '@oide/protocol';
import { NOW } from './fixtures';

const MIN = 60_000;
const ago = (m: number) => NOW - m * MIN;

type Draft = AgentEventDraft & { at?: number };

function build(agentId: string, drafts: Draft[], start: number, end: number): AgentEvent[] {
  const step = (end - start) / Math.max(1, drafts.length);
  return drafts.map(({ at, ...d }, i) => AgentEvent.parse({ ...d, agentId, seq: i, ts: at ?? Math.round(start + i * step) }));
}

const usageOf = (input: number, output = 600, id?: string, parent?: string): Draft => ({
  type: 'usage',
  ...(id ? { messageId: id } : {}),
  ...(parent ? { parentToolUseId: parent } : {}),
  usage: { input, output, cacheRead: 0, cacheCreation: 0 },
});

// ---------------------------------------------------------------- a-bridge (the canvas)

const PARSER_TEST = Array.from({ length: 112 }, (_, i) =>
  i === 0
    ? "import { describe, expect, it } from 'vitest';"
    : i === 1
      ? "import { Parser } from './parser';"
      : i % 14 === 2
        ? `describe('parser case ${i}', () => {`
        : i % 14 === 13
          ? '});'
          : `  it('handles chunk ${i}', () => expect(new Parser().feed('{"type":"x"}\\n')).toHaveLength(1));`,
).join('\n');

const FLAGS_REPORT = [
  'Reported 9 flags to the lead agent:',
  '',
  '| Flag | Meaning |',
  '| --- | --- |',
  '| `-p` | Headless: print and exit when stdin closes |',
  '| `--input-format stream-json` | Read user messages as JSON lines |',
  '| `--output-format stream-json` | Write events as JSON lines |',
  '| `--include-partial-messages` | Stream text deltas |',
  '| `--verbose` | Required with stream-json output |',
  '| `--permission-mode` | default, acceptEdits, plan, auto, bypassPermissions |',
  '| `--model` | Alias or exact id |',
  '| `--session-id` | Fix the session id of a new session |',
  '| `--resume` | Continue a stored session |',
].join('\n');

/**
 * What a CLI with several claude.ai connectors reports in `init.slash_commands` (~100 entries, most of
 * them MCP prompts named `mcp__<server>__<prompt>`), so the `/` menu can be checked at that size.
 */
export const MOCK_SLASH_COMMANDS: string[] = [
  'compact', 'context', 'init', 'review', 'security-review', 'pr-comments', 'release-notes', 'cost', 'todos',
  'gsd-add-phase', 'gsd-plan-phase', 'gsd-execute-phase', 'gsd-progress', 'gsd-debug', 'simplify', 'code-review',
  'engineering:code-review', 'engineering:debug', 'engineering:standup', 'engineering:system-design', 'engineering:testing-strategy',
  'product-management:write-spec', 'product-management:roadmap-update', 'product-management:sprint-planning',
  ...['check-database-status', 'create-contact-from-email', 'summarize-deal-pipeline', 'find-stale-deals', 'draft-follow-up-email', 'enrich-company-record', 'list-open-tickets', 'weekly-sales-digest', 'merge-duplicate-contacts', 'campaign-performance-report', 'import-claude-design-from-url', 'render-hubspot-home'].map((p) => `mcp__claude_ai_HubSpot__${p}`),
  ...['dfs-keyword-research', 'dfs-serp-overview', 'dfs-backlink-audit', 'dfs-competitor-gap-analysis-for-a-domain-with-very-long-name', 'dfs-content-brief', 'dfs-rank-tracker-setup', 'dfs-local-pack-check', 'dfs-site-audit', 'dfs-llm-mentions-report', 'dfs-amazon-product-research', 'dfs-youtube-keyword-ideas', 'dfs-trends-explorer'].map((p) => `mcp__claude_ai_DataForSEO__${p}`),
  ...['search-workspace', 'create-page', 'create-task', 'summarize-page', 'meeting-notes', 'weekly-review', 'database-query', 'find-owner'].map((p) => `mcp__claude_ai_Notion__${p}`),
  ...['outlook-triage', 'draft-reply', 'schedule-meeting', 'teams-digest', 'sharepoint-find', 'calendar-today'].map((p) => `mcp__claude_ai_ms365__${p}`),
  ...['find-prospects', 'enrich-list', 'sequence-health', 'draft-sequence-copy', 'pipeline-gaps', 'account-research', 'call-summary', 'deal-review'].map((p) => `mcp__claude_ai_Apollo_io__${p}`),
  ...['create-doc', 'export-doc', 'outline-from-notes', 'comment-digest'].map((p) => `mcp__claude_ai_Claude_Docs__${p}`),
  ...['resolve-library', 'query-docs', 'upgrade-guide'].map((p) => `mcp__claude_ai_Context7__${p}`),
  ...['portfolio-overview', 'root-cause', 'energy-anomalies', 'forecast-load', 'what-if-setpoint', 'comfort-report', 'kb-search', 'propose-change'].map((p) => `mcp__claude_ai_Explore__${p}`),
  ...['brief', 'ask', 'search', 'remember', 'draft'].map((p) => `mcp__claude_ai_Frostlogic_Brain__${p}`),
  ...['account-brief', 'list-signals', 'post-analytics'].map((p) => `mcp__claude_ai_SurroundR__${p}`),
  ...['browse', 'screenshot', 'fill-form'].map((p) => `mcp__claude-in-chrome__${p}`),
];

const bridgeDrafts: Draft[] = [
  { type: 'init', sessionId: 'sess-bridge', model: 'claude-opus-5', cwd: '/Users/you/.oide/worktrees/oide/cli-bridge', tools: ['Read', 'Edit', 'Write', 'Bash', 'Grep', 'Glob', 'Agent', 'TodoWrite'], mcpServers: [{ name: 'oide', status: 'connected' }], permissionMode: 'auto', cliVersion: '2.1.325', slashCommands: MOCK_SLASH_COMMANDS, at: ago(19) },
  { type: 'status', status: 'running', at: ago(19) },
  { type: 'user-text', text: 'Spawn each session as a real claude CLI process in its own worktree and stream its events into the tiles. Follow the Main window v2 design.', at: ago(19) },
  { type: 'assistant-text', messageId: 'm1', text: "I'll host each CLI in a pseudo-terminal so it behaves like your shell, and parse its streaming JSON for the tiles. SessionHost is done. Next is the terminal dependency.", at: ago(18.5) },
  usageOf(38_000, 900, 'm1'),
  { type: 'tool-use', toolUseId: 'tu-r1', name: 'Read', input: { file_path: 'package.json' }, at: ago(18.4) },
  { type: 'tool-use', toolUseId: 'tu-r2', name: 'Read', input: { file_path: 'src/main/index.ts' }, at: ago(18.4) },
  { type: 'tool-use', toolUseId: 'tu-r3', name: 'Read', input: { file_path: 'src/main/cli/index.ts' }, at: ago(18.4) },
  { type: 'tool-use', toolUseId: 'tu-r4', name: 'Read', input: { file_path: 'src/main/cli/types.ts' }, at: ago(18.4) },
  { type: 'tool-result', toolUseId: 'tu-r1', isError: false, content: '{\n  "name": "oide",\n  "private": true,\n  "scripts": { "typecheck": "tsc --noEmit" }\n}', at: ago(18.3) },
  { type: 'tool-result', toolUseId: 'tu-r2', isError: false, content: "import { app, BrowserWindow } from 'electron';\n// 142 lines", at: ago(18.3) },
  { type: 'tool-result', toolUseId: 'tu-r3', isError: false, content: "export * from './SessionHost';", at: ago(18.3) },
  { type: 'tool-result', toolUseId: 'tu-r4', isError: false, content: 'export interface Session { id: string; env: NodeJS.ProcessEnv }', at: ago(18.3) },
  {
    type: 'tool-use',
    toolUseId: 'tu-edit',
    name: 'Edit',
    input: {
      file_path: 'src/main/cli/SessionHost.ts',
      old_string: '  pty.onData((chunk) => this.parser.feed(chunk));',
      new_string: "const pty = spawn('claude', ['--output-format', 'stream-json'], {\n  cwd: worktree.path, env: session.env,\n});\n  pty.onData((chunk) => this.parser.feed(chunk));",
    },
    at: ago(17),
  },
  { type: 'tool-result', toolUseId: 'tu-edit', isError: false, content: 'The file src/main/cli/SessionHost.ts has been updated.', at: ago(16.9) },
  { type: 'tool-use', toolUseId: 'tu-tc', name: 'Bash', input: { command: 'npm run typecheck', description: 'Typecheck' }, at: ago(16.5) },
  { type: 'tool-result', toolUseId: 'tu-tc', isError: false, content: '0 errors\n\n> tsc --noEmit', at: ago(16) },
  { type: 'assistant-text', messageId: 'm2', text: "I've split the remaining work into three subagents so they can run side by side.", at: ago(15.8) },
  usageOf(96_000, 1_400, 'm2'),
  {
    type: 'todos',
    todos: [
      { content: 'Find how sessions start today', status: 'completed' },
      { content: 'SessionHost spawns one CLI per worktree', status: 'completed' },
      { content: 'Add the node-pty dependency', status: 'in_progress' },
      { content: 'Parse stream-json events', status: 'pending' },
      { content: 'Route permission prompts to tiles', status: 'pending' },
    ],
    at: ago(15.8),
  },
  { type: 'tool-use', toolUseId: 'sa-flags', name: 'Agent', input: { description: 'CLI flags', subagent_type: 'simple-task', prompt: 'List every claude CLI flag oIDE needs for headless sessions: output format, permission mode, model and resume. Report each name with a one-line meaning.' }, at: ago(18) },
  { type: 'tool-use', toolUseId: 'sa-deps', name: 'Agent', input: { description: 'Dependency setup', subagent_type: 'standard-task', prompt: 'Add node-pty to the project and make sure it builds on Linux, Windows and macOS.' }, at: ago(8) },
  { type: 'tool-use', toolUseId: 'sa-parser', name: 'Agent', input: { description: 'Parser tests', subagent_type: 'standard-task', prompt: 'Write tests for src/main/cli/parser.ts covering partial chunks, multi-line JSON events and unknown event types.' }, at: ago(5) },
  // CLI flags (done)
  { type: 'subagent-task', phase: 'started', toolUseId: 'sa-flags', taskId: 'task-flags', description: 'CLI flags', subagentType: 'simple-task', at: ago(18) },
  { type: 'tool-use', toolUseId: 'sf-1', name: 'Bash', input: { command: 'claude --help' }, parentToolUseId: 'sa-flags', at: ago(17.8) },
  { type: 'tool-result', toolUseId: 'sf-1', isError: false, content: 'Usage: claude [options] [command] [prompt]\n\nOptions:\n  -p, --print  Print response and exit', parentToolUseId: 'sa-flags', at: ago(17.7) },
  { type: 'tool-use', toolUseId: 'sf-2', name: 'Read', input: { file_path: 'docs/cli-reference.md' }, parentToolUseId: 'sa-flags', at: ago(17.2) },
  { type: 'tool-result', toolUseId: 'sf-2', isError: false, content: '# CLI reference\n…', parentToolUseId: 'sa-flags', at: ago(17.1) },
  { type: 'assistant-text', messageId: 'sfm', text: FLAGS_REPORT, parentToolUseId: 'sa-flags', at: ago(16.2) },
  usageOf(62_000, 1_200, 'sfm', 'sa-flags'),
  { type: 'tool-result', toolUseId: 'sa-flags', isError: false, content: FLAGS_REPORT, at: ago(16) },
  // Dependency setup (needs permission)
  { type: 'tool-use', toolUseId: 'sd-1', name: 'Read', input: { file_path: 'package.json' }, parentToolUseId: 'sa-deps', at: ago(7.6) },
  { type: 'tool-result', toolUseId: 'sd-1', isError: false, content: '{ "name": "oide" }', parentToolUseId: 'sa-deps', at: ago(7.5) },
  { type: 'tool-use', toolUseId: 'sd-2', name: 'WebFetch', input: { url: 'node-pty install notes', prompt: 'Native build requirements per OS' }, parentToolUseId: 'sa-deps', at: ago(6) },
  { type: 'tool-result', toolUseId: 'sd-2', isError: false, content: 'Windows needs the VS build tools; macOS needs Xcode CLT; Linux needs make, python3 and g++.', parentToolUseId: 'sa-deps', at: ago(5) },
  usageOf(24_000, 800, 'sdm', 'sa-deps'),
  { type: 'tool-use', toolUseId: 'sd-3', name: 'Bash', input: { command: 'npm install node-pty', description: 'Needed to host each CLI session in a real terminal.' }, parentToolUseId: 'sa-deps', at: ago(1) },
  // Parser tests (running)
  { type: 'tool-use', toolUseId: 'sp-1', name: 'Read', input: { file_path: 'src/main/cli/parser.ts' }, parentToolUseId: 'sa-parser', at: ago(4.8) },
  { type: 'tool-result', toolUseId: 'sp-1', isError: false, content: 'export class Parser { … }', parentToolUseId: 'sa-parser', at: ago(4.7) },
  { type: 'tool-use', toolUseId: 'sp-2', name: 'Write', input: { file_path: 'src/main/cli/parser.test.ts', content: PARSER_TEST }, parentToolUseId: 'sa-parser', at: ago(3.5) },
  { type: 'tool-result', toolUseId: 'sp-2', isError: false, content: 'File created successfully at: src/main/cli/parser.test.ts', parentToolUseId: 'sa-parser', at: ago(3.4) },
  { type: 'tool-use', toolUseId: 'sp-3', name: 'Bash', input: { command: 'npx vitest parser' }, parentToolUseId: 'sa-parser', at: ago(2.5) },
  { type: 'tool-result', toolUseId: 'sp-3', isError: false, content: '7 passed, 1 failed\n\n FAIL  parser.test.ts > split chunk\n  expected 1 event, got 0', parentToolUseId: 'sa-parser', at: ago(2) },
  { type: 'assistant-text', messageId: 'spm', text: 'Fixing the split-chunk case…', parentToolUseId: 'sa-parser', at: ago(1.5) },
  usageOf(68_000, 2_100, 'spm', 'sa-parser'),
  // The pending prompt, attributed to Dependency setup by its tool_use id.
  {
    type: 'permission-request',
    request: {
      requestId: 'perm-1',
      agentId: 'a-bridge',
      subagentId: 'sa-deps',
      toolUseId: 'sd-3',
      toolName: 'Bash',
      input: { command: 'npm install node-pty', description: 'Needed to host each CLI session in a real terminal.' },
      summary: 'Run npm install node-pty',
      suggestedRule: 'Bash(npm install:*)',
      createdAt: ago(1),
    },
    at: ago(1),
  },
];

const bridgeEvents = build('a-bridge', bridgeDrafts, ago(19), ago(1));

// ---------------------------------------------------------------- a-shell (5k events)

const FILES = ['src/shell/Layout.tsx', 'src/shell/Rail.tsx', 'src/shell/StatusBar.tsx', 'src/shell/Header.tsx', 'src/shell/SessionGrid.tsx', 'src/shell/Tile.tsx', 'src/styles/tokens.css', 'src/shell/useLayout.ts', 'src/shell/CommandBar.tsx', 'src/shell/index.ts'];
const NOTES = [
  'The rail is **56px** wide with 40px items; I matched the canvas radii (10px) and the selected background `#1E2430`.',
  'Here is the plan for this part:\n\n1. Split `Layout` into header, rail, body and status bar.\n2. Move the colours into tokens.\n3. Add a grid that keeps tiles at **300px** minimum.',
  'Typecheck is clean. The grid now uses `repeat(auto-fill, minmax(300px, 1fr))`, so six tiles fit at 1440px.',
  'I found two places that hard-code `#0E1013`:\n\n```ts\nconst ground = "#0E1013"; // Layout.tsx\nbackground: #0E1013; /* app.css */\n```\n\nBoth now read `var(--color-ground)`.',
  'Tests pass (**24 passed**). Next I will wire the status bar counts to the store.',
  '| Part | Height |\n| --- | --- |\n| Header | 44px |\n| Status bar | 26px |\n| Rail item | 40px |',
];

let seed = 7;
const rnd = (n: number) => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed % n;
};

function shellDrafts(target: number): Draft[] {
  const out: Draft[] = [
    { type: 'init', sessionId: 'sess-shell', model: 'claude-opus-5', cwd: '/Users/you/.oide/worktrees/oide/shell-layout', tools: [], mcpServers: [{ name: 'oide', status: 'connected' }], permissionMode: 'auto', slashCommands: ['compact', 'context', 'init'] },
    { type: 'user-text', text: 'Build the window shell layout from the Main window v2 design: header, left rail, session grid and status bar.' },
  ];
  let turn = 0;
  let tool = 0;
  let ctx = 20_000;
  while (out.length < target - 60) {
    turn++;
    if (turn % 9 === 0) out.push({ type: 'user-text', text: ['Make the rail icons 18px.', 'Can you keep the status bar at 26px?', 'Looks good, continue with the grid.', 'Use the tokens from the design system.'][rnd(4)]! });
    out.push({ type: 'thinking', text: rnd(3) === 0 ? 'Checking which component owns the spacing before editing.' : '' });
    const n = 2 + rnd(6);
    for (let i = 0; i < n; i++) {
      const id = `sh-${++tool}`;
      const f = FILES[rnd(FILES.length)]!;
      const k = rnd(10);
      if (k < 3) {
        out.push({ type: 'tool-use', toolUseId: id, name: 'Read', input: { file_path: f } });
        out.push({ type: 'tool-result', toolUseId: id, isError: false, content: `// ${f}\nexport function X() {}\n` });
      } else if (k < 5) {
        out.push({ type: 'tool-use', toolUseId: id, name: 'Edit', input: { file_path: f, old_string: `  gap: ${rnd(20)}px;\n  padding: 0 ${rnd(20)}px;`, new_string: `  gap: ${rnd(20)}px;\n  padding: 0 16px;\n  min-height: 0;` } });
        out.push({ type: 'tool-result', toolUseId: id, isError: false, content: `The file ${f} has been updated.` });
      } else if (k < 7) {
        const ok = rnd(6) !== 0;
        out.push({ type: 'tool-use', toolUseId: id, name: 'Bash', input: { command: ['npm run typecheck', 'npx vitest run src/shell', 'npm run lint', 'git status --short'][rnd(4)] } });
        out.push({ type: 'tool-result', toolUseId: id, isError: !ok, content: ok ? ['0 errors', '24 passed', 'No problems', ' M src/shell/Layout.tsx'][rnd(4)]! : 'error TS2322: Type string is not assignable to type number.' });
      } else if (k < 9) {
        out.push({ type: 'tool-use', toolUseId: id, name: 'Grep', input: { pattern: ['#0E1013', 'height: 44', 'Rail', 'useLayout'][rnd(4)], path: 'src' } });
        out.push({ type: 'tool-result', toolUseId: id, isError: false, content: `${1 + rnd(9)} matches\n${f}:12` });
      } else {
        out.push({ type: 'tool-use', toolUseId: id, name: 'Write', input: { file_path: f.replace('.tsx', '.test.tsx'), content: "import { it } from 'vitest';\nit('renders', () => {});\n" } });
        out.push({ type: 'tool-result', toolUseId: id, isError: false, content: 'File created successfully' });
      }
    }
    out.push({ type: 'assistant-text', messageId: `shm-${turn}`, text: NOTES[rnd(NOTES.length)]! });
    ctx = Math.min(180_000, ctx + 900);
    out.push(usageOf(ctx, 700, `shm-${turn}`));
    if (turn % 7 === 0) out.push({ type: 'result', subtype: 'success', isError: false, durationMs: 40_000 + rnd(120_000), numTurns: 3 + rnd(8) });
    if (turn === 150) {
      out.push({ type: 'user-text', text: '/compact' });
      out.push({ type: 'compact', phase: 'started' });
      out.push({ type: 'compact', phase: 'done', preTokens: 168_000, postTokens: 21_000 });
      out.push({ type: 'result', subtype: 'success', isError: false, localCommand: 'compact' });
      ctx = 21_000;
    }
    if (turn === 260) out.push({ type: 'mode-changed', mode: 'acceptEdits' }, { type: 'mode-changed', mode: 'auto' });
  }
  // The three subagents on the Wall tile, with their own transcripts.
  out.push({ type: 'assistant-text', text: 'The layout is in place. I will hand the remaining pieces to subagents.' });
  out.push({ type: 'tool-use', toolUseId: 'sa-explore', name: 'Agent', input: { description: 'Explore layout', subagent_type: 'simple-task', prompt: 'Map the existing layout components.' } });
  for (let i = 0; i < 6; i++) {
    out.push({ type: 'tool-use', toolUseId: `sx-${i}`, name: 'Read', input: { file_path: FILES[i]! }, parentToolUseId: 'sa-explore' });
    out.push({ type: 'tool-result', toolUseId: `sx-${i}`, isError: false, content: 'ok', parentToolUseId: 'sa-explore' });
  }
  out.push({ type: 'assistant-text', text: 'Layout has 6 components; the grid lives in SessionGrid.tsx.', parentToolUseId: 'sa-explore' });
  out.push({ type: 'tool-result', toolUseId: 'sa-explore', isError: false, content: 'Layout has 6 components; the grid lives in SessionGrid.tsx.' });
  out.push({ type: 'tool-use', toolUseId: 'sa-grid', name: 'Agent', input: { description: 'Grid tests', subagent_type: 'standard-task', prompt: 'Write tests for SessionGrid.' } });
  out.push({ type: 'tool-use', toolUseId: 'sa-tokens', name: 'Agent', input: { description: 'Style tokens', subagent_type: 'simple-task', prompt: 'Move colours into tokens.' } });
  out.push({ type: 'tool-use', toolUseId: 'sg-1', name: 'Read', input: { file_path: 'src/shell/SessionGrid.tsx' }, parentToolUseId: 'sa-grid' });
  out.push({ type: 'tool-result', toolUseId: 'sg-1', isError: false, content: 'ok', parentToolUseId: 'sa-grid' });
  out.push({ type: 'tool-use', toolUseId: 'sg-2', name: 'Write', input: { file_path: 'src/shell/SessionGrid.test.tsx', content: "import { it } from 'vitest';\nit('lays out six tiles', () => {});\nit('keeps 300px minimum', () => {});\n" }, parentToolUseId: 'sa-grid' });
  out.push({ type: 'tool-use', toolUseId: 'st-1', name: 'Grep', input: { pattern: '#[0-9A-F]{6}', path: 'src' }, parentToolUseId: 'sa-tokens' });
  out.push({ type: 'tool-result', toolUseId: 'st-1', isError: false, content: '31 matches', parentToolUseId: 'sa-tokens' });
  out.push({ type: 'assistant-text', text: 'Writing SessionGrid.tsx…' });
  return out;
}

const shellEvents = build('a-shell', shellDrafts(5000), ago(14), ago(0.2));

// ---------------------------------------------------------------- a-invoice, a-webhook

const invoiceEvents = build(
  'a-invoice',
  [
    { type: 'init', sessionId: 'sess-invoice', model: 'claude-sonnet-5', cwd: '/Users/you/.oide/worktrees/billing-api/invoice-test', tools: [], mcpServers: [] },
    { type: 'user-text', text: 'The invoice test is flaky in CI. Find out why and fix it.' },
    { type: 'tool-use', toolUseId: 'iv-1', name: 'Bash', input: { command: 'npx vitest run test/invoice.test.ts --repeat 50' } },
    { type: 'tool-result', toolUseId: 'iv-1', isError: true, content: '3 failed, 47 passed\n  expected 2026-11-30, got 2026-12-01' },
    { type: 'tool-use', toolUseId: 'iv-2', name: 'Read', input: { file_path: 'src/invoices/invoice.ts' } },
    { type: 'tool-result', toolUseId: 'iv-2', isError: false, content: 'export function dueDate(d: Date) { … }' },
    { type: 'assistant-text', text: "The test fails around midnight UTC: `dueDate` uses the machine's local time.\n\nShould invoice dates use the **customer's timezone** or always **UTC**?" },
    { type: 'result', subtype: 'success', isError: false, durationMs: 182_000, numTurns: 6 },
  ],
  ago(27),
  ago(20),
);

const webhookEvents = build(
  'a-webhook',
  [
    { type: 'init', sessionId: 'sess-webhook', model: 'claude-opus-5', cwd: '/Users/you/.oide/worktrees/billing-api/webhook-retry', tools: [], mcpServers: [] },
    { type: 'user-text', text: 'Retry failed Stripe webhooks with backoff and a dead-letter queue.' },
    { type: 'tool-use', toolUseId: 'sa-backoff', name: 'Agent', input: { description: 'Backoff', subagent_type: 'standard-task', prompt: 'Implement exponential backoff.' } },
    { type: 'tool-result', toolUseId: 'sa-backoff', isError: false, content: 'Added backoff(attempt) with jitter, capped at 1 hour.' },
    { type: 'tool-use', toolUseId: 'sa-tests', name: 'Agent', input: { description: 'Tests', subagent_type: 'standard-task', prompt: 'Write tests for the retry queue.' } },
    { type: 'tool-result', toolUseId: 'sa-tests', isError: false, content: '18 tests' },
    { type: 'tool-use', toolUseId: 'sa-reviewer', name: 'Agent', input: { description: 'Reviewer', subagent_type: 'complex-task', prompt: 'Review the change.' } },
    { type: 'tool-result', toolUseId: 'sa-reviewer', isError: false, content: '2 rounds, nothing left' },
    {
      type: 'review-submitted',
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
    },
    { type: 'result', subtype: 'success', isError: false, durationMs: 2_280_000, numTurns: 31 },
  ],
  ago(41),
  ago(3),
);

export const focusEvents: Record<string, AgentEvent[]> = {
  'a-bridge': bridgeEvents,
  'a-shell': shellEvents,
  'a-invoice': invoiceEvents,
  'a-webhook': webhookEvents,
};

/** Changes tab for the canvas agent. */
export const focusDiffs: Record<string, FileDiff[]> = {
  'a-bridge': [
    FileDiff.parse({ path: 'src/main/cli/SessionHost.ts', status: 'modified', additions: 86, deletions: 4, patch: "@@ -1,4 +1,86 @@\n+const pty = spawn('claude', ['--output-format', 'stream-json'], {\n+  cwd: worktree.path, env: session.env,\n+});\n" }),
    FileDiff.parse({ path: 'src/main/cli/parser.ts', status: 'added', additions: 41, deletions: 0, patch: '@@ -0,0 +1,41 @@\n+export class Parser {}\n' }),
    FileDiff.parse({ path: 'package.json', status: 'modified', additions: 0, deletions: 0, patch: '' }),
  ],
};

/** Summary fields Focus reads that fixtures.ts does not set (prompt tool_use id, plan usage). */
export function patchFocusAgent(a: AgentSummary): AgentSummary {
  if (a.id !== 'a-bridge') return a;
  const monday = new Date(NOW);
  monday.setDate(monday.getDate() + ((8 - monday.getDay()) % 7 || 7));
  monday.setHours(9, 0, 0, 0);
  return {
    ...a,
    pendingPermission: a.pendingPermission ? { ...a.pendingPermission, toolUseId: 'sd-3' } : a.pendingPermission,
    planUsage: { status: 'allowed', window: 'seven_day', utilization: 0.38, resetsAt: monday.getTime() },
  };
}

type Handlers = { [K in CommandName]?: (input: CommandInput<K>) => CommandOutput<K> | Promise<CommandOutput<K>> };

const MOCK_SCRIPTS: ProjectScript[] = ['build', 'dev', 'dev:watch', 'test', 'lint', 'typecheck'].map((name) => ({
  id: `pnpm:package.json:${name}`,
  name,
  runner: 'pnpm',
  command: `pnpm run ${name}`,
  file: 'package.json',
}));

/**
 * Focus commands: a pretend shell for the Terminal tab (echoes lines; `ls`, `pwd`, `git status`)
 * and Stop subagent.
 */
export function focusHandlers(emit: <K extends EventName>(e: K, p: EventPayload<K>) => void): Handlers {
  const terms = new Map<string, { cwd: string; line: string }>();
  let n = 0;
  const prompt = (cwd: string) => `\x1b[38;2;127;200;169m${cwd.split('/').pop()}\x1b[0m \x1b[38;2;107;117;132m$\x1b[0m `;
  const run = (cmd: string, cwd: string): string => {
    const c = cmd.trim();
    if (!c) return '';
    if (c === 'pwd') return `${cwd}\r\n`;
    if (c === 'ls') return 'package.json  src  test  tsconfig.json  node_modules\r\n';
    if (c === 'git status') return 'On branch oide/cli-bridge\r\nChanges not staged for commit:\r\n\t\x1b[31mmodified:   src/main/cli/SessionHost.ts\x1b[0m\r\n';
    return `\x1b[38;2;107;117;132m(mock shell) ${c}\x1b[0m\r\n`;
  };
  return {
    'terminal.create': ({ cwd }) => {
      const terminalId = `term-focus-${++n}`;
      terms.set(terminalId, { cwd, line: '' });
      setTimeout(() => emit('terminal.data', { terminalId, data: `\x1b[38;2;154;163;174mMock terminal (dev:web). In the app this is a real shell in the worktree.\x1b[0m\r\n${prompt(cwd)}` }), 50);
      return { terminalId };
    },
    'terminal.write': ({ terminalId, data }) => {
      const t = terms.get(terminalId);
      if (!t) throw new Error('[not_found] No such terminal');
      let echo = '';
      for (const ch of data) {
        if (ch === '\r') {
          echo += `\r\n${run(t.line, t.cwd)}${prompt(t.cwd)}`;
          t.line = '';
        } else if (ch === '\x7f') {
          if (t.line) {
            t.line = t.line.slice(0, -1);
            echo += '\b \b';
          }
        } else if (ch >= ' ') {
          t.line += ch;
          echo += ch;
        }
      }
      if (echo) emit('terminal.data', { terminalId, data: echo });
      return { ok: true as const };
    },
    // Files › Run (dev:web): a package.json's scripts, run by typing the command into a mock shell.
    'scripts.list': () => MOCK_SCRIPTS,
    'terminal.runScript': ({ cwd, scriptId }) => {
      const script = MOCK_SCRIPTS.find((x) => x.id === scriptId);
      if (!script) throw new Error('[not_found] That script is no longer in this checkout.');
      const terminalId = `term-focus-${++n}`;
      terms.set(terminalId, { cwd, line: '' });
      setTimeout(() => emit('terminal.data', { terminalId, data: `${prompt(cwd)}${script.command}\r\n\x1b[38;2;107;117;132m(mock shell) ${script.command}\x1b[0m\r\n${prompt(cwd)}` }), 50);
      return { terminalId, script };
    },
    'terminal.resize': () => ({ ok: true as const }),
    'terminal.kill': ({ terminalId }) => {
      terms.delete(terminalId);
      return { ok: true as const };
    },
    'agents.stopSubagent': () => ({ ok: true as const }),
  };
}

/**
 * Live demo: every 20 s the shell agent streams a short reply as partial deltas, then the full
 * assistant text, so "Writing…" and auto-scroll can be checked in dev:web.
 */
export function startFocusDemo(emit: <K extends EventName>(e: K, p: EventPayload<K>) => void, events: Map<string, AgentEvent[]>): void {
  const words = 'Grid tests pass. I moved the status bar counts into the store and kept the bar at 26px, as the design asks.'.split(' ');
  let round = 0;
  setInterval(() => {
    const list = events.get('a-shell');
    if (!list) return;
    const messageId = `demo-${++round}`;
    words.forEach((w, i) => {
      setTimeout(() => {
        const ev = AgentEvent.parse({ type: 'partial', agentId: 'a-shell', seq: list.length, ts: Date.now(), messageId, kind: 'text', delta: `${i ? ' ' : ''}${w}` });
        emit('agents.batch', { events: [ev] });
      }, i * 90);
    });
    setTimeout(() => {
      const ev = AgentEvent.parse({ type: 'assistant-text', agentId: 'a-shell', seq: list.length, ts: Date.now(), messageId, text: words.join(' ') });
      list.push(ev);
      emit('agents.batch', { events: [ev] });
    }, words.length * 90 + 200);
  }, 20_000);
}
