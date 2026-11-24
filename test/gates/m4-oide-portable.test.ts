import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Project } from '../../packages/protocol/src/index.js';
import { git, makeRepo, tempDir, type Harness } from '../integration/harness.js';
import { driveTo, gateHarness, track, useGateCleanup } from './helpers.js';
import { localMarketplace, TEXTKIT } from './marketplace.js';

/**
 * M4 gate: "A project's `.oide/` folder reproduces the same agent setup on another machine."
 *
 * One origin repo commits `.oide/config.json` (default mode, preset, setup), `permissions.json`
 * (allow / ask / deny), `techniques.json` (a system-prompt and a first-message technique, on by
 * default) and `extensions.json` (the marketplace extension `@acme/oide-textkit`). Two "machines"
 * (separate userData dirs, different global defaults) each clone it, install the extension from the
 * index and trust the project. Their agents get identical launch plans (argv recorded by
 * fake-claude, normalized for paths and ids), identical `--mcp-config` and the same first message.
 * A third machine that does not trust the project gets the documented differences; trusting it
 * later gives the same plan as the others.
 *
 * Spawn's defaults come from the same IPC the Spawn screen uses: `settings.forProject` (mode and
 * preset from `.oide/config.json` under trust, default-on techniques).
 */

useGateCleanup();

const OIDE = {
  'config.json': {
    version: 1,
    defaultMode: 'acceptEdits',
    presetId: 'balanced',
    setup: `node -e "require('fs').writeFileSync('setup-ran.txt','1')"`,
  },
  'permissions.json': {
    version: 1,
    allow: ['Bash(npm test)', 'Bash(git status)'],
    ask: ['Bash(git push *)'],
    deny: ['Bash(rm -rf *)'],
  },
  'techniques.json': {
    version: 1,
    techniques: [
      {
        id: 'team-style',
        name: 'Team style',
        text: 'Follow docs/STYLE.md for every change.',
        placement: 'system-prompt',
        enabledByDefault: true,
      },
      {
        id: 'team-checks',
        name: 'Team checks',
        text: 'Run npm test before you submit.',
        placement: 'first-message',
        enabledByDefault: true,
      },
    ],
  },
  'extensions.json': { version: 1, enabled: { [TEXTKIT.name]: '^1.0.0' } },
};

function originRepo(): string {
  const repo = makeRepo();
  mkdirSync(join(repo, '.oide'));
  for (const [f, v] of Object.entries(OIDE))
    writeFileSync(join(repo, '.oide', f), `${JSON.stringify(v, null, 2)}\n`);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'Team .oide setup');
  return repo;
}

interface Plan {
  argv: string[];
  envKeys: string[];
  firstMessage: string;
  mcp: unknown;
  worktree: string;
}

interface Machine {
  h: Harness;
  clone: string;
  record: string;
  project: Project;
}

async function machine(
  origin: string,
  opts: { trust: boolean; globals: Record<string, unknown> },
): Promise<Machine> {
  const home = tempDir('oide-gate-machine-');
  track(home);
  const clone = join(home, 'app');
  git(home, 'clone', '-q', origin, clone);
  const record = join(home, 'launch.jsonl');
  const market = localMarketplace();
  const h = await gateHarness({ trust: opts.trust, platform: { fetch: market.fetch } });
  await h.call('settings.update', {
    patch: {
      ...opts.globals,
      claude: {
        ...(opts.globals.claude as object),
        extraFlags: `--fake-scenario basic --fake-record ${JSON.stringify(record)}`,
      },
    },
  });
  await h.call('extensions.install', { name: TEXTKIT.name });
  const project = (await h.call('projects.open', { path: clone }))!;
  expect(project.trusted).toBe(opts.trust);
  return { h, clone, record, project };
}

/** Spawn with the defaults this project gives, as the Spawn screen does (`settings.forProject`). */
async function spawnWithDefaults(m: Machine): Promise<{ agentId: string; sessionId: string; plan: Plan }> {
  const { h } = m;
  const project = (await h.call('projects.list', undefined)).find((p) => p.id === m.project.id)!;
  const defaults = await h.call('settings.forProject', { projectId: project.id });
  const settings = await h.call('settings.get', undefined);
  const preset = settings.models.presets.find((p) => p.id === defaults.presetId)!;
  const techniques = defaults.techniques.filter((t) => t.enabledByDefault).map((t) => t.id);
  const before = launches(m.record).length;
  const [a] = await h.call('agents.spawn', {
    projectId: project.id,
    title: 'Team agent',
    goal: 'Check the project',
    mode: defaults.defaultMode,
    strategy: preset.strategy,
    techniques,
  });
  const done = await driveTo(h, a!.id, 'has-question');
  const rec = launches(m.record).slice(before);
  const launch = rec.find((l) => l.argv)!;
  const stdin = rec.find((l) => l.stdin)?.stdin as
    { message?: { content?: Array<{ text: string }> | string } } | undefined;
  const c = stdin?.message?.content;
  const firstMessage = typeof c === 'string' ? c : (c ?? []).map((b) => b.text).join('\n');
  const mcpPath = launch.argv![launch.argv!.indexOf('--mcp-config') + 1]!;
  const replace = normalizer([
    [m.h.userData, '<DATA>'],
    [m.clone, '<REPO>'],
    [m.record, '<RECORD>'],
    [project.id, '<PROJECT>'],
    [a!.id, '<AGENT>'],
    [done.agent.sessionId!, '<SESSION>'],
  ]);
  const mcp = JSON.parse(
    replace(readFileSync(mcpPath, 'utf8')).replace(/127\.0\.0\.1:\d+/g, '127.0.0.1:<PORT>'),
  );
  return {
    agentId: a!.id,
    sessionId: done.agent.sessionId!,
    plan: {
      argv: launch.argv!.map(replace),
      envKeys: launch.envKeys!,
      firstMessage: replace(firstMessage),
      mcp,
      worktree: done.agent.worktreePath!,
    },
  };
}

function launches(record: string): Array<{ argv?: string[]; envKeys?: string[]; stdin?: unknown }> {
  if (!existsSync(record)) return [];
  return readFileSync(record, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
}

/** Replace machine-specific strings (raw, JSON-escaped and forward-slash forms), longest first. */
function normalizer(pairs: Array<[string, string]>): (s: string) => string {
  const forms: Array<[string, string]> = [];
  for (const [from, to] of pairs) {
    for (const f of new Set([from, from.replace(/\\/g, '\\\\'), from.replace(/\\/g, '/')]))
      forms.push([f, to]);
  }
  forms.sort((x, y) => y[0].length - x[0].length);
  return (s) => forms.reduce((acc, [f, t]) => acc.split(f).join(t), s);
}

const flag = (argv: string[], name: string) =>
  argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined;
const list = (argv: string[], name: string) => flag(argv, name)?.split(',') ?? [];

describe('M4 gate: .oide/ reproduces the agent setup on another machine', { timeout: 90_000 }, () => {
  it('two machines, trusted: identical launch plans; untrusted: the documented differences', async () => {
    const origin = originRepo();
    track(origin);
    const a = await machine(origin, {
      trust: true,
      globals: { claude: { defaultMode: 'auto' }, models: { defaultPresetId: 'cheap' } },
    });
    const b = await machine(origin, {
      trust: true,
      globals: { claude: { defaultMode: 'plan' }, models: { defaultPresetId: 'quality' } },
    });
    const pa = await spawnWithDefaults(a);
    const pb = await spawnWithDefaults(b);

    // Same flags, allowed / disallowed tools, techniques, preset, extensions, env names, first message.
    expect(pb.plan.argv).toEqual(pa.plan.argv);
    expect(pb.plan.mcp).toEqual(pa.plan.mcp);
    expect(pb.plan.envKeys).toEqual(pa.plan.envKeys);
    expect(pb.plan.firstMessage).toEqual(pa.plan.firstMessage);

    // ...and that plan is the project's, not either machine's global defaults.
    const argv = pa.plan.argv;
    expect(flag(argv, '--permission-mode')).toBe('acceptEdits');
    expect(flag(argv, '--model')).toBe('opus'); // preset "balanced": routed, Opus leads
    expect(flag(argv, '--effort')).toBe('high');
    expect(Object.keys(JSON.parse(flag(argv, '--agents')!))).toHaveLength(3);
    expect(list(argv, '--allowedTools')).toEqual(
      expect.arrayContaining([
        'Bash(npm test)',
        'Bash(git status)',
        TEXTKIT.cliTool,
        'mcp__oide__submit_for_review',
      ]),
    );
    expect(list(argv, '--disallowedTools')).toContain('Bash(rm -rf *)');
    expect(flag(argv, '--append-system-prompt')).toContain('Follow docs/STYLE.md for every change.');
    expect(pa.plan.firstMessage).toContain('Run npm test before you submit.');
    expect(argv).not.toContain('--strict-mcp-config');
    expect(
      (pa.plan.mcp as { mcpServers: Record<string, { args?: string[] }> }).mcpServers[TEXTKIT.server]?.args,
    ).toEqual([
      '<DATA>/extensions/acme__oide-textkit@1.0.0/dist/server.mjs'.replace(
        /\//g,
        process.platform === 'win32' ? '\\' : '/',
      ),
    ]);
    // .oide/setup ran in both worktrees.
    expect(existsSync(join(pa.plan.worktree, 'setup-ran.txt'))).toBe(true);
    expect(existsSync(join(pb.plan.worktree, 'setup-ran.txt'))).toBe(true);

    // A third machine that has not trusted the project.
    const c = await machine(origin, {
      trust: false,
      globals: { claude: { defaultMode: 'auto' }, models: { defaultPresetId: 'cheap' } },
    });
    const techs = await c.h.call('settings.techniques', { projectId: c.project.id });
    expect(techs.filter((t) => t.scope === 'project')).toEqual([
      expect.objectContaining({
        id: 'team-style',
        name: 'Team style (from untrusted project)',
        enabledByDefault: false,
        placement: 'first-message',
      }),
      expect.objectContaining({
        id: 'team-checks',
        name: 'Team checks (from untrusted project)',
        enabledByDefault: false,
        placement: 'first-message',
      }),
    ]);
    const pc = await spawnWithDefaults(c);
    const u = pc.plan.argv;
    expect(u).not.toEqual(argv);
    // The CLI must not load the repo's .claude settings or .mcp.json.
    expect(flag(u, '--setting-sources')).toBe('user');
    expect(u).toContain('--strict-mcp-config');
    // No .oide default mode (the machine's own default), no allow rules, no team extension, no techniques, no setup.
    expect(flag(u, '--permission-mode')).toBe('auto');
    expect(list(u, '--allowedTools')).not.toContain('Bash(npm test)');
    expect(list(u, '--allowedTools')).not.toContain(TEXTKIT.cliTool);
    expect(
      (pc.plan.mcp as { mcpServers: Record<string, unknown> }).mcpServers[TEXTKIT.server],
    ).toBeUndefined();
    expect(flag(u, '--append-system-prompt')).not.toContain('docs/STYLE.md');
    expect(pc.plan.firstMessage).not.toContain('Run npm test before you submit.');
    expect(existsSync(join(pc.plan.worktree, 'setup-ran.txt'))).toBe(false);
    // Still applied when untrusted: deny rules (they only take away), the preset (no permissions in it).
    expect(list(u, '--disallowedTools')).toContain('Bash(rm -rf *)');
    expect(flag(u, '--model')).toBe('opus');

    // Trusting it on that machine gives the same setup as the other two.
    await c.h.call('agents.remove', { agentId: pc.agentId, deleteWorktree: true });
    await c.h.call('projects.trust', { projectId: c.project.id, trusted: true });
    c.project = { ...c.project, trusted: true };
    const pc2 = await spawnWithDefaults(c);
    expect(pc2.plan.argv).toEqual(argv);
    expect(pc2.plan.mcp).toEqual(pa.plan.mcp);
    expect(pc2.plan.firstMessage).toEqual(pa.plan.firstMessage);
  });

  it('Spawn screen defaults (settings.forProject) come from .oide/config.json, mode only when trusted', async () => {
    const origin = originRepo();
    track(origin);
    const globals = { claude: { defaultMode: 'plan' }, models: { defaultPresetId: 'quality' } };
    const trusted = await machine(origin, { trust: true, globals });
    const untrusted = await machine(origin, { trust: false, globals });
    const t = await trusted.h.call('settings.forProject', { projectId: trusted.project.id });
    expect(t).toMatchObject({ defaultMode: 'acceptEdits', presetId: 'balanced' });
    expect(t.techniques.map((x) => x.id)).toEqual(expect.arrayContaining(['team-style', 'team-checks']));
    // Untrusted: the repo cannot pick the permission mode; the global default stays.
    const u = await untrusted.h.call('settings.forProject', { projectId: untrusted.project.id });
    expect(u.defaultMode).toBe('plan');
    expect(u.presetId).toBe('balanced');
    expect(u.techniques.find((x) => x.id === 'team-style')?.enabledByDefault).toBe(false);
    // The global Settings are untouched.
    expect((await trusted.h.call('settings.get', undefined)).claude.defaultMode).toBe('plan');
  });
});
