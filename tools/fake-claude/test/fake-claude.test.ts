import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const BIN = fileURLToPath(new URL('../bin/fake-claude.mjs', import.meta.url));
const BASE = ['-p', '--verbose', '--input-format', 'stream-json', '--output-format', 'stream-json'];

function run(args: string[], stdin: string[], env: Record<string, string> = {}): Promise<{ lines: Array<Record<string, unknown>>; code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], { cwd: mkdtempSync(join(tmpdir(), 'fake-')), env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    for (const l of stdin) child.stdin.write(`${l}\n`);
    child.stdin.end();
    child.on('close', (code) => resolve({ code, stdout: out, lines: out.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l)) }));
  });
}
const user = (text: string) => JSON.stringify({ type: 'user', message: { role: 'user', content: text } });

describe('fake-claude', () => {
  it('answers --version and --help like the real CLI', async () => {
    expect((await run(['--version'], [])).stdout).toBe('2.1.325 (Claude Code)\n');
    expect((await run(['--help'], [])).stdout).toMatch(/--permission-prompt-tool/);
  });

  it('replays a basic turn and /compact, echoing --session-id', async () => {
    const { lines, code } = await run([...BASE, '--session-id', 'sid-1', '--include-partial-messages'], [user('hi'), user('/compact')]);
    expect(code).toBe(0);
    expect(lines[0]).toMatchObject({ type: 'system', subtype: 'init', session_id: 'sid-1' });
    expect(lines.some((l) => l.type === 'stream_event')).toBe(true);
    expect(lines.filter((l) => l.type === 'result')).toHaveLength(2);
    expect(lines.some((l) => l.type === 'system' && l.subtype === 'compact_boundary')).toBe(true);
  });

  it('uses --fake-scenario per turn and replays real fixtures', async () => {
    const { lines } = await run([...BASE, '--fake-scenario', 'replay:real-resume.jsonl,rate-limit'], [user('one'), user('two')]);
    const results = lines.filter((l) => l.type === 'result');
    expect(results[0]).toMatchObject({ is_error: false });
    expect(results[1]).toMatchObject({ is_error: true, api_error_status: 429 });
    expect(lines.some((l) => l.type === 'rate_limit_event' && (l.rate_limit_info as { status: string }).status === 'rejected')).toBe(true);
  });

  it('rejects invalid permission modes and exits with the crash code', async () => {
    expect((await run([...BASE, '--permission-mode', 'bogus'], [])).code).toBe(1);
    expect((await run([...BASE, '--fake-scenario', 'crash', '--fake-exit-code', '5'], [user('x')])).code).toBe(5);
  });

  it('answers interrupt and set_permission_mode control requests', async () => {
    const { lines } = await run([...BASE, '--fake-scenario', 'basic'], [JSON.stringify({ type: 'control_request', request_id: 'r1', request: { subtype: 'set_permission_mode', mode: 'plan' } }), JSON.stringify({ type: 'control_request', request_id: 'r2', request: { subtype: 'set_permission_mode', mode: 'nope' } })]);
    expect(lines[0]).toMatchObject({ type: 'control_response', response: { subtype: 'success', request_id: 'r1', response: { mode: 'plan' } } });
    expect(lines.find((l) => (l.response as { request_id?: string } | undefined)?.request_id === 'r2')).toMatchObject({ response: { subtype: 'error' } });
  });

  it('a [fake-scenario:<name>] marker in the message picks that turn’s scenario', async () => {
    const { lines } = await run([...BASE, '--fake-scenario', 'basic'], [user('[fake-scenario:rate-limit] go'), user('plain')]);
    const results = lines.filter((l) => l.type === 'result');
    expect(results[0]).toMatchObject({ is_error: true, api_error_status: 429 });
    expect(results[1]).toMatchObject({ is_error: false });
  });

  it('starts a stdio MCP server from --mcp-config and calls its tool by the CLI name (mcp-tool)', async () => {
    const server = fileURLToPath(new URL('../../../test/gates/fixtures/ext-textkit/server.mjs', import.meta.url));
    const config = JSON.stringify({ mcpServers: { textkit: { type: 'stdio', command: process.execPath, args: [server] } } });
    const { lines, code } = await run([...BASE, '--fake-scenario', 'mcp-tool', '--mcp-config', config, '--permission-mode', 'bypassPermissions'], [user('[fake-tool:mcp__textkit__text_reverse] [fake-args:{"text":"abc"}]')]);
    expect(code).toBe(0);
    const results = lines.filter((l) => l.type === 'user' && Array.isArray((l.message as { content?: unknown }).content));
    const toolResults = results.flatMap((l) => (l.message as { content: Array<{ type: string; content?: unknown; is_error?: boolean }> }).content).filter((b) => b.type === 'tool_result');
    expect(toolResults.at(-1)).toMatchObject({ content: expect.stringMatching(/^textkit pid \d+: cba$/) });
    expect(toolResults.at(-1)?.is_error).toBeUndefined();
    expect(lines.find((l) => l.type === 'result')).toMatchObject({ is_error: false, result: expect.stringContaining('cba') });
  });
});
