import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CliInfo, Settings, type AgentEvent, type AgentEventDraft } from '@oide/protocol';
import { parseTranscript } from '../src/parser.js';

export const REPO = fileURLToPath(new URL('../../../', import.meta.url));
export const FIXTURES = join(REPO, 'tools', 'fake-claude', 'fixtures');
export const FAKE_CLAUDE = join(REPO, 'tools', 'fake-claude', 'bin', 'fake-claude.mjs');
export const FAKE_CLAUDE_CMD = join(REPO, 'tools', 'fake-claude', 'bin', 'fake-claude.cmd');

export function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf8');
}

/** Parse a fixture and stamp drafts into full events. */
export function fixtureEvents(name: string, agentId = 'agent-1'): AgentEvent[] {
  return stamp(parseTranscript(fixture(name)), agentId);
}

export function stamp(drafts: AgentEventDraft[], agentId = 'agent-1', startSeq = 0): AgentEvent[] {
  return drafts.map((d, i) => ({ ...d, agentId, seq: startSeq + i, ts: 1_000 + i }) as AgentEvent);
}

export function tempDir(prefix = 'oide-test-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function testSettings(patch: { extraFlags?: string; maxRunning?: number; allowBypass?: boolean } = {}): Settings {
  return Settings.parse({
    claude: { extraFlags: patch.extraFlags ?? '', allowBypass: patch.allowBypass ?? false },
    models: {},
    agents: { maxRunning: patch.maxRunning ?? 3, notifications: {} },
    permissions: {},
    ui: {},
  });
}

export const fakeCli: CliInfo = CliInfo.parse({ found: true, path: FAKE_CLAUDE, version: '2.1.325', inTestedRange: true, features: {} });

export async function waitFor<T>(fn: () => T | undefined | false, timeoutMs = 10_000, what = 'condition'): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 15));
  }
}
