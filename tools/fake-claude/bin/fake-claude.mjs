#!/usr/bin/env node
// fake-claude: a scriptable stand-in for the Claude Code CLI in `-p --input-format stream-json
// --output-format stream-json` mode. Event shapes follow the real CLI 2.1.325 recordings in ../fixtures.
// Tests never need a login. See docs/wiki/pages/testing.md.
//
// Scenario: --fake-scenario <name[,name…]> or FAKE_CLAUDE_SCENARIO. One name per user turn; the last repeats.
//   basic | exit-plan | tools | permission | review | subagents | rate-limit | crash | slow | auth | replay:<fixture.jsonl>
//   commit-work | address-feedback | commit-all | mcp-tool | artifacts   (milestone gate tests, test/gates)
//   artifact-update (reads the {"id":"…"} artifact in the message and writes a new version)
//   resolve-conflicts (runs the `git merge <ref>` an oIDE merge-conflicts message names, keeps both sides, commits,
//   submits; picked automatically for a message starting "[Sent by oIDE] Merge conflicts")
// A user message containing `[fake-scenario:<name>]` runs that scenario for its turn (overrides the list).
// Image content blocks (`{type:'image',source:{type:'base64',media_type,data}}`) are accepted as the real CLI
// does (2.1.325); `basic` names them in its reply ("[1 image: image/png, 178 bytes]"). A malformed image
// block ends the turn with an API-style 400 error result.
// `/compact` (and other slash commands) work in every scenario. `--resume <id>` echoes the session id.
// MCP servers from --mcp-config are reached over HTTP (`url`) or started over stdio (`command`).
// Flags --fake-record <file>, --fake-exit-code <n>, --fake-no-control mirror the env vars below.
// Env: FAKE_CLAUDE_RECORD=<file> (append argv, env KEY NAMES and stdin lines), FAKE_CLAUDE_DELAY_MS,
//      FAKE_CLAUDE_EXIT_CODE (crash), FAKE_CLAUDE_NO_CONTROL=1 (ignore control requests),
//      FAKE_CLAUDE_VERSION, FAKE_CLAUDE_HELP=<file>, FAKE_CLAUDE_WRITE_FILES=0 (do not touch cwd).
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, '..', 'fixtures');
const VERSION = process.env.FAKE_CLAUDE_VERSION ?? '2.1.325';
const MODES = ['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'default', 'dontAsk', 'plan'];
const MODEL_ALIASES = { haiku: 'claude-haiku-5-5', sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5', fable: 'claude-fable-5' };

// ------------------------------------------------------------------ argv

const BOOL = new Set(['--fake-no-control', '-p', '--print', '--verbose', '--include-partial-messages', '--forward-subagent-text', '--replay-user-messages', '--dangerously-skip-permissions', '--allow-dangerously-skip-permissions', '-h', '--help', '-v', '--version', '--fork-session', '--strict-mcp-config', '--bare', '--include-hook-events', '-c', '--continue']);
const VARIADIC = new Set(['--allowedTools', '--allowed-tools', '--disallowedTools', '--disallowed-tools', '--mcp-config', '--add-dir', '--tools', '--betas']);

function parseArgv(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    let inline;
    if (a.startsWith('--') && a.includes('=')) [a, inline] = [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)];
    if (!a.startsWith('-')) {
      positional.push(a);
      continue;
    }
    if (BOOL.has(a)) {
      flags[a] = true;
      continue;
    }
    if (VARIADIC.has(a)) {
      const vals = inline !== undefined ? [inline] : [];
      while (inline === undefined && i + 1 < argv.length && !argv[i + 1].startsWith('-')) vals.push(argv[++i]);
      flags[a] = [...(flags[a] ?? []), ...vals];
      continue;
    }
    flags[a] = inline !== undefined ? inline : i + 1 < argv.length && !argv[i + 1].startsWith('-') ? argv[++i] : true;
  }
  return { flags, positional };
}

const argv = process.argv.slice(2);
const { flags } = parseArgv(argv);
const RECORD = typeof flags['--fake-record'] === 'string' ? flags['--fake-record'] : process.env.FAKE_CLAUDE_RECORD;
const record = (obj) => {
  if (RECORD) appendFileSync(RECORD, `${JSON.stringify(obj)}\n`);
};

if (flags['--version'] || flags['-v']) {
  process.stdout.write(`${VERSION} (Claude Code)\n`);
  process.exit(0);
}
if (flags['--help'] || flags['-h']) {
  const helpFile = process.env.FAKE_CLAUDE_HELP ?? join(FIXTURES, 'help-2.1.325.txt');
  process.stdout.write(readFileSync(helpFile, 'utf8'));
  process.exit(0);
}
record({ argv, envKeys: Object.keys(process.env).sort(), cwd: process.cwd(), pid: process.pid });
if (flags['--permission-mode'] && !MODES.includes(flags['--permission-mode'])) {
  process.stderr.write(`error: option '--permission-mode <mode>' argument '${flags['--permission-mode']}' is invalid.\n`);
  process.exit(1);
}
if (flags['--input-format'] !== 'stream-json' || flags['--output-format'] !== 'stream-json') {
  process.stderr.write('fake-claude only supports --input-format stream-json --output-format stream-json\n');
  process.exit(2);
}

const resumeId = typeof flags['--resume'] === 'string' ? flags['--resume'] : undefined;
const sessionId = resumeId ?? (typeof flags['--session-id'] === 'string' ? flags['--session-id'] : randomUUID());
const modelFlag = typeof flags['--model'] === 'string' ? flags['--model'] : 'sonnet';
const model = MODEL_ALIASES[modelFlag] ?? modelFlag;
let mode = typeof flags['--permission-mode'] === 'string' ? flags['--permission-mode'] : 'default';
// As the real CLI (2.1.332): a live switch to bypass needs a bypass launch or the allow flag.
const bypassAvailable = mode === 'bypassPermissions' || Boolean(flags['--dangerously-skip-permissions'] || flags['--allow-dangerously-skip-permissions']);
const partials = Boolean(flags['--include-partial-messages']);
const forwardSubagents = Boolean(flags['--forward-subagent-text']);
const allowed = splitRules(flags['--allowedTools'] ?? flags['--allowed-tools'] ?? []);
const disallowed = splitRules(flags['--disallowedTools'] ?? flags['--disallowed-tools'] ?? []);
const promptTool = typeof flags['--permission-prompt-tool'] === 'string' ? flags['--permission-prompt-tool'] : undefined;
const agentsDef = typeof flags['--agents'] === 'string' ? safeJson(flags['--agents']) ?? {} : {};
const scenarios = String(flags['--fake-scenario'] ?? process.env.FAKE_CLAUDE_SCENARIO ?? 'basic').split(',').map((s) => s.trim()).filter(Boolean);
const DELAY = Number(process.env.FAKE_CLAUDE_DELAY_MS ?? 2);
const WRITE_FILES = process.env.FAKE_CLAUDE_WRITE_FILES !== '0';

function safeJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

/** "a,b" / "Bash(git *) Edit" → rules, keeping spaces inside parentheses. */
function splitRules(values) {
  const out = [];
  for (const v of values) {
    let cur = '';
    let depth = 0;
    for (const ch of v) {
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if (depth === 0 && (ch === ',' || ch === ' ')) {
        if (cur.trim()) out.push(cur.trim());
        cur = '';
      } else cur += ch;
    }
    if (cur.trim()) out.push(cur.trim());
  }
  return out;
}

function loadMcpServers() {
  const servers = {};
  for (const v of flags['--mcp-config'] ?? []) {
    const text = v.trim().startsWith('{') ? v : readFileSync(isAbsolute(v) ? v : resolve(v), 'utf8');
    Object.assign(servers, safeJson(text)?.mcpServers ?? {});
  }
  // Like the real CLI (2.1.325 parses --mcp-config with env expansion): `${VAR}` and
  // `${VAR:-default}` in url and header values come from this process's env.
  const expand = (s) => (typeof s === 'string' ? s.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_m, name, def) => process.env[name] ?? def ?? '') : s);
  for (const s of Object.values(servers)) {
    if (!s || typeof s !== 'object') continue;
    if (s.url) s.url = expand(s.url);
    if (s.headers) for (const k of Object.keys(s.headers)) s.headers[k] = expand(s.headers[k]);
  }
  return servers;
}
const mcpServers = loadMcpServers();

// ------------------------------------------------------------------ output helpers

const out = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uuid = () => randomUUID();
const ABORT = Symbol('abort');
let turnNo = 0;
let msgNo = 0;
let current = null;
let totalCost = 0;

function usage(i = 0) {
  return { input_tokens: 3, cache_creation_input_tokens: 400 + 100 * i, cache_read_input_tokens: 12_000 + 1000 * turnNo, output_tokens: 20 + i, service_tier: 'standard' };
}

async function emit(obj, delay = DELAY) {
  if (current?.aborted) throw ABORT;
  out(obj);
  if (delay) await sleep(delay);
  if (current?.aborted) throw ABORT;
}

function initEvent() {
  const tools = ['Agent', 'Bash', 'Edit', 'Glob', 'Grep', 'Read', 'Write', 'TodoWrite', 'ToolSearch', 'WebFetch', 'mcp__oide__submit_for_review'];
  return {
    type: 'system',
    subtype: 'init',
    cwd: process.cwd(),
    session_id: sessionId,
    tools,
    mcp_servers: Object.keys(mcpServers).map((name) => ({ name, status: 'connected', source: 'dynamic' })),
    model,
    permissionMode: mode,
    slash_commands: ['compact', 'context', 'cost'],
    apiKeySource: 'none',
    claude_code_version: VERSION,
    output_style: 'default',
    agents: ['general-purpose', 'Explore', 'Plan', ...Object.keys(agentsDef)],
    skills: [],
    plugins: [],
    uuid: uuid(),
  };
}

function messageId() {
  return `msg_fake_${String(++msgNo).padStart(4, '0')}`;
}

async function assistant(content, { ptu = null, usageIdx = 0, id = messageId(), streamText } = {}) {
  if (partials && streamText) {
    for (const chunk of streamText.match(/.{1,12}/gs) ?? []) {
      await emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: chunk } }, session_id: sessionId, parent_tool_use_id: ptu, uuid: uuid(), api_message_id: id });
    }
  }
  await emit({ type: 'assistant', message: { model, id, type: 'message', role: 'assistant', content, stop_reason: null, usage: usage(usageIdx) }, parent_tool_use_id: ptu, session_id: sessionId, uuid: uuid() });
  return id;
}

async function thinking(ptu = null) {
  if (partials) await emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Considering the task…' } }, session_id: sessionId, parent_tool_use_id: ptu, uuid: uuid() });
  await assistant([{ type: 'thinking', thinking: '', signature: 'sig-fake' }], { ptu });
}

async function toolResult(toolUseId, content, { ptu = null, isError = false, decision = 'accept' } = {}) {
  await emit({
    type: 'user',
    message: { role: 'user', content: [{ tool_use_id: toolUseId, type: 'tool_result', content, ...(isError ? { is_error: true } : {}) }] },
    parent_tool_use_id: ptu,
    session_id: sessionId,
    uuid: uuid(),
    timestamp: new Date().toISOString(),
    tool_result_meta: [{ id: toolUseId, permission_decision: { decision, source: decision === 'accept' ? 'config' : 'user_reject' } }],
  });
}

async function result(text, { isError = false, subtype = 'success', apiErrorStatus = null, extra = {} } = {}) {
  totalCost += 0.001;
  const u = usage();
  await emit(
    {
      type: 'result',
      subtype,
      is_error: isError,
      duration_ms: 12,
      duration_api_ms: 10,
      num_turns: 1,
      result: text,
      stop_reason: isError ? null : 'end_turn',
      session_id: sessionId,
      total_cost_usd: Number(totalCost.toFixed(4)),
      usage: u,
      modelUsage: { [model]: { inputTokens: u.input_tokens, outputTokens: u.output_tokens, cacheReadInputTokens: u.cache_read_input_tokens, cacheCreationInputTokens: u.cache_creation_input_tokens, contextWindow: 200_000, maxOutputTokens: 64_000 } },
      permission_denials: current?.denials ?? [],
      api_error_status: apiErrorStatus,
      terminal_reason: isError ? 'api_error' : 'completed',
      uuid: uuid(),
      ...extra,
    },
    0,
  );
}

async function rateLimitAllowed() {
  await emit({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', resetsAt: Math.floor(Date.now() / 1000) + 86_400, rateLimitType: 'seven_day', isUsingOverage: false, unifiedWindows: { seven_day: { utilization: 0.42, resetsAt: Math.floor(Date.now() / 1000) + 86_400, status: 'allowed' } } }, uuid: uuid(), session_id: sessionId });
}

// ------------------------------------------------------------------ MCP client (Streamable HTTP)

// ------------------------------------------------------------------ MCP client (stdio)

const normTool = (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, '_');
const stdioClients = new Map();

/** Start (once per process) a stdio MCP server from --mcp-config, like the CLI does. Newline-delimited JSON-RPC. */
function stdioClient(serverName, s) {
  let c = stdioClients.get(serverName);
  if (c) return c;
  const child = spawn(s.command, s.args ?? [], { cwd: s.cwd ?? process.cwd(), env: { ...process.env, ...(s.env ?? {}) }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const pending = new Map();
  let nextId = 1;
  const failAll = (err) => {
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  };
  createInterface({ input: child.stdout }).on('line', (line) => {
    const m = safeJson(line);
    if (!m || m.id === undefined || !pending.has(m.id)) return;
    const p = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) p.reject(new Error(`MCP error: ${m.error.message}`));
    else p.resolve(m.result);
  });
  child.stderr.on('data', () => {});
  child.on('error', (err) => {
    stdioClients.delete(serverName);
    failAll(new Error(`MCP server ${serverName} failed to start: ${err.message}`));
  });
  child.on('exit', (code) => {
    stdioClients.delete(serverName);
    failAll(new Error(`MCP server ${serverName} exited with code ${code}`));
  });
  const send = (obj) => child.stdin.write(`${JSON.stringify(obj)}\n`);
  const request = (method, params) =>
    new Promise((res, rej) => {
      const id = nextId++;
      pending.set(id, { resolve: res, reject: rej });
      send({ jsonrpc: '2.0', id, method, params });
    });
  const ready = request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-claude', version: VERSION } }).then((r) => {
    send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
    return r;
  });
  ready.catch(() => undefined);
  c = { child, request, ready, tools: null };
  stdioClients.set(serverName, c);
  return c;
}

async function stdioTools(c) {
  await c.ready;
  c.tools ??= (await c.request('tools/list', {}))?.tools ?? [];
  return c.tools;
}

// The CLI's MCP servers end with it.
process.on('exit', () => {
  for (const c of stdioClients.values()) c.child.kill();
});

async function mcpCall(serverName, tool, args, toolUseId) {
  const s = mcpServers[serverName];
  if (s && !s.url && s.command) {
    const c = stdioClient(serverName, s);
    // `mcp__srv__db_schema` → the server's own name (`db.schema`), as the CLI maps them.
    const real = (await stdioTools(c)).find((t) => t.name === tool || normTool(t.name) === tool)?.name ?? tool;
    return c.request('tools/call', { name: real, arguments: args, _meta: { 'claudecode/toolUseId': toolUseId } });
  }
  if (!s || !s.url) throw new Error(`MCP server ${serverName} is not configured over HTTP`);
  let sid;
  const rpc = async (method, params, id) => {
    const res = await fetch(s.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'user-agent': `fake-claude/${VERSION}`, ...(s.headers ?? {}), ...(sid ? { 'mcp-session-id': sid } : {}) },
      body: JSON.stringify(id === undefined ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id, method, params }),
    });
    sid ??= res.headers.get('mcp-session-id') ?? undefined;
    const body = await res.text();
    if (id === undefined) return undefined;
    if (!res.ok) throw new Error(`MCP HTTP ${res.status}: ${body.slice(0, 200)}`);
    let msg;
    if ((res.headers.get('content-type') ?? '').includes('text/event-stream')) {
      for (const line of body.split(/\r?\n/)) if (line.startsWith('data:')) {
        const m = safeJson(line.slice(5).trim());
        if (m && m.id === id) msg = m;
      }
    } else msg = safeJson(body);
    if (!msg) throw new Error('MCP: empty response');
    if (msg.error) throw new Error(`MCP error: ${msg.error.message}`);
    return msg.result;
  };
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-claude', version: VERSION } }, 1);
  await rpc('notifications/initialized', {});
  return rpc('tools/call', { name: tool, arguments: args, _meta: { 'claudecode/toolUseId': toolUseId } }, 2);
}

function ruleMatches(rule, toolName, input) {
  if (rule === toolName) return true;
  const m = /^([A-Za-z_]+)\((.*)\)$/.exec(rule);
  if (!m || m[1] !== toolName) return false;
  const cmd = String(input?.command ?? '');
  const pat = m[2];
  if (pat.endsWith('*')) return cmd.startsWith(pat.slice(0, -1).replace(/:$/, ''));
  return cmd === pat;
}

/** Same decision order as the CLI: deny rules, allow rules, mode, then the prompt tool. */
async function checkPermission(toolName, input, toolUseId) {
  if (disallowed.some((r) => ruleMatches(r, toolName, input))) return { behavior: 'deny', message: `Permission to use ${toolName} has been denied.` };
  if (['Read', 'Glob', 'Grep', 'TodoWrite', 'ToolSearch', 'Agent', 'Task'].includes(toolName)) return { behavior: 'allow', updatedInput: input };
  if (mode === 'bypassPermissions') return { behavior: 'allow', updatedInput: input };
  if (allowed.some((r) => ruleMatches(r, toolName, input))) return { behavior: 'allow', updatedInput: input };
  if ((mode === 'acceptEdits' || mode === 'auto') && ['Edit', 'Write', 'MultiEdit'].includes(toolName)) return { behavior: 'allow', updatedInput: input };
  if (mode === 'plan') return { behavior: 'deny', message: 'Plan mode: not allowed to change anything.' };
  if (!promptTool) return { behavior: 'deny', message: 'No permission prompt tool configured.' };
  const m = /^mcp__(.+?)__(.+)$/.exec(promptTool);
  if (!m) return { behavior: 'deny', message: 'Bad --permission-prompt-tool' };
  const res = await mcpCall(m[1], m[2], { tool_name: toolName, input, tool_use_id: toolUseId }, toolUseId);
  const answer = safeJson(res?.content?.[0]?.text ?? '');
  if (!answer || (answer.behavior !== 'allow' && answer.behavior !== 'deny')) return { behavior: 'deny', message: 'Invalid permission tool response' };
  return answer;
}

let toolNo = 0;
const toolId = () => `toolu_fake_${String(++toolNo).padStart(4, '0')}`;

/** Emit a tool_use, ask for permission, emulate the tool, emit the tool_result. Returns {ok, text}. */
async function useTool(name, input, { ptu = null, run } = {}) {
  const id = toolId();
  await assistant([{ type: 'tool_use', id, name, input, caller: { type: 'direct' } }], { ptu });
  const decision = await checkPermission(name, input, id);
  if (current?.aborted) throw ABORT;
  if (decision.behavior === 'deny') {
    current?.denials.push({ tool_name: name, tool_use_id: id, tool_input: input });
    await toolResult(id, decision.message ?? 'Denied', { ptu, isError: true, decision: 'reject' });
    return { ok: false, text: decision.message ?? 'Denied', id };
  }
  const inp = decision.updatedInput ?? input;
  let text = 'ok';
  if (run) {
    try {
      text = String(await run(inp));
    } catch (err) {
      await toolResult(id, String(err?.message ?? err), { ptu, isError: true });
      return { ok: false, text: String(err?.message ?? err), id };
    }
  } else if (name === 'Read') text = `1\t${existsSync(String(inp.file_path)) ? readFileSync(String(inp.file_path), 'utf8').split(/\r?\n/)[0] : 'fake file content'}`;
  else if (name === 'Write' || name === 'Edit') {
    const p = resolve(String(inp.file_path));
    if (WRITE_FILES) {
      mkdirSync(dirname(p), { recursive: true });
      if (name === 'Write') writeFileSync(p, String(inp.content ?? ''));
      else writeFileSync(p, (existsSync(p) ? readFileSync(p, 'utf8') : '').replace(String(inp.old_string ?? ''), String(inp.new_string ?? '')));
    }
    text = name === 'Write' ? `File created successfully at: ${p}` : `The file ${p} has been updated successfully.`;
  } else if (name === 'Bash') text = String(inp.command).includes('test') ? 'Tests: 12 passed, 0 failed' : 'done';
  else if (name.startsWith('mcp__')) {
    const m = /^mcp__(.+?)__(.+)$/.exec(name);
    let res;
    try {
      res = await mcpCall(m[1], m[2], inp, id);
    } catch (err) {
      if (current?.aborted) throw ABORT;
      await toolResult(id, String(err?.message ?? err), { ptu, isError: true });
      return { ok: false, text: String(err?.message ?? err), id };
    }
    text = (res?.content ?? []).map((c) => c.text ?? '').join('\n');
    if (res?.isError) {
      await toolResult(id, text, { ptu, isError: true });
      return { ok: false, text, id };
    }
  }
  await toolResult(id, text, { ptu });
  return { ok: true, text, id };
}

// ------------------------------------------------------------------ scenarios

const cwdFile = (rel) => join(process.cwd(), rel);

/** The agent name from oIDE's contract in --append-system-prompt (for the commit trailer). */
function agentName() {
  const p = typeof flags['--append-system-prompt'] === 'string' ? flags['--append-system-prompt'] : '';
  return /Oide-Agent: ([^\n]+)/.exec(p)?.[1]?.trim() ?? 'fake-claude';
}

/** A real commit in the agent's cwd (for the M3 gate), with the contract's `Oide-Agent:` trailer. */
function gitCommit(files, message, name) {
  const git = (...a) => execFileSync('git', a, { cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('add', '--', ...files);
  git('-c', 'user.name=fake-claude', '-c', 'user.email=fake-claude@oide.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', message, '-m', `Oide-Agent: ${name}`);
  return git('rev-parse', '--short', 'HEAD').trim();
}

const SCENARIOS = {
  async basic(userText) {
    await thinking();
    const reply = resumeId && turnNo === 1 ? `Resumed session ${sessionId}.` : `Hello from fake-claude. You said: ${userText.slice(0, 80)}${imageNote()}`;
    await assistant([{ type: 'text', text: reply }], { streamText: reply });
    await rateLimitAllowed();
    await result(reply);
  },

  /** The plan was approved: the CLI leaves plan mode on its own and says so (as after ExitPlanMode). */
  async 'exit-plan'() {
    if (mode === 'plan') {
      mode = 'default';
      await emit({ type: 'system', subtype: 'status', status: null, permissionMode: mode, session_id: sessionId, uuid: uuid() });
    }
    const reply = 'Plan approved; implementing.';
    await assistant([{ type: 'text', text: reply }], { streamText: reply });
    await result(reply);
  },

  async tools() {
    await useTool('TodoWrite', { todos: [{ content: 'Read the readme', status: 'completed', activeForm: 'Reading the readme' }, { content: 'Add fake output', status: 'in_progress', activeForm: 'Adding fake output' }, { content: 'Run tests', status: 'pending', activeForm: 'Running tests' }] });
    await useTool('Read', { file_path: cwdFile('README.md') });
    await useTool('Write', { file_path: cwdFile('fake-output.txt'), content: 'line one\nline two\n' });
    await useTool('Edit', { file_path: cwdFile('fake-output.txt'), old_string: 'line two', new_string: 'line 2 (edited)' });
    const t = await useTool('Bash', { command: 'npm test', description: 'Run tests' });
    const text = t.ok ? 'Wrote fake-output.txt and the tests pass.' : `Wrote fake-output.txt; tests not run: ${t.text}`;
    await assistant([{ type: 'text', text }], { streamText: text });
    await result(text);
  },

  async permission() {
    const t = await useTool('Bash', { command: 'npm test', description: 'Run tests' });
    const text = t.ok ? `Tests ran: ${t.text}` : `I could not run the tests: ${t.text}`;
    await assistant([{ type: 'text', text }]);
    await result(text);
  },

  async review() {
    await useTool('Write', { file_path: cwdFile('feature.txt'), content: 'feature\n' });
    const t = await useTool('Bash', { command: 'npm test', description: 'Run tests' });
    const r = await useTool('mcp__oide__submit_for_review', { summary: 'Added feature.txt.', checks: [{ name: 'npm test', status: t.ok ? 'passed' : 'skipped', detail: t.text }] });
    const text = r.ok ? 'Submitted for review.' : `Could not submit: ${r.text}`;
    await assistant([{ type: 'text', text }]);
    await result(text);
  },

  async subagents() {
    const types = Object.keys(agentsDef);
    const simple = types.includes('simple-task') ? 'simple-task' : 'general-purpose';
    const complex = types.includes('complex-task') ? 'complex-task' : 'general-purpose';
    await thinking();
    // 1) foreground subagent: the report comes back as the Agent tool_result.
    const fg = toolId();
    await assistant([{ type: 'tool_use', id: fg, name: 'Agent', input: { subagent_type: simple, description: 'Read the readme', prompt: 'Read README.md and report its first line.' } }]);
    await emit({ type: 'system', subtype: 'task_started', task_id: 'task_fg', tool_use_id: fg, description: 'Read the readme', subagent_type: simple, task_type: 'local_agent', session_id: sessionId, uuid: uuid() });
    if (forwardSubagents) {
      await useTool('Read', { file_path: cwdFile('README.md') }, { ptu: fg });
      await assistant([{ type: 'text', text: 'The first line is "# fixture".' }], { ptu: fg, usageIdx: 2 });
    }
    await emit({ type: 'system', subtype: 'task_notification', task_id: 'task_fg', tool_use_id: fg, status: 'completed', summary: 'The first line is "# fixture".', usage: { total_tokens: 1500, tool_uses: 1, duration_ms: 20 }, session_id: sessionId, uuid: uuid() });
    await toolResult(fg, [{ type: 'text', text: 'The first line is "# fixture".' }]);
    // 2) async subagent: launched, the lead ends its turn, the report arrives in task_notification.
    const bg = toolId();
    await assistant([{ type: 'tool_use', id: bg, name: 'Agent', input: { subagent_type: complex, description: 'Run the test suite', prompt: 'Run npm test and report failures.' } }]);
    await emit({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'task_bg', task_type: 'local_agent', subagent_type: complex }], session_id: sessionId, uuid: uuid() });
    await emit({ type: 'system', subtype: 'task_started', task_id: 'task_bg', tool_use_id: bg, description: 'Run the test suite', subagent_type: complex, is_backgrounded: true, task_type: 'local_agent', session_id: sessionId, uuid: uuid() });
    await toolResult(bg, [{ type: 'text', text: 'Async agent launched successfully.\nagentId: task_bg' }]);
    await assistant([{ type: 'text', text: 'The test subagent is running in the background.' }]);
    await result('The test subagent is running in the background.');
    let report = 'Tests: 12 passed, 0 failed';
    if (forwardSubagents) {
      const t = await useTool('Bash', { command: 'npm test', description: 'Run tests' }, { ptu: bg });
      report = t.ok ? t.text : `Could not run tests: ${t.text}`;
      await assistant([{ type: 'text', text: report }], { ptu: bg, usageIdx: 3 });
    }
    await emit({ type: 'system', subtype: 'task_updated', task_id: 'task_bg', patch: { status: 'completed', end_time: Date.now() }, session_id: sessionId, uuid: uuid() });
    await emit({ type: 'system', subtype: 'task_notification', task_id: 'task_bg', tool_use_id: bg, status: 'completed', summary: report, usage: { total_tokens: 2500, tool_uses: 1, duration_ms: 30 }, session_id: sessionId, uuid: uuid() });
    await emit({ type: 'system', subtype: 'background_tasks_changed', tasks: [], session_id: sessionId, uuid: uuid() });
    // The CLI wakes the lead for the notification: a new turn without a user message.
    turnNo++;
    await emit(initEvent());
    const text = `Both subagents are done. ${report}`;
    await assistant([{ type: 'text', text }]);
    await result(text);
  },

  async 'rate-limit'() {
    const resetsAt = Math.floor(Date.now() / 1000) + 3600;
    await emit({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt, rateLimitType: 'five_hour', isUsingOverage: false }, uuid: uuid(), session_id: sessionId });
    await emit({ type: 'assistant', message: { model: '<synthetic>', id: uuid(), role: 'assistant', content: [{ type: 'text', text: "You've hit your limit · resets in 1 hour" }], usage: usage() }, parent_tool_use_id: null, session_id: sessionId, error: 'rate_limit', uuid: uuid() });
    await result("You've hit your limit · resets in 1 hour", { isError: true, apiErrorStatus: 429 });
  },

  async auth() {
    await emit({ type: 'assistant', message: { model: '<synthetic>', id: uuid(), role: 'assistant', content: [{ type: 'text', text: 'Not logged in · Please run /login' }] }, parent_tool_use_id: null, session_id: sessionId, error: 'authentication_failed', uuid: uuid() });
    await result('Not logged in · Please run /login', { isError: true, apiErrorStatus: 401 });
  },

  async crash() {
    await emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Starting…' } }, session_id: sessionId, parent_tool_use_id: null, uuid: uuid() });
    process.stderr.write('Error: simulated crash in fake-claude\n');
    await sleep(5);
    process.exit(Number(flags['--fake-exit-code'] ?? process.env.FAKE_CLAUDE_EXIT_CODE ?? 3));
  },

  // M3 gate: commit one file (with the Oide-Agent trailer), leave another uncommitted, submit for review.
  async 'commit-work'() {
    const name = agentName();
    await useTool('Write', { file_path: cwdFile('committed.txt'), content: 'committed by the agent\n' });
    const c = await useTool('Bash', { command: 'git add committed.txt && git commit -m "Add committed.txt"', description: 'Commit committed.txt' }, { run: () => (WRITE_FILES ? gitCommit(['committed.txt'], 'Add committed.txt', name) : 'skipped') });
    await useTool('Write', { file_path: cwdFile('pending.txt'), content: 'pending\n' });
    const t = await useTool('Bash', { command: 'npm test', description: 'Run tests' });
    const r = await useTool('mcp__oide__submit_for_review', {
      summary: 'Committed committed.txt; pending.txt is still uncommitted.',
      checks: [
        { name: 'npm test', status: t.ok ? 'passed' : 'skipped', detail: t.text },
        { name: 'commit', status: c.ok ? 'passed' : 'failed', detail: c.text },
      ],
    });
    const text = r.ok ? 'Submitted for review.' : `Could not submit: ${r.text}`;
    await assistant([{ type: 'text', text }]);
    await result(text);
  },

  // M3 gate, second turn: address the review feedback in the uncommitted file and submit again.
  async 'address-feedback'(userText) {
    const comment = /^- ([^\n]+)$/m.exec(userText)?.[1] ?? 'feedback';
    await useTool('Edit', { file_path: cwdFile('pending.txt'), old_string: 'pending\n', new_string: `pending\naddressed: ${comment.replace(/\s+/g, ' ').slice(0, 80)}\n` });
    const r = await useTool('mcp__oide__submit_for_review', { summary: 'Addressed the review feedback in pending.txt.', checks: [{ name: 'npm test', status: 'passed' }] });
    const text = r.ok ? 'Addressed the feedback and submitted again.' : `Could not submit: ${r.text}`;
    await assistant([{ type: 'text', text }]);
    await result(text);
  },

  // "Commit everything you have" (all changes in cwd, with the trailer); ends the turn with a question.
  async 'commit-all'() {
    const c = await useTool('Bash', { command: 'git add -A && git commit -m "Commit remaining work"', description: 'Commit all changes' }, { run: () => (WRITE_FILES ? gitCommit(['.'], 'Commit remaining work', agentName()) : 'skipped') });
    const text = c.ok ? `Committed everything (${c.text}). Anything else?` : `Could not commit: ${c.text}`;
    await assistant([{ type: 'text', text }]);
    await result(text);
  },

  // oIDE's merge-conflicts message: run the `git merge <ref>` it names in cwd, resolve every conflict by
  // keeping both sides (ours, then theirs), commit the merge with the trailer, and submit for review.
  async 'resolve-conflicts'(userText) {
    const ref = /`git merge ([^`\s]+)`/.exec(userText)?.[1];
    if (!ref) {
      const text = 'The message does not say what to merge.';
      await assistant([{ type: 'text', text }]);
      await result(text);
      return;
    }
    const git = (...a) => execFileSync('git', a, { cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const ident = ['-c', 'user.name=fake-claude', '-c', 'user.email=fake-claude@oide.invalid', '-c', 'commit.gpgsign=false'];
    let conflicted = [];
    const m = await useTool('Bash', { command: `git merge ${ref}`, description: `Merge ${ref}` }, {
      run: () => {
        if (!WRITE_FILES) return 'skipped';
        try {
          return git(...ident, 'merge', '--no-edit', ref) || 'Merged cleanly.';
        } catch {
          conflicted = git('diff', '--name-only', '--diff-filter=U').split(/\r?\n/).filter(Boolean);
          return `Automatic merge failed; fix conflicts in: ${conflicted.join(', ')}`;
        }
      },
    });
    for (const f of conflicted) {
      const p = cwdFile(f);
      const before = readFileSync(p, 'utf8');
      // Keep both sides, ours first: drop the markers only.
      const after = before.replace(/^<<<<<<< [^\n]*\n([\s\S]*?)^(?:\|\|\|\|\|\|\| [^\n]*\n[\s\S]*?)?^=======\r?\n([\s\S]*?)^>>>>>>> [^\n]*\n/gm, '$1$2');
      await useTool('Write', { file_path: p, content: after });
    }
    const c = conflicted.length
      ? await useTool('Bash', { command: 'git add -A && git commit --no-edit', description: 'Commit the merge' }, { run: () => (WRITE_FILES ? (git('add', '-A'), git(...ident, 'commit', '-q', '--no-edit', '-m', `Merge ${ref}`, '-m', `Oide-Agent: ${agentName()}`), git('rev-parse', '--short', 'HEAD').trim()) : 'skipped') })
      : m;
    const r = await useTool('mcp__oide__submit_for_review', {
      summary: conflicted.length ? `Merged ${ref} and resolved conflicts in ${conflicted.join(', ')} (kept both sides).` : `Merged ${ref}; there were no conflicts.`,
      checks: [{ name: 'merge', status: m.ok && c.ok ? 'passed' : 'failed', detail: c.text }],
    });
    const text = r.ok ? 'Resolved the merge conflicts and submitted for review again.' : `Could not submit: ${r.text}`;
    await assistant([{ type: 'text', text }]);
    await result(text);
  },

  // M5 gate: load and call an MCP tool. `[fake-tool:mcp__srv__tool]` and `[fake-args:{…}]` in the
  // message pick it; otherwise the first tool of the first stdio server in --mcp-config.
  async 'mcp-tool'(userText) {
    let tool = /\[fake-tool:(mcp__[A-Za-z0-9_-]+?__[A-Za-z0-9_-]+)\]/.exec(userText)?.[1];
    const args = safeJson(/\[fake-args:(\{[^\]]*\})\]/.exec(userText)?.[1] ?? '{}') ?? {};
    if (!tool) {
      for (const [name, s] of Object.entries(mcpServers)) {
        if (!s?.command) continue;
        const first = (await stdioTools(stdioClient(name, s)).catch(() => []))[0];
        if (first) {
          tool = `mcp__${normTool(name)}__${normTool(first.name)}`;
          break;
        }
      }
    }
    if (!tool) {
      const text = 'No MCP tool is available.';
      await assistant([{ type: 'text', text }]);
      await result(text);
      return;
    }
    await useTool('ToolSearch', { query: `select:${tool}`, max_results: 1 });
    const r = await useTool(tool, args);
    const text = r.ok ? `The ${tool} tool returned: ${r.text}` : `The ${tool} tool failed: ${r.text}`;
    await assistant([{ type: 'text', text }], { streamText: text });
    await result(text);
  },

  // M6 gate: read the design artifact named in the message, then write a doc artifact from it.
  async artifacts(userText) {
    let id = /\{"id":"([^"]+)"\}/.exec(userText)?.[1];
    if (!id) {
      const l = await useTool('mcp__oide__artifacts_list', { kind: 'design' });
      id = (safeJson(l.text) ?? [])[0]?.id;
    }
    const read = await useTool('mcp__oide__artifacts_read', { id: id ?? 'none' });
    const got = read.ok ? safeJson(read.text) : undefined;
    const title = got?.meta?.title ?? 'the design';
    const headings = [...String(got?.content ?? '').matchAll(/<h[1-3][^>]*>(.*?)<\/h[1-3]>/gi)].map((m) => m[1]);
    const doc = `# Notes on ${title}\n\nSections in the design:\n${headings.map((h) => `- ${h}`).join('\n') || '- (none)'}\n`;
    const created = await useTool('mcp__oide__artifacts_create', { title: `Notes on ${title}`, kind: 'doc', content: doc });
    const newId = created.ok ? safeJson(created.text)?.id : undefined;
    const text = newId ? `Read "${title}" and wrote the doc artifact ${newId}.` : `Could not write the doc: ${created.text}`;
    await assistant([{ type: 'text', text }]);
    await result(text);
  },

  // An agent updates an existing artifact: read the `{"id":"…"}` in the message, then write a new
  // version with a line appended (a design gets an <h2>, a doc a list item).
  async 'artifact-update'(userText) {
    const id = /\{"id":"([^"]+)"\}/.exec(userText)?.[1] ?? 'none';
    const read = await useTool('mcp__oide__artifacts_read', { id });
    const got = read.ok ? safeJson(read.text) : undefined;
    const before = String(got?.content ?? '');
    const content = got?.meta?.kind === 'design' ? `${before}\n<h2>Added by the agent</h2>\n` : `${before}\n- Added by the agent\n`;
    const wrote = await useTool('mcp__oide__artifacts_write', { id, content, note: 'Added a section' });
    const version = wrote.ok ? safeJson(wrote.text)?.version : undefined;
    const text = version ? `Updated "${got?.meta?.title ?? id}" to v${version}.` : `Could not update the artifact: ${wrote.text}`;
    await assistant([{ type: 'text', text }]);
    await result(text);
  },

  async slow() {
    const id = messageId();
    let text = '';
    for (let i = 1; i <= 400; i++) {
      text += `${i}\n`;
      await emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `${i}\n` } }, session_id: sessionId, parent_tool_use_id: null, uuid: uuid(), api_message_id: id }, 25);
    }
    await assistant([{ type: 'text', text }], { id });
    await result(text);
  },
};

const replayCursor = new Map();
async function replay(file, userText) {
  const path = isAbsolute(file) ? file : join(FIXTURES, file);
  const lines = readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean);
  let i = replayCursor.get(path) ?? 0;
  let sawResult = false;
  for (; i < lines.length && !sawResult; i++) {
    const obj = safeJson(lines[i]);
    // Our own init was already emitted for this turn; control responses only answer real requests.
    if (!obj || obj.type === 'control_response' || (obj.type === 'system' && obj.subtype === 'init')) continue;
    await emit({ ...obj, ...(obj.session_id ? { session_id: sessionId } : {}) }, 0);
    sawResult = obj.type === 'result';
  }
  replayCursor.set(path, i);
  if (!sawResult) await result(`replay of ${file} ended (${userText.length} chars in)`);
}

async function slashCommand(cmd) {
  const name = cmd.slice(1).split(/\s+/)[0];
  if (name === 'compact') {
    await emit({ type: 'system', subtype: 'status', status: 'compacting', session_id: sessionId, uuid: uuid() });
    await emit({ type: 'system', subtype: 'status', status: null, compact_result: 'success', session_id: sessionId, uuid: uuid() });
    await emit({ type: 'system', subtype: 'compact_boundary', session_id: sessionId, uuid: uuid(), compact_metadata: { trigger: 'manual', pre_tokens: 58_310, post_tokens: 21_864 } });
    await emit({ type: 'user', message: { role: 'user', content: '<local-command-stdout>Compacted </local-command-stdout>' }, session_id: sessionId, parent_tool_use_id: null, uuid: uuid(), isReplay: true });
    await result('', { extra: { local_command: 'compact', num_turns: 0 } });
    return;
  }
  await emit({ type: 'user', message: { role: 'user', content: `<local-command-stdout>${name}: ok</local-command-stdout>` }, session_id: sessionId, parent_tool_use_id: null, uuid: uuid(), isReplay: true });
  await result('', { extra: { local_command: name, num_turns: 0 } });
}

function userTextOf(msg) {
  const c = msg?.message?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter((b) => typeof b?.text === 'string').map((b) => b.text).join('\n');
  return '';
}

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
let turnImages = [];

/** Image blocks of a user message; throws on a block the API would refuse. */
function imagesOf(msg) {
  const c = msg?.message?.content;
  if (!Array.isArray(c)) return [];
  return c
    .filter((b) => b?.type === 'image')
    .map((b) => {
      const src = b.source ?? {};
      if (src.type !== 'base64' || !IMAGE_TYPES.includes(src.media_type) || typeof src.data !== 'string' || !src.data || !/^[A-Za-z0-9+/]+={0,2}$/.test(src.data)) {
        throw new Error('messages.0.content: invalid image source (base64 png, jpeg, gif or webp)');
      }
      return { mediaType: src.media_type, bytes: Buffer.from(src.data, 'base64').length };
    });
}

function imageNote() {
  if (!turnImages.length) return '';
  const n = turnImages.length;
  return ` [${n} image${n === 1 ? '' : 's'}: ${turnImages.map((i) => `${i.mediaType}, ${i.bytes} bytes`).join('; ')}]`;
}

async function runTurn(msg) {
  const text = userTextOf(msg);
  try {
    turnImages = imagesOf(msg);
  } catch (err) {
    turnNo++;
    await emit(initEvent());
    out({ type: 'result', subtype: 'success', is_error: true, api_error_status: 400, result: `API Error: 400 ${err.message}`, session_id: sessionId, uuid: uuid() });
    return;
  }
  current = { aborted: false, denials: [] };
  turnNo++;
  try {
    await emit(initEvent());
    if (text.trim().startsWith('/')) await slashCommand(text.trim());
    else {
      // oIDE's merge-conflicts message always gets resolve-conflicts, as a real agent would act on it.
      const name =
        /\[fake-scenario:([A-Za-z0-9:._-]+)\]/.exec(text)?.[1] ??
        (text.startsWith('[Sent by oIDE] Merge conflicts') ? 'resolve-conflicts' : undefined) ??
        scenarios[Math.min(turnNo - 1, scenarios.length - 1)] ??
        'basic';
      if (name.startsWith('replay:')) await replay(name.slice('replay:'.length), text);
      else if (SCENARIOS[name]) await SCENARIOS[name](text);
      else await SCENARIOS.basic(text);
    }
  } catch (err) {
    if (err !== ABORT) {
      process.stderr.write(`fake-claude error: ${err?.message ?? err}\n`);
      current = null;
      out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: String(err?.message ?? err), session_id: sessionId, uuid: uuid(), errors: [String(err?.message ?? err)] });
      return;
    }
    current = null;
    out({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] }, parent_tool_use_id: null, session_id: sessionId, uuid: uuid() });
    out({ type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 1, session_id: sessionId, terminal_reason: 'aborted_streaming', errors: ['[ede_diagnostic] interrupted'], uuid: uuid() });
    return;
  }
  current = null;
}

// ------------------------------------------------------------------ stdin loop

const pendingTurns = [];
let running = false;
let stdinEnded = false;

async function drain() {
  if (running) return;
  running = true;
  while (pendingTurns.length) await runTurn(pendingTurns.shift());
  running = false;
  if (stdinEnded) process.exit(0);
}

function handleControl(msg) {
  if (flags['--fake-no-control'] || process.env.FAKE_CLAUDE_NO_CONTROL === '1') return;
  const sub = msg.request?.subtype;
  const reply = (response) => out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response } });
  const fail = (error) => out({ type: 'control_response', response: { subtype: 'error', request_id: msg.request_id, error } });
  if (sub === 'interrupt') {
    if (current) current.aborted = true;
    reply({ still_queued: [] });
  } else if (sub === 'set_permission_mode') {
    if (!MODES.includes(msg.request.mode)) return fail(`Invalid permission mode: ${msg.request.mode}`);
    if (msg.request.mode === 'bypassPermissions' && !bypassAvailable) {
      return out({ type: 'control_response', response: { subtype: 'error', request_id: msg.request_id, error: 'Cannot set permission mode to bypassPermissions because the session was not launched with --dangerously-skip-permissions', error_code: 'bypass_not_launched' } });
    }
    mode = msg.request.mode;
    reply({ mode });
    out({ type: 'system', subtype: 'status', status: null, permissionMode: mode, session_id: sessionId, uuid: uuid() });
  } else fail(`Unsupported control request: ${sub}`);
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  const msg = safeJson(line);
  record({ stdin: msg ?? line });
  if (!msg) return;
  if (msg.type === 'control_request') return handleControl(msg);
  if (msg.type === 'user') {
    pendingTurns.push(msg);
    void drain();
  }
});
rl.on('close', () => {
  stdinEnded = true;
  if (!running && !pendingTurns.length) process.exit(0);
});
process.on('SIGINT', () => process.exit(130));
process.on('SIGTERM', () => process.exit(143));
