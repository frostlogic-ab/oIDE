import { describe, expect, it } from 'vitest';
import {
  appVersionValue,
  BUILTIN_SLASH_COMMANDS,
  cliVersionBucket,
  countBucket,
  durationBucket,
  memoryBucket,
  modelFamilyOf,
  OFFICIAL_UMAMI_HOST,
  OFFICIAL_UMAMI_WEBSITE_ID,
  screenBucket,
  screenPath,
  Settings,
  settingKeysOf,
  slashCommandOf,
  TELEMETRY_EVENT_NAMES,
  TELEMETRY_EVENTS,
  TELEMETRY_PATHS,
  TelemetryTrackInput,
  telemetryTarget,
  tokenBucket,
  toolCategoryOf,
  validateTelemetryEvent,
} from './index.js';

describe('telemetry catalogue', () => {
  it('drops unknown event names', () => {
    expect(validateTelemetryEvent('not_an_event', {})).toBeNull();
    expect(validateTelemetryEvent('__proto__', {})).toBeNull();
    expect(validateTelemetryEvent(42, {})).toBeNull();
  });

  it('strips properties the event does not declare', () => {
    const v = validateTelemetryEvent('agent_merged', {
      result: 'merged',
      branch: 'feature/secret',
      path: 'C:\\x',
    });
    expect(v).toEqual({ name: 'agent_merged', props: { result: 'merged' } });
  });

  it('drops the event when a declared property has a value outside its schema (no free text)', () => {
    expect(validateTelemetryEvent('agent_merged', { result: 'my-branch' })).toBeNull();
    expect(validateTelemetryEvent('setting_changed', { key: 'models.custom' })).toBeNull();
    expect(
      validateTelemetryEvent('command_palette_used', { command: 'my-extension.secret' }, 'renderer'),
    ).toBeNull();
    expect(
      validateTelemetryEvent('extension_installed', { extension: '../../etc/passwd', source: 'marketplace' }),
    ).toBeNull();
    expect(
      validateTelemetryEvent('cli_unknown_event', { event_type: 'system/C:\\Users\\x', count: 1 }),
    ).toBeNull();
  });

  it('artifact retrieval events take enums and buckets only, from main only (ADR 0014)', () => {
    expect(validateTelemetryEvent('artifact_retrieval_started', { trigger: 'import', kind: 'design', url: 'https://claude.ai/artifact/x' })).toEqual({
      name: 'artifact_retrieval_started',
      props: { trigger: 'import', kind: 'design' },
    });
    expect(validateTelemetryEvent('artifact_retrieval_finished', { trigger: 'update', outcome: 'agent_stopped', kind: 'doc', files: '2-5' })).not.toBeNull();
    expect(validateTelemetryEvent('artifact_retrieval_finished', { trigger: 'update', outcome: 'No tool can read it', kind: 'doc', files: '2-5' })).toBeNull();
    expect(validateTelemetryEvent('artifact_retrieval_finished', { trigger: 'update', outcome: 'ready', kind: 'doc', files: 12 })).toBeNull();
    expect(validateTelemetryEvent('artifact_retrieval_started', { trigger: 'import', kind: 'design' }, 'renderer')).toBeNull();
    expect(validateTelemetryEvent('artifact_imported', { source: 'folder', kind: 'design', linked: false, format: 'html', files: '21-100' })).not.toBeNull();
    expect(TELEMETRY_EVENT_NAMES).not.toContain('artifact_fetch_with_agent_started');
  });

  it('lets the renderer report only renderer events', () => {
    expect(validateTelemetryEvent('agent_merged', { result: 'merged' }, 'renderer')).toBeNull();
    expect(validateTelemetryEvent('command_palette_used', { command: 'oide.spawn' }, 'renderer')).toEqual({
      name: 'command_palette_used',
      props: { command: 'oide.spawn' },
    });
  });

  it('declares a product question and only enum-like or numeric properties for every event', () => {
    expect(TELEMETRY_EVENT_NAMES.length).toBeGreaterThan(10);
    for (const name of TELEMETRY_EVENT_NAMES) {
      const d = TELEMETRY_EVENTS[name];
      expect(d.question.length, name).toBeGreaterThan(20);
      expect(name).toMatch(/^[a-z][a-z_]{2,49}$/);
      for (const [prop, schema] of Object.entries(d.props.shape)) {
        // A free-form string would accept arbitrary text: every string must be an enum or a regex.
        const free = (schema as { safeParse(v: unknown): { success: boolean } }).safeParse(
          'Some free text with spaces / and a path C:\\Users\\x',
        );
        expect(free.success, `${name}.${prop} accepts free text`).toBe(false);
      }
    }
  });

  it('IPC input refuses unknown kinds and bounds sizes', () => {
    expect(TelemetryTrackInput.safeParse({ type: 'pageview', screen: 'wall' }).success).toBe(true);
    expect(TelemetryTrackInput.safeParse({ type: 'pageview', screen: 'focus/abc' }).success).toBe(false);
    expect(TelemetryTrackInput.safeParse({ type: 'identify', data: {} }).success).toBe(false);
    expect(
      TelemetryTrackInput.safeParse({ type: 'error', source: 'window', name: 'E', message: 'x'.repeat(3000) })
        .success,
    ).toBe(false);
  });
});

describe('telemetry helpers', () => {
  it('buckets counts, durations, tokens and memory', () => {
    expect([0, 1, 3, 10, 50, 500].map(countBucket)).toEqual(['0', '1', '2-5', '6-20', '21-100', '100+']);
    expect([5_000, 30_000, 120_000, 600_000, 1_800_000, 7_200_000].map(durationBucket)).toEqual([
      '<10s',
      '10s-1m',
      '1-5m',
      '5-15m',
      '15-60m',
      '1h+',
    ]);
    expect([10, 50_000, 500_000, 5_000_000, 50_000_000].map(tokenBucket)).toEqual([
      '<10k',
      '10k-100k',
      '100k-1M',
      '1M-10M',
      '10M+',
    ]);
    expect(memoryBucket(300 * 1024 * 1024)).toBe('256-512MB');
    expect(screenBucket(1920, 1080)).toBe('1900x1000');
    expect(cliVersionBucket('2.1.325')).toBe('2.1');
    expect(cliVersionBucket('garbage')).toBe('unknown');
  });

  it('sends the running app version on app_started, or unknown, never free text', () => {
    expect(appVersionValue('0.5.1')).toBe('0.5.1');
    expect(appVersionValue('0.6.0-beta.2')).toBe('0.6.0-beta.2');
    expect(appVersionValue('my build /Users/me')).toBe('unknown');
    expect(appVersionValue(undefined)).toBe('unknown');
    const props = { cold_start_ms: 1200, cli_found: true, cli_version: '2.1', projects: '1', agents: '2-5' };
    expect(validateTelemetryEvent('app_started', { ...props, app_version: '0.5.1' })?.props).toMatchObject({
      app_version: '0.5.1',
    });
    expect(validateTelemetryEvent('app_started', { ...props, app_version: 'unknown' })).not.toBeNull();
    expect(validateTelemetryEvent('app_started', { ...props, app_version: 'C:/Users/me' })).toBeNull();
  });

  it('maps models to a family and tools to a category, never a raw name', () => {
    expect(modelFamilyOf('claude-opus-5-5[1m]')).toBe('opus');
    expect(modelFamilyOf('acme-llm-70b')).toBe('other');
    expect(modelFamilyOf('opus', true)).toBe('custom');
    expect(toolCategoryOf('mcp__acme_internal__deploy')).toBe('mcp');
    expect(toolCategoryOf('Bash')).toBe('Bash');
    expect(toolCategoryOf('MultiEdit')).toBe('Edit');
    expect(toolCategoryOf('SomethingNew')).toBe('other');
  });

  it('reports built-in slash commands by name and everything else as other', () => {
    expect(slashCommandOf('/compact')).toBe('compact');
    expect(slashCommandOf('/review please look at src/x.ts')).toBe('review');
    expect(slashCommandOf('/my-team-skill')).toBe('other');
    expect(slashCommandOf('/mcp__srv__prompt')).toBe('other');
    expect(BUILTIN_SLASH_COMMANDS).toContain('context');
  });

  it('finds only allow-listed setting keys in a patch', () => {
    expect(
      settingKeysOf({
        agents: { maxRunning: 4, notifications: { error: false } },
        models: { custom: [{ id: 'x' }] },
      }).sort(),
    ).toEqual(['agents.maxRunning', 'agents.notifications']);
    expect(settingKeysOf({ privacy: { usageAnalytics: true } })).toEqual([]);
    expect(settingKeysOf({ keybindings: { 'nav.back': ['Alt+Left'] } })).toEqual(['keybindings']);
  });

  it('builds synthetic screen paths only', () => {
    expect(screenPath('settings', 'privacy')).toBe('/settings/privacy');
    expect(screenPath('settings', '../../etc')).toBe('/settings/cli');
    expect(screenPath('focus')).toBe('/focus');
    expect(TELEMETRY_PATHS).toContain('/source-control');
    for (const p of TELEMETRY_PATHS) expect(p).toMatch(/^\/[a-z-]+(?:\/[a-z]+)?$/);
  });
});

describe('telemetry endpoint (distribution)', () => {
  it('accepts the official https origin and website id', () => {
    const t = telemetryTarget(OFFICIAL_UMAMI_HOST, OFFICIAL_UMAMI_WEBSITE_ID);
    expect(t).toEqual({
      origin: 'https://data.frostlogic.se',
      websiteId: '8e219a5f-f8d7-4ae8-885f-14501223d568',
      sendUrl: 'https://data.frostlogic.se/api/send',
      batchUrl: 'https://data.frostlogic.se/api/batch',
    });
  });

  it('compiles telemetry out for empty or unsafe values', () => {
    expect(telemetryTarget('', OFFICIAL_UMAMI_WEBSITE_ID)).toBeNull();
    expect(telemetryTarget(OFFICIAL_UMAMI_HOST, '')).toBeNull();
    expect(telemetryTarget('http://data.example.com', OFFICIAL_UMAMI_WEBSITE_ID)).toBeNull();
    expect(telemetryTarget('https://u:p@data.example.com', OFFICIAL_UMAMI_WEBSITE_ID)).toBeNull();
    expect(telemetryTarget('https://data.example.com/path', OFFICIAL_UMAMI_WEBSITE_ID)).toBeNull();
    expect(telemetryTarget('https://data.example.com', 'not-a-uuid')).toBeNull();
    expect(telemetryTarget('https://stats.fork.example/', OFFICIAL_UMAMI_WEBSITE_ID)?.batchUrl).toBe(
      'https://stats.fork.example/api/batch',
    );
  });
});

describe('privacy settings migration', () => {
  const old = {
    claude: {},
    models: {},
    agents: { notifications: {} },
    techniques: [],
    permissions: {},
    // 0.1.x: a usage-statistics switch existed while there was no telemetry code at all.
    ui: { accent: '#7AA2F7', telemetry: true, crashReports: true },
  };

  it('parses a 0.1.x settings file and keeps both new switches off', () => {
    const s = Settings.parse(old);
    expect(s.privacy).toEqual({
      usageAnalytics: false,
      errorReports: false,
      consentAnswered: false,
      consentPromptsShown: 0,
    });
    // The old local crash-report switch keeps its meaning (local files), it is not upload consent.
    expect(s.ui.crashReports).toBe(true);
    expect(s.ui.telemetry).toBe(true);
  });

  it('rejects invalid privacy values', () => {
    expect(Settings.safeParse({ ...old, privacy: { usageAnalytics: 'yes' } }).success).toBe(false);
    expect(Settings.safeParse({ ...old, privacy: { consentPromptsShown: -1 } }).success).toBe(false);
  });
});
