/**
 * MOCK DATA for the Artifacts, Marketplace and Settings screens (dev:web only, never in production
 * bundles). Values follow the designs (docs/wiki/raw/design/Artifacts.dc.html, Marketplace.dc.html,
 * Settings.dc.html). The marketplace entries below are invented sample data from the design canvas,
 * not real published extensions.
 *
 * `libraryHandlers(ctx)` returns mock IPC handlers that mockBridge.ts spreads into its handler map.
 * Every value is parsed through the protocol schemas, so fixtures cannot drift from the contract.
 */
import {
  ArtifactMeta,
  ArtifactUse,
  ArtifactVersion,
  CustomModel,
  CustomServer,
  ExtensionManifest,
  FocusPreset,
  InstalledExtension,
  MarketplaceEntry,
  Technique,
  type ArtifactKind,
  type Commands,
  type CommandInput,
  type CommandName,
  type CommandOutput,
  type EventName,
  type EventPayload,
  type Settings,
} from '@oide/protocol';
import type { z } from 'zod';
import { projects } from './fixtures';

/** Handlers receive the input after Zod parsing (defaults applied), like main's handlers. */
type ParsedInput<K extends CommandName> = z.output<(typeof Commands)[K]['input']>;
type ParsedHandlers = { [K in CommandName]?: (input: ParsedInput<K>) => CommandOutput<K> | Promise<CommandOutput<K>> };
/** The shape of mockBridge's handler map (typed by the raw input; the bridge parses before calling). */
export type MockHandlers = { [K in CommandName]?: (input: CommandInput<K>) => CommandOutput<K> | Promise<CommandOutput<K>> };

export interface LibraryMockContext {
  emit: <K extends EventName>(event: K, payload: EventPayload<K>) => void;
  getSettings: () => Settings;
  setSettings: (s: Settings) => void;
}

const MIN = 60_000;
const NOW = Date.now();
const ago = (m: number) => NOW - m * MIN;
const fail = (code: string, message: string): never => {
  throw new Error(`[${code}] ${message}`);
};
let seq = 1;
const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(seq++).toString(36)}`;

/* =================================================================== artifacts */

const DESIGN_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Main window v2</title>
<style>
body{margin:0;background:#0E1013;color:#E6E8EB;font:13px Inter,system-ui,sans-serif;display:flex;flex-direction:column;height:100vh}
header{height:36px;border-bottom:1px solid #232830;background:#0B0D10;display:flex;align-items:center;padding:0 12px;font-weight:700}
main{flex:1;display:flex}
nav{width:44px;background:#0B0D10;border-right:1px solid #232830}
.grid{flex:1;display:grid;grid-template-columns:repeat(3,1fr);gap:10px;padding:14px}
.tile{border:1px solid #262B33;background:#15181D;border-radius:10px;padding:10px}
.tile b{display:block;margin-bottom:6px}.tile i{display:block;height:6px;margin:5px 0;background:#2B3240;border-radius:3px}
</style></head>
<body><header>oIDE</header><main><nav></nav><div class="grid">
<div class="tile"><b>Window shell layout</b><i></i><i style="width:70%"></i></div>
<div class="tile"><b>Claude CLI bridge</b><i></i><i style="width:60%"></i></div>
<div class="tile"><b>Manifest schema</b><i></i><i style="width:80%"></i></div>
<div class="tile"><b>Webhook retry</b><i></i><i style="width:50%"></i></div>
<div class="tile"><b>Invoice test</b><i></i><i style="width:65%"></i></div>
<div class="tile"><b>Getting started</b><i></i><i style="width:75%"></i></div>
</div></main></body></html>`;

const INVOICE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Invoice page</title>
<style>body{margin:0;padding:24px;background:#fff;color:#111;font:14px system-ui}h1{font-size:20px}table{width:100%;border-collapse:collapse}td{border-bottom:1px solid #ddd;padding:8px 0}</style>
</head><body><h1>Invoice #2041</h1><table><tr><td>Pro plan</td><td>$49.00</td></tr><tr><td>Extra seats (3)</td><td>$27.00</td></tr><tr><td><b>Total</b></td><td><b>$76.00</b></td></tr></table></body></html>`;

const RFC_MD = `---
title: Extension manifest RFC
kind: doc
---

# Extension manifest RFC

An oIDE extension is an npm package with an \`oide\` key in its \`package.json\`.

## Goals

- Give agents **tools** through MCP servers, each with a risk label.
- Add UI: panels, commands, themes.
- Never run install scripts.

## Risk labels

| Label | Meaning |
| --- | --- |
| \`read\` | Pre-allowed when the extension is on |
| \`ask\` | Always shows a permission prompt |

<script>alert('scripts are stripped by DOMPurify')</script>
`;

const WEBHOOK_MD = `---
title: Webhook retry design
kind: doc
---

# Webhook retry design

Failed Stripe webhooks retry with exponential backoff (1s, 2s, 4s … capped at 10 minutes).
After 8 attempts the event moves to a **dead-letter queue** that an operator can replay.
`;

const board = (elements: unknown[]) => JSON.stringify({ type: 'excalidraw', version: 2, source: 'oide', elements, appState: { viewBackgroundColor: '#1B1F26' } }, null, 2);

const LIFECYCLE_BOARD = board([
  { id: 'r1', type: 'rectangle', x: 20, y: 40, width: 120, height: 60, strokeColor: '#9DBBFA', backgroundColor: 'transparent' },
  { id: 't1', type: 'text', x: 44, y: 62, text: 'Spawned', fontSize: 16, strokeColor: '#E6E8EB' },
  { id: 'a1', type: 'arrow', x: 140, y: 70, points: [[0, 0], [80, 0]], strokeColor: '#6B7584' },
  { id: 'e1', type: 'ellipse', x: 220, y: 40, width: 120, height: 60, strokeColor: '#7FC8A9', backgroundColor: 'transparent' },
  { id: 't2', type: 'text', x: 248, y: 62, text: 'Running', fontSize: 16, strokeColor: '#E6E8EB' },
  { id: 'a2', type: 'arrow', x: 280, y: 100, points: [[0, 0], [-60, 60]], strokeColor: '#6B7584' },
  { id: 'd1', type: 'diamond', x: 140, y: 160, width: 140, height: 70, strokeColor: '#F2C078', backgroundColor: '#5A4A2A' },
  { id: 't3', type: 'text', x: 168, y: 186, text: 'Needs you', fontSize: 16, strokeColor: '#E6E8EB' },
]);

const IA_BOARD = board([
  { id: 'r1', type: 'rectangle', x: 20, y: 20, width: 140, height: 50, strokeColor: '#9DBBFA' },
  { id: 't1', type: 'text', x: 50, y: 36, text: 'Getting started', fontSize: 14, strokeColor: '#E6E8EB' },
  { id: 'l1', type: 'line', x: 90, y: 70, points: [[0, 0], [0, 40]], strokeColor: '#6B7584' },
  { id: 'r2', type: 'rectangle', x: 20, y: 110, width: 140, height: 50, strokeColor: '#7FC8A9' },
  { id: 't2', type: 'text', x: 62, y: 126, text: 'Guides', fontSize: 14, strokeColor: '#E6E8EB' },
]);

interface MockArtifact {
  meta: ArtifactMeta;
  content: string;
  versions: ArtifactVersion[];
  snapshots: Record<number, string>;
}

function art(
  meta: Omit<ArtifactMeta, 'entry' | 'slug' | 'createdAt'> & { createdAt?: number },
  content: string,
  history: Array<[author: string, minutesAgo: number, note?: string]>,
): MockArtifact {
  const entry = meta.kind === 'design' ? 'index.html' : meta.kind === 'doc' ? 'doc.md' : 'board.excalidraw';
  const slug = meta.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const versions = history.map(([author, m, note], i) => ArtifactVersion.parse({ version: i + 1, ts: ago(m), author, note }));
  const snapshots: Record<number, string> = {};
  versions.forEach((v) => (snapshots[v.version] = v.version === versions.length ? content : `${content}\n<!-- version ${v.version} -->`));
  if (meta.kind === 'whiteboard') versions.forEach((v) => (snapshots[v.version] = content));
  return {
    meta: ArtifactMeta.parse({ ...meta, slug, entry, version: versions.length, createdAt: meta.createdAt ?? versions[0]!.ts, updatedAt: versions[versions.length - 1]!.ts }),
    content,
    versions: [...versions].reverse(),
    snapshots,
  };
}

const artifactSeed: MockArtifact[] = [
  art({ id: 'art-main-v2', title: 'Main window v2', kind: 'design', projectId: 'oide', location: 'repo', importedFrom: 'https://claude.ai/public/artifacts/0b6c-main-window-v2', version: 4, updatedAt: 0 }, DESIGN_HTML, [
    ['user', 900, 'Imported from claude.ai'],
    ['agent:a-shell', 400, 'Tightened the tile grid'],
    ['agent:a-shell', 68, 'Added a focus view'],
    ['user', 40, 'Edited by you'],
  ]),
  art({ id: 'art-manifest-rfc', title: 'Extension manifest RFC', kind: 'doc', projectId: 'oide', location: 'repo', version: 1, updatedAt: 0 }, RFC_MD, [
    ['agent:a-manifest', 5, 'Created'],
    ['agent:a-manifest', 1, 'Added risk labels'],
  ]),
  art({ id: 'art-lifecycle', title: 'Session lifecycle', kind: 'whiteboard', projectId: 'oide', location: 'app-data', version: 1, updatedAt: 0 }, LIFECYCLE_BOARD, [
    ['user', 900],
    ['user', 200, 'Added Needs you'],
  ]),
  art({ id: 'art-webhook', title: 'Webhook retry design', kind: 'doc', projectId: 'billing-api', location: 'repo', version: 1, updatedAt: 0 }, WEBHOOK_MD, [
    ['user', 300],
    ['agent:a-webhook', 62, 'Documented the dead-letter queue'],
  ]),
  art({ id: 'art-invoice', title: 'Invoice page', kind: 'design', projectId: 'billing-api', location: 'app-data', version: 1, updatedAt: 0 }, INVOICE_HTML, [['user', 2000]]),
  art({ id: 'art-docs-ia', title: 'Docs IA sketch', kind: 'whiteboard', projectId: 'docs-site', location: 'repo', version: 1, updatedAt: 0 }, IA_BOARD, [['user', 3000]]),
];

const useSeed: ArtifactUse[] = [
  { artifactId: 'art-main-v2', agentId: 'a-shell', op: 'read', ts: ago(12) },
  { artifactId: 'art-main-v2', agentId: 'a-bridge', op: 'read', ts: ago(18) },
  { artifactId: 'art-manifest-rfc', agentId: 'a-manifest', op: 'write', ts: ago(1) },
  { artifactId: 'art-lifecycle', agentId: 'a-bridge', op: 'read', ts: ago(15) },
  { artifactId: 'art-webhook', agentId: 'a-webhook', op: 'write', ts: ago(62) },
  { artifactId: 'art-docs-ia', agentId: 'a-docs', op: 'read', ts: ago(20) },
].map((u) => ArtifactUse.parse(u));

/* ================================================================= marketplace */

const SHA = 'sha512-bW9jay1pbnRlZ3JpdHktbm90LWEtcmVhbC1oYXNo';
type ToolDef = [name: string, risk: 'read' | 'ask', description?: string];
const version = (v: string, tools: ToolDef[], capabilities: { network?: string[]; spawn?: boolean } = {}) => ({
  version: v,
  tarball: `https://registry.npmjs.org/mock/-/mock-${v}.tgz`,
  integrity: SHA,
  engine: '^1.0.0',
  tools: tools.map(([name, risk, description]) => ({ name, risk, description })),
  capabilities: { network: capabilities.network ?? [], spawn: capabilities.spawn ?? false },
});

export const marketplaceEntries: MarketplaceEntry[] = [
  {
    name: '@oide-community/postgres-inspector',
    displayName: 'Postgres inspector',
    publisher: 'oide-community',
    description: 'Lets agents look at your database schema and run read-only queries while they work.',
    categories: ['agent-tools'],
    repository: 'https://github.com/oide-community/postgres-inspector',
    verified: true,
    downloads: 18_400,
    updatedAt: '2026-11-10',
    versions: [version('0.9.2', [['db.schema', 'read', 'Describe tables and columns'], ['db.query', 'read', 'Run a read-only query'], ['db.explain', 'read', 'Explain a query plan']], { network: ['localhost'], spawn: true })],
  },
  {
    name: '@oide/ext-browser-preview',
    displayName: 'Browser preview',
    publisher: 'oide',
    description: 'Agents open your dev server, take screenshots and read the console to check UI changes.',
    categories: ['agent-tools', 'views-panels'],
    repository: 'https://github.com/oide-dev/oide',
    verified: true,
    source: 'builtin',
    downloads: 52_000,
    updatedAt: '2026-11-20',
    versions: [version('1.0.0', [['browser.open', 'read'], ['browser.screenshot', 'read'], ['browser.click', 'ask']], { network: ['localhost'] })],
  },
  {
    name: 'oide-preview-deploys',
    displayName: 'Preview deploys',
    publisher: 'community',
    description: 'Agents create preview deployments from their worktree and report the URL on the tile.',
    categories: ['agent-tools', 'deploy-targets'],
    verified: false,
    downloads: 6_100,
    updatedAt: '2026-10-02',
    versions: [version('0.4.0', [['deploy.preview', 'ask', 'Create a preview deployment'], ['deploy.logs', 'read', 'Read build logs']], { network: ['api.vercel.com', 'api.netlify.com'], spawn: true })],
  },
  {
    name: '@oide/ext-git',
    displayName: 'Git',
    publisher: 'oide',
    description: 'Branches, worktrees, commits and pull requests for every agent session.',
    categories: ['agent-tools', 'review-testing'],
    repository: 'https://github.com/oide-dev/oide',
    verified: true,
    source: 'builtin',
    downloads: 61_000,
    updatedAt: '2026-11-20',
    versions: [version('1.0.0', [['git.worktree', 'read'], ['git.commit', 'ask'], ['git.push', 'ask']], { network: ['github.com'], spawn: true })],
  },
  {
    name: 'oide-error-tracker',
    displayName: 'Error tracker',
    publisher: 'community',
    description: 'Agents pull the stack traces of an error before trying to fix it.',
    categories: ['agent-tools'],
    verified: false,
    downloads: 9_800,
    updatedAt: '2026-09-14',
    versions: [version('2.1.0', [['errors.issue', 'read'], ['errors.events', 'read']], { network: ['sentry.io'] })],
  },
  {
    name: 'oide-playwright-runner',
    displayName: 'Playwright runner',
    publisher: 'oide-community',
    description: 'Agents run your end-to-end tests and attach traces of failing ones to the review.',
    categories: ['review-testing'],
    verified: true,
    downloads: 12_300,
    updatedAt: '2026-11-22',
    versions: [
      version('1.3.0', [['e2e.run', 'ask', 'Run the end-to-end suite'], ['e2e.trace', 'read', 'Open a failing trace'], ['e2e.record', 'ask', 'Record a new test']], { spawn: true, network: ['localhost'] }),
      version('1.2.0', [['e2e.run', 'ask', 'Run the end-to-end suite'], ['e2e.trace', 'read', 'Open a failing trace']], { spawn: true }),
    ],
  },
  {
    name: '@oide/ext-themes',
    displayName: 'Accent themes',
    publisher: 'oide',
    description: 'Blue, green, violet and amber accents for the whole app.',
    categories: ['themes'],
    verified: true,
    source: 'builtin',
    downloads: 40_000,
    updatedAt: '2026-11-20',
    versions: [version('1.0.0', [])],
  },
  {
    name: 'oide-openapi-artifacts',
    displayName: 'OpenAPI specs',
    publisher: 'community',
    description: 'A new artifact type: agents read and edit OpenAPI specs, with a rendered preview.',
    categories: ['artifact-types'],
    verified: false,
    downloads: 2_400,
    updatedAt: '2026-08-30',
    versions: [version('0.2.1', [['openapi.validate', 'read']])],
  },
  {
    name: 'oide-rust-analyzer',
    displayName: 'Rust',
    publisher: 'community',
    description: 'rust-analyzer as a language server for the editor and for agents.',
    categories: ['languages'],
    verified: false,
    downloads: 3_900,
    updatedAt: '2026-10-28',
    versions: [version('0.3.0', [], { spawn: true })],
  },
].map((e) => MarketplaceEntry.parse(e));

function manifestFor(entry: MarketplaceEntry, v = entry.versions[0]!): ExtensionManifest {
  const server = entry.displayName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return ExtensionManifest.parse({
    name: entry.name,
    version: v.version,
    description: entry.description,
    oide: {
      engine: v.engine,
      displayName: entry.displayName,
      publisher: entry.publisher,
      categories: entry.categories,
      mcpServers: v.tools.length
        ? { [server]: { command: 'node', args: ['dist/server.js'], tools: Object.fromEntries(v.tools.map((t) => [t.name, { risk: t.risk, description: t.description }])) } }
        : {},
      capabilities: { network: v.capabilities?.network ?? [], spawn: v.capabilities?.spawn ?? false, fs: [] },
    },
  });
}

function installedFrom(name: string, opts: Partial<InstalledExtension> & { versionIndex?: number } = {}): InstalledExtension {
  const entry = marketplaceEntries.find((e) => e.name === name)!;
  const v = entry.versions[opts.versionIndex ?? 0]!;
  return InstalledExtension.parse({
    id: `ext-${entry.displayName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    name: entry.name,
    version: v.version,
    displayName: entry.displayName,
    source: entry.source === 'builtin' ? 'builtin' : 'marketplace',
    path: `/mock/extensions/${entry.name}@${v.version}`,
    enabledGlobally: entry.source === 'builtin',
    reviewed: entry.verified,
    manifest: manifestFor(entry, v),
    ...opts,
  });
}

const installedSeed = (): InstalledExtension[] => [
  installedFrom('@oide/ext-browser-preview', { enabledGlobally: false, enabledProjects: ['billing-api'] }),
  installedFrom('@oide/ext-git'),
  installedFrom('@oide/ext-themes'),
  installedFrom('oide-playwright-runner', { versionIndex: 1, enabledProjects: ['oide'] }),
];

const customSeed = (): CustomServer[] =>
  [
    {
      id: 'custom-team-wiki',
      name: 'team-wiki',
      route: 'url',
      transport: { kind: 'http', url: 'https://wiki.internal.example/mcp', auth: 'oauth' },
      tools: [
        { name: 'wiki.search', risk: 'read', description: 'Search pages' },
        { name: 'wiki.page', risk: 'read', description: 'Read a page' },
        { name: 'wiki.comment', risk: 'ask', description: 'Comment on a page' },
      ],
      projects: ['billing-api'],
      allProjects: false,
      savedTo: 'my-settings',
      serverInfo: 'Team wiki v1.4',
    },
  ].map((c) => CustomServer.parse(c));

const URL_TOOLS: Array<[string, string, boolean | undefined, boolean | undefined]> = [
  ['metrics.query', 'Run a metrics query', true, undefined],
  ['metrics.dashboards', 'List dashboards', true, undefined],
  ['alerts.list', 'List open alerts', true, undefined],
  ['alerts.silence', 'Silence an alert', undefined, true],
  ['annotations.create', 'Mark a deploy on graphs', undefined, undefined],
  ['metrics.export', 'Export a time series', true, undefined],
];

const SCAN = [
  { source: 'Claude Desktop', file: '/Users/you/Library/Application Support/Claude/claude_desktop_config.json', name: 'filesystem', kind: 'stdio' as const, display: 'npx -y @modelcontextprotocol/server-filesystem ~/code' },
  { source: 'billing-api/.mcp.json', file: '/Users/you/code/billing-api/.mcp.json', name: 'postgres-local', kind: 'stdio' as const, display: 'docker run mcp/postgres postgresql://localhost/billing' },
  { source: 'Claude Code · your settings', file: '/Users/you/.claude.json', name: 'issue-tracker', kind: 'http' as const, display: 'https://mcp.tracker.example/mcp' },
  { source: 'Claude Code · your settings', file: '/Users/you/.claude.json', name: 'playwright', kind: 'stdio' as const, display: 'npx @playwright/mcp' },
  { source: 'Another editor', file: '/Users/you/.cursor/mcp.json', name: 'notes', kind: 'stdio' as const, display: 'uvx notes-mcp' },
];

/* ==================================================================== settings */

export const builtInPresets: FocusPreset[] = [
  {
    id: 'cheap',
    name: 'Cheap',
    description: 'Sonnet leads; subagents always use Haiku.',
    builtIn: true,
    strategy: { kind: 'subagent-model', lead: { model: 'sonnet', effort: 'medium' }, subagents: { model: 'haiku', effort: 'low' } },
  },
  {
    id: 'balanced',
    name: 'Balanced',
    description: 'Opus leads and routes subagents by task size: simple to Haiku, standard to Sonnet, complex to Opus.',
    builtIn: true,
    strategy: { kind: 'routed', lead: { model: 'opus', effort: 'high' }, simple: { model: 'haiku', effort: 'low' }, standard: { model: 'sonnet', effort: 'medium' }, complex: { model: 'opus', effort: 'high' } },
  },
  { id: 'quality', name: 'Quality', description: 'Opus for everything, at maximum effort.', builtIn: true, strategy: { kind: 'single', lead: { model: 'opus', effort: 'max' } } },
].map((p) => FocusPreset.parse(p));

export const builtInTechniques: Technique[] = [
  {
    id: 'review',
    name: 'Adversarial review',
    description: 'A reviewer subagent hunts for problems in the diff before the agent finishes.',
    text: 'When your changes are complete, start a separate reviewer subagent whose only job is to find bugs, regressions, security issues and missed requirements in your diff. Fix what it finds and repeat until it reports nothing significant.',
    placement: 'first-message',
    builtIn: true,
    enabledByDefault: true,
  },
  {
    id: 'docs',
    name: 'Full docs and tests',
    description: 'Documentation and tests for everything changed, written at the end.',
    text: 'Before you finish, update or write documentation for everything you changed, and add tests that cover the new behaviour and its edge cases.',
    placement: 'first-message',
    builtIn: true,
    enabledByDefault: false,
  },
  {
    id: 'gates',
    name: 'Quality gates must pass',
    description: 'Build, tests, lint and type checks all pass before the agent says it is done.',
    text: 'You are not done until the build, the full test suite, lint, type checks and every other quality gate in this project pass. Run them, fix any failures, and report the results.',
    placement: 'first-message',
    builtIn: true,
    enabledByDefault: true,
  },
].map((t) => Technique.parse(t));

/** Seeds the mock bridge's global settings with built-ins and the values drawn in Settings.dc.html. */
export function seedLibrarySettings(base: Settings): Settings {
  return {
    ...base,
    claude: { ...base.claude, allowBypass: true },
    models: {
      ...base.models,
      presets: structuredClone(builtInPresets),
      custom: [CustomModel.parse({ id: 'model-local-coder', name: 'local-coder', provider: 'local', baseUrl: 'http://localhost:11434', model: 'qwen3-coder:30b', hasKey: false })],
    },
    agents: { ...base.agents, contextWarnAt: 0.65, contextSuggestCompactAt: 0.85, notifications: { needsPermission: true, readyForReview: true, error: false } },
    techniques: structuredClone(builtInTechniques),
  };
}

/* ==================================================================== handlers */

export function libraryHandlers(ctx: LibraryMockContext): MockHandlers {
  return createHandlers(ctx) as unknown as MockHandlers;
}

function createHandlers(ctx: LibraryMockContext): ParsedHandlers {
  const artifacts = new Map(artifactSeed.map((a) => [a.meta.id, structuredClone(a)]));
  let uses = [...useSeed];
  let installed = installedSeed();
  let custom = customSeed();
  const projectTechniques = new Map<string, Technique[]>([
    ['oide', [Technique.parse({ id: 'oide-changelog', name: 'Update the changelog', description: 'Adds a line to CHANGELOG.md for user-facing changes.', text: 'If your change is user-facing, add one line to CHANGELOG.md under Unreleased.', placement: 'first-message', scope: 'project' })]],
  ]);
  const projectPerms = new Map<string, { allow: string[]; ask: string[]; deny: string[] }>([
    ['oide', { allow: ['Bash(npm run typecheck)', 'Bash(npm test)', 'Bash(npm install:*)'], ask: [], deny: ['Bash(git push --force:*)'] }],
    ['billing-api', { allow: ['Bash(pnpm test)'], ask: [], deny: [] }],
    ['docs-site', { allow: [], ask: [], deny: [] }],
  ]);
  const authorized = new Set<string>(['custom-team-wiki']);

  const changedExt = () => ctx.emit('extensions.changed', installed);
  const getArt = (id: string) => artifacts.get(id) ?? fail('not_found', `No artifact ${id}`);

  return {
    /* ---- artifacts */
    'artifacts.list': ({ projectId, kind }) =>
      [...artifacts.values()].map((a) => a.meta).filter((m) => (!projectId || m.projectId === projectId) && (!kind || m.kind === kind)).sort((a, b) => b.updatedAt - a.updatedAt),
    'artifacts.get': ({ id }) => {
      const a = getArt(id);
      return { meta: a.meta, content: a.content, uses: uses.filter((u) => u.artifactId === id).sort((x, y) => y.ts - x.ts), versions: a.versions };
    },
    'artifacts.uses': ({ ids }) => Object.fromEntries(ids.map((id) => [id, uses.filter((u) => u.artifactId === id)])),
    'artifacts.readVersion': ({ id, version: v }) => {
      const a = getArt(id);
      return { content: a.snapshots[v] ?? fail('not_found', `No version ${v}`) };
    },
    'artifacts.save': ({ id, content, note }) => {
      const a = getArt(id);
      if (a.meta.kind === 'whiteboard') {
        try {
          if (typeof JSON.parse(content) !== 'object') throw new Error();
        } catch {
          fail('invalid_input', 'A whiteboard must be a JSON object');
        }
      }
      const next = a.meta.version + 1;
      a.content = content;
      a.snapshots[next] = content;
      a.versions = [ArtifactVersion.parse({ version: next, ts: Date.now(), author: 'user', note }), ...a.versions];
      a.meta = { ...a.meta, version: next, updatedAt: Date.now() };
      ctx.emit('artifacts.changed', { id });
      return a.meta;
    },
    'artifacts.create': ({ title, kind, projectId, location, content }) => {
      if (location === 'repo' && !projectId) fail('invalid_input', 'A repo artifact needs a project');
      const initial =
        content ??
        (kind === 'design'
          ? `<!doctype html>\n<html><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1></body></html>`
          : kind === 'doc'
            ? `---\ntitle: ${title}\nkind: doc\n---\n\n# ${title}\n`
            : board([]));
      const a = art({ id: newId('art'), title, kind, projectId, location: location ?? 'app-data', version: 1, updatedAt: 0 }, initial, [['user', 0, 'Created']]);
      artifacts.set(a.meta.id, a);
      ctx.emit('artifacts.changed', { id: a.meta.id });
      return a.meta;
    },
    'artifacts.import': ({ url, filePath, title, kind, projectId, location }) => {
      let k: ArtifactKind = kind ?? 'doc';
      let t = title;
      let content = '';
      if (url) {
        const host = new URL(url).hostname;
        if (!['claude.ai', 'claude.site'].some((h) => host === h || host.endsWith(`.${h}`))) fail('invalid_input', 'Only claude.ai links can be imported');
        t ??= 'Imported from claude.ai';
        content = k === 'doc' ? `---\ntitle: ${t}\nkind: doc\nimportedFrom: ${url}\n---\n\n# ${t}\n\nA copy of a claude.ai artifact. Paste its content here; it is not synced.\n` : k === 'design' ? `<!doctype html><html><body><p>Imported from ${url}</p></body></html>` : board([]);
      } else if (filePath) {
        const name = filePath.split(/[\\/]/).pop() ?? 'file';
        k = kind ?? (/\.html?$/i.test(name) ? 'design' : /\.(excalidraw|json)$/i.test(name) ? 'whiteboard' : 'doc');
        t ??= name.replace(/\.[^.]+$/, '');
        content = k === 'doc' ? `# ${t}\n\nImported from ${name}.\n` : k === 'design' ? DESIGN_HTML : LIFECYCLE_BOARD;
      } else fail('invalid_input', 'Paste a link or pick a file');
      const a = art({ id: newId('art'), title: t!, kind: k, projectId, location: location ?? 'app-data', importedFrom: url, version: 1, updatedAt: 0 }, content, [['user', 0, url ? 'Imported from claude.ai' : 'Imported from a file']]);
      artifacts.set(a.meta.id, a);
      ctx.emit('artifacts.changed', { id: a.meta.id });
      return a.meta;
    },
    'artifacts.delete': ({ id }) => {
      artifacts.delete(id);
      uses = uses.filter((u) => u.artifactId !== id);
      ctx.emit('artifacts.changed', { id });
      return { ok: true as const };
    },
    'dialog.pickFile': () => '/Users/you/Downloads/pricing-page.html',

    /* ---- marketplace */
    'extensions.index': () => marketplaceEntries,
    'extensions.installed': () => installed,
    'extensions.install': ({ name, version: v }) => {
      const entry = marketplaceEntries.find((e) => e.name === name) ?? fail('not_found', `No extension ${name} in the index`);
      if (entry.source === 'builtin') fail('invalid_input', 'Built-in extensions ship with oIDE');
      const idx = v ? entry.versions.findIndex((x) => x.version === v) : 0;
      const rec = installedFrom(name, { versionIndex: Math.max(0, idx), enabledGlobally: true });
      installed = [...installed.filter((e) => e.name !== name), rec];
      changedExt();
      return rec;
    },
    'extensions.uninstall': ({ id }) => {
      const rec = installed.find((e) => e.id === id) ?? fail('not_found', 'Not installed');
      if (rec.source === 'builtin') fail('invalid_input', 'Built-in extensions cannot be removed');
      installed = installed.filter((e) => e.id !== id);
      changedExt();
      return { ok: true as const };
    },
    'extensions.setEnabled': ({ id, projectId, enabled }) => {
      const rec = installed.find((e) => e.id === id) ?? fail('not_found', 'Not installed');
      let next: InstalledExtension;
      if (!projectId) next = { ...rec, enabledGlobally: enabled, disabledProjects: enabled ? rec.disabledProjects : [] };
      else if (enabled) next = { ...rec, enabledProjects: [...new Set([...rec.enabledProjects, projectId])], disabledProjects: rec.disabledProjects.filter((p) => p !== projectId) };
      else next = { ...rec, enabledProjects: rec.enabledProjects.filter((p) => p !== projectId), disabledProjects: rec.enabledGlobally ? [...new Set([...rec.disabledProjects, projectId])] : rec.disabledProjects };
      installed = installed.map((e) => (e.id === id ? next : e));
      changedExt();
      return next;
    },
    'extensions.setToolEnabled': ({ id, tool, server, enabled }) => {
      const rec = installed.find((e) => e.id === id) ?? fail('not_found', 'Not installed');
      const clean = (x: string) => x.replace(/[^A-Za-z0-9_-]/g, '_');
      const srv = server ?? Object.entries(rec.manifest.oide.mcpServers).find(([, d]) => tool in d.tools)?.[0] ?? '';
      const name = tool.startsWith('mcp__') ? tool : `mcp__${clean(srv)}__${clean(tool)}`;
      const next = { ...rec, disabledTools: enabled ? rec.disabledTools.filter((t) => t !== name) : [...new Set([...rec.disabledTools, name])] };
      installed = installed.map((e) => (e.id === id ? next : e));
      changedExt();
      return next;
    },
    'extensions.updates': () =>
      installed.flatMap((rec) => {
        const entry = marketplaceEntries.find((e) => e.name === rec.name);
        const latest = entry?.versions[0];
        if (!entry || entry.source === 'builtin' || !latest || latest.version === rec.version) return [];
        const cur = entry.versions.find((v) => v.version === rec.version);
        const addedTools = latest.tools.filter((t) => !cur?.tools.some((c) => c.name === t.name)).map((t) => t.name);
        const addedCapabilities = (latest.capabilities?.network ?? []).filter((n) => !(cur?.capabilities?.network ?? []).includes(n)).map((n) => `network: ${n}`);
        return [{ id: rec.id, name: rec.name, from: rec.version, to: latest.version, needsConsent: addedTools.length > 0 || addedCapabilities.length > 0, addedTools, addedCapabilities }];
      }),
    'extensions.update': ({ id, consent }) => {
      const rec = installed.find((e) => e.id === id) ?? fail('not_found', 'Not installed');
      const entry = marketplaceEntries.find((e) => e.name === rec.name) ?? fail('not_found', 'Not in the index');
      const latest = entry.versions[0]!;
      const cur = entry.versions.find((v) => v.version === rec.version);
      const grows = latest.tools.some((t) => !cur?.tools.some((c) => c.name === t.name));
      if (grows && !consent) fail('consent_required', 'This update adds tools or capabilities');
      const next = { ...rec, version: latest.version, manifest: manifestFor(entry, latest) };
      installed = installed.map((e) => (e.id === id ? next : e));
      changedExt();
      return next;
    },
    'extensions.addFromFolder': ({ devMode }) => {
      const rec = InstalledExtension.parse({
        id: newId('ext-folder'),
        name: 'my-linter-tools',
        version: '0.0.1',
        displayName: 'My linter tools',
        source: 'folder',
        path: '/Users/you/code/my-linter-tools',
        devMode,
        reviewed: false,
        manifest: ExtensionManifest.parse({
          name: 'my-linter-tools',
          version: '0.0.1',
          description: 'Runs the project linter and reports problems to agents.',
          oide: { engine: '^1.0.0', displayName: 'My linter tools', publisher: 'you', categories: ['agent-tools'], mcpServers: { lint: { command: 'node', args: ['dist/server.js'], tools: { 'lint.run': { risk: 'read', description: 'Run the linter' }, 'lint.fix': { risk: 'ask', description: 'Apply autofixes' } } } }, capabilities: { spawn: true, network: [], fs: [] } },
        }),
      });
      installed = [...installed, rec];
      changedExt();
      return rec;
    },
    'extensions.addFromGit': ({ url }) => {
      const repo = url.replace(/\.git$/, '').split('/').pop() ?? 'extension';
      const rec = InstalledExtension.parse({
        id: newId('ext-git'),
        name: repo.toLowerCase(),
        version: '0.1.0',
        displayName: repo,
        source: 'git',
        path: `/mock/extensions/${repo}`,
        reviewed: false,
        manifest: ExtensionManifest.parse({ name: repo.toLowerCase().replace(/[^a-z0-9-]/g, '-'), version: '0.1.0', oide: { engine: '^1.0.0', displayName: repo, mcpServers: { [repo.replace(/[^A-Za-z0-9_-]/g, '-')]: { command: 'node', args: ['dist/index.js'], tools: { 'repo.search': { risk: 'read' } } } } } }),
      });
      installed = [...installed, rec];
      changedExt();
      return rec;
    },

    /* ---- custom tools */
    'custom.list': () => custom,
    'custom.probeUrl': ({ url }) => {
      if (/fail|unreachable/.test(url)) return { reached: false, needsAuth: false, tools: [], error: 'Could not connect: ECONNREFUSED' };
      const host = new URL(url).hostname;
      const isMetrics = host === 'mcp.example.com';
      return {
        reached: true,
        transport: 'Streamable HTTP',
        serverName: isMetrics ? 'Metrics API' : host.split('.')[1] ?? host,
        serverVersion: isMetrics ? '2.3' : '1.0',
        serverInfo: isMetrics ? 'Metrics API v2.3' : `${host} v1.0`,
        needsAuth: isMetrics,
        tools: URL_TOOLS.map(([name, description, readOnlyHint, destructiveHint]) => ({ name, description, readOnlyHint, destructiveHint })),
      };
    },
    'custom.probeCommand': ({ command, args }) => {
      if (!command.trim()) return { started: false, tools: [], error: 'Enter a command' };
      if (/fail/.test([command, ...args].join(' '))) return { started: false, tools: [], error: 'The process exited with code 1 before listing tools' };
      return {
        started: true,
        tools: [
          { name: 'search.query', description: 'Search the indexed files', readOnlyHint: true },
          { name: 'search.reindex', description: 'Rebuild the index', destructiveHint: true },
        ],
      };
    },
    'custom.scanImports': () => SCAN.map((s) => ({ ...s, config: {}, alreadyAdded: s.name === 'playwright' || custom.some((c) => c.name === s.name) })),
    'custom.importSelected': ({ items, savedTo, projects, allProjects }) => {
      const out = items.map((it) => {
        const s = SCAN.find((x) => x.name === it.name && x.file === it.file) ?? fail('not_found', `Not found: ${it.name}`);
        return CustomServer.parse({
          id: newId('custom'),
          name: s.name,
          route: 'import',
          transport: s.kind === 'http' ? { kind: 'http', url: s.display, auth: 'none' } : { kind: 'stdio', command: s.display.split(' ')[0], args: s.display.split(' ').slice(1), envKeys: [] },
          tools: [
            { name: `${s.name}.read`, risk: 'read', description: 'Read data' },
            { name: `${s.name}.write`, risk: 'ask', description: 'Change data' },
          ],
          projects,
          allProjects,
          savedTo,
        });
      });
      custom = [...custom, ...out];
      return out;
    },
    'custom.save': ({ server }) => {
      custom = custom.some((c) => c.id === server.id) ? custom.map((c) => (c.id === server.id ? server : c)) : [...custom, server];
      return server;
    },
    'custom.remove': ({ id }) => {
      custom = custom.filter((c) => c.id !== id);
      return { ok: true as const };
    },
    'custom.authorize': async ({ id }) => {
      await new Promise((r) => setTimeout(r, 600));
      authorized.add(id);
      return { ok: true };
    },
    'custom.setHeaderToken': () => ({ ok: true as const }),

    /* ---- settings */
    'settings.builtIns': () => ({ presets: builtInPresets, techniques: builtInTechniques }),
    'settings.loadErrors': () => [{ projectId: 'docs-site', file: 'docs-site/.oide/techniques.json', message: 'Unexpected token } in JSON at line 14. Using defaults for this file.' }],
    'settings.techniques': ({ projectId }) => [...ctx.getSettings().techniques, ...(projectId ? (projectTechniques.get(projectId) ?? []) : [])],
    'settings.saveTechnique': ({ technique, projectId }) => {
      if (projectId) {
        const list = projectTechniques.get(projectId) ?? [];
        const t = { ...technique, scope: 'project' as const, builtIn: false };
        projectTechniques.set(projectId, list.some((x) => x.id === t.id) ? list.map((x) => (x.id === t.id ? t : x)) : [...list, t]);
        return t;
      }
      const s = ctx.getSettings();
      const t = { ...technique, scope: 'global' as const };
      ctx.setSettings({ ...s, techniques: s.techniques.some((x) => x.id === t.id) ? s.techniques.map((x) => (x.id === t.id ? { ...t, builtIn: x.builtIn } : x)) : [...s.techniques, t] });
      return t;
    },
    'settings.deleteTechnique': ({ id, projectId }) => {
      if (projectId) projectTechniques.set(projectId, (projectTechniques.get(projectId) ?? []).filter((t) => t.id !== id));
      else {
        const s = ctx.getSettings();
        if (s.techniques.find((t) => t.id === id)?.builtIn) fail('invalid_input', 'Built-in techniques can be reset, not deleted');
        ctx.setSettings({ ...s, techniques: s.techniques.filter((t) => t.id !== id) });
      }
      return { ok: true as const };
    },
    'settings.saveCustomModel': ({ model, apiKey }) => {
      const s = ctx.getSettings();
      const prev = s.models.custom.find((m) => m.id === model.id);
      const saved = CustomModel.parse({ ...model, hasKey: Boolean(apiKey) || (prev?.hasKey ?? false) });
      ctx.setSettings({ ...s, models: { ...s.models, custom: prev ? s.models.custom.map((m) => (m.id === model.id ? saved : m)) : [...s.models.custom, saved] } });
      return saved;
    },
    'settings.deleteCustomModel': ({ id }) => {
      const s = ctx.getSettings();
      ctx.setSettings({ ...s, models: { ...s.models, custom: s.models.custom.filter((m) => m.id !== id) } });
      return { ok: true as const };
    },
    'settings.testCustomModel': ({ id }) => {
      const m = ctx.getSettings().models.custom.find((x) => x.id === id);
      if (!m) return { ok: false, detail: 'Model not found' };
      if (m.provider === 'compatible-api' && !m.hasKey) return { ok: false, detail: 'No key stored for this endpoint' };
      return { ok: true, detail: `Connected · ${m.model} answered with tool use` };
    },
    'settings.projectPermissions': ({ projectId }) => structuredClone(projectPerms.get(projectId) ?? { allow: [], ask: [], deny: [] }),
    'settings.saveProjectPermissions': ({ projectId, allow, ask, deny }) => {
      projectPerms.set(projectId, { allow, ask, deny });
      return { ok: true as const };
    },
    'cli.openSignIn': () => ({ terminalId: 'term-signin' }),
    'projects.trust': ({ projectId, trusted }) => {
      const p = projects.find((x) => x.id === projectId) ?? fail('not_found', `No project ${projectId}`);
      return { ...p, trusted };
    },
  };
}
