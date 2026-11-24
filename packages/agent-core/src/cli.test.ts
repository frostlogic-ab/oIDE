import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FAKE_CLAUDE, FAKE_CLAUDE_CMD, fixture, tempDir } from '../test/helpers.js';
import { compareVersions, detectCli, findOnPath, inTestedRange, parseHelpFeatures, resolveSpawn } from './cli.js';

describe('CLI detection', () => {
  it('parses the real 2.1.325 help into features', () => {
    const f = parseHelpFeatures(fixture('help-2.1.325.txt'));
    expect(f).toMatchObject({
      effort: true,
      'forward-subagent-text': true,
      'include-partial-messages': true,
      'permission-prompt-tool': true,
      agents: true,
      'session-id': true,
      'mode:auto': true,
      'mode:manual': true,
      'mode:default': true,
      'mode:dontAsk': true,
      'mode:bypassPermissions': true,
      'effort:xhigh': true,
    });
    expect(parseHelpFeatures('Usage: claude\n  --model <model>')).toMatchObject({ effort: false, 'mode:auto': false });
  });

  it('versions and tested range', () => {
    expect(compareVersions('2.1.325', '2.1.40')).toBe(1);
    expect(compareVersions('2.1.0', '2.1.0')).toBe(0);
    expect(inTestedRange('2.1.325')).toBe(true);
    expect(inTestedRange('1.0.99')).toBe(false);
  });

  it('detects fake-claude (.mjs through node)', async () => {
    const info = await detectCli(FAKE_CLAUDE);
    expect(info).toMatchObject({ found: true, version: '2.1.325', inTestedRange: true, signedIn: 'unknown' });
    expect(info.features['permission-prompt-tool']).toBe(true);
  });

  it('reports not found for a missing binary', async () => {
    expect((await detectCli(join(tempDir(), 'nope.exe'))).found).toBe(false);
  });

  it('finds a binary on PATH honouring PATHEXT', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'claude.cmd'), '@echo off\r\n');
    expect(findOnPath('claude', { PATH: dir, PATHEXT: '.COM;.EXE;.CMD' }, 'win32')).toBe(join(dir, 'claude.cmd'));
    writeFileSync(join(dir, 'claude.exe'), '');
    expect(findOnPath('claude', { PATH: dir, PATHEXT: '.COM;.EXE;.CMD' }, 'win32')).toBe(join(dir, 'claude.exe'));
  });

  it.runIf(process.platform === 'win32')('detects and spawns through a .cmd shim with safely quoted args', async () => {
    const info = await detectCli(FAKE_CLAUDE_CMD);
    expect(info.found).toBe(true);
    const dir = tempDir();
    const rec = join(dir, 'rec.jsonl');
    const tricky = ['a "quoted" & | % ^ <x> (y) !z', 'C:\\path with space\\', '%PATH%', 'semi;colon,comma', ''];
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--append-system-prompt', tricky[0]!, '--add-dir', tricky[1]!, '--model', tricky[2]!, '--name', tricky[3]!, '--fallback-model', tricky[4]!];
    const t = resolveSpawn(FAKE_CLAUDE_CMD, args, 'win32');
    await new Promise<void>((resolve, reject) => {
      const child = spawn(t.file, t.args, { env: { ...process.env, FAKE_CLAUDE_RECORD: rec }, windowsVerbatimArguments: true, stdio: ['pipe', 'ignore', 'pipe'] });
      child.stdin.end();
      child.on('error', reject);
      child.on('close', () => resolve());
    });
    const first = JSON.parse(readFileSync(rec, 'utf8').split('\n')[0]!) as { argv: string[] };
    expect(first.argv).toEqual(args);
  });
});
