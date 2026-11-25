import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ENV_ALLOW_LIST as AGENT_ENV_ALLOW_LIST } from '../../../packages/agent-core/src/args.js';
// @ts-expect-error plain .mjs script without type declarations
import { allowListEnv, createSanitizer, ENV_ALLOW_LIST, PLACEHOLDER } from '../record.mjs';

const RECORD = fileURLToPath(new URL('../record.mjs', import.meta.url));

describe('record.mjs sanitizer', () => {
  const ctx = { home: 'C:\\Users\\Ada', user: 'Ada', host: 'ADA-LAPTOP', cwd: 'C:\\Users\\Ada\\AppData\\Local\\Temp\\oide-record-x1', sessionId: '9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f' };

  it('replaces cwd, home, user and host in plain and JSON-escaped forms', () => {
    const s = createSanitizer(ctx);
    expect(s.text('cwd C:\\Users\\Ada\\AppData\\Local\\Temp\\oide-record-x1\\notes.txt')).toBe(`cwd ${PLACEHOLDER.cwd}\\notes.txt`);
    expect(s.text('home C:/Users/Ada/x on ADA-LAPTOP by Ada')).toBe(`home ${PLACEHOLDER.home}/x on host by user`);
    const line = JSON.stringify({ type: 'system', subtype: 'init', cwd: ctx.cwd, path: `${ctx.home}\\.config`, session_id: ctx.sessionId });
    const out = JSON.parse(s.line(line));
    expect(out).toEqual({ type: 'system', subtype: 'init', cwd: PLACEHOLDER.cwd, path: `${PLACEHOLDER.home}\\.config`, session_id: PLACEHOLDER.sessionId });
    expect(s.line(line)).not.toMatch(/Ada/i);
  });

  it('maps uuids and tool/message ids to stable placeholders', () => {
    const s = createSanitizer(ctx);
    const a = JSON.parse(s.line(JSON.stringify({ uuid: 'AAAAAAAA-1111-4111-8111-111111111111', message: { id: 'msg_01XyZ', content: [{ type: 'tool_use', id: 'toolu_01Abc' }] } })));
    const b = JSON.parse(s.line(JSON.stringify({ uuid: 'bbbbbbbb-2222-4222-8222-222222222222', parent_tool_use_id: 'toolu_01Abc', ref: 'aaaaaaaa-1111-4111-8111-111111111111' })));
    expect(a.uuid).toBe('00000000-0000-4000-8000-000000000001');
    expect(a.message.id).toBe('msg_0001');
    expect(a.message.content[0].id).toBe('toolu_0001');
    expect(b.uuid).toBe('00000000-0000-4000-8000-000000000002');
    expect(b.parent_tool_use_id).toBe('toolu_0001');
    expect(b.ref).toBe(a.uuid);
  });

  it('redacts emails, secret-named fields and token-looking strings', () => {
    const s = createSanitizer(ctx);
    const out = JSON.parse(
      s.line(
        JSON.stringify({
          account: 'ada@example.org',
          signature: 'EqQBCkYIBRgCKkB',
          apiKeySource: 'none',
          text: 'key sk-ant-api03-abcdefghijklmnop and Bearer abc.def.ghi123 and eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig12345 and Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZmdoaWprbG1ub3A',
        }),
      ),
    );
    expect(out.account).toBe(PLACEHOLDER.email);
    expect(out.signature).toBe(PLACEHOLDER.secret);
    expect(out.apiKeySource).toBe('none');
    expect(out.text).toBe(`key ${PLACEHOLDER.secret} and Bearer ${PLACEHOLDER.secret} and ${PLACEHOLDER.secret} and ${PLACEHOLDER.secret}`);
  });

  it('scrubs every spelling of home, cwd and temp paths (crafted input)', () => {
    const c = { home: 'C:\\Users\\ada.lovelace', user: 'ada.lovelace', host: 'ADA-LAPTOP', tmp: 'C:\\Users\\ada.lovelace\\AppData\\Local\\Temp', cwd: 'C:\\Users\\ada.lovelace\\AppData\\Local\\Temp\\oide-record-Xy12', sessionId: ctx.sessionId };
    const s = createSanitizer(c);
    const raw = [
      'native C:\\Users\\ada.lovelace\\.gitconfig',
      'fwd C:/Users/ada.lovelace/.gitconfig',
      'lower c:\\users\\ada.lovelace\\x',
      'escaped "C:\\\\Users\\\\ada.lovelace\\\\AppData\\\\Local\\\\Temp\\\\oide-record-Xy12\\\\notes.txt"',
      'slash-escaped C:\\/Users\\/ada.lovelace\\/y',
      'msys /c/Users/ada.lovelace/z and wsl /mnt/c/Users/ada.lovelace/w',
      'slug ~/.claude/projects/C--Users-ada-lovelace-AppData-Local-Temp-oide-record-Xy12/s.jsonl',
      'temp C:\\Users\\ada.lovelace\\AppData\\Local\\Temp\\claude\\0a1b2c3d4e5f\\scratchpad\\out.txt',
      'user alone: D:\\src\\ada.lovelace\\proj by ada.lovelace on ADA-LAPTOP',
    ].join('\n');
    const out = s.text(raw);
    expect(out).not.toMatch(/ada|lovelace|ADA-LAPTOP|Xy12|0a1b2c3d4e5f|AppData|Users/i);
    expect(out).toContain(`native ${PLACEHOLDER.home}\\.gitconfig`);
    expect(out).toContain(`fwd ${PLACEHOLDER.home}/.gitconfig`);
    expect(out).toContain(`"${PLACEHOLDER.cwd}\\\\notes.txt"`);
    expect(out).toContain('slug ~/.claude/projects/-work-repo/s.jsonl');
    expect(out).toContain(`temp ${PLACEHOLDER.tmp}`);
    expect(out).toContain('D:\\src\\user\\proj by user on host');
    // In a JSON line the escaped form is what the parser sees; it comes back clean too.
    const line = JSON.stringify({ type: 'system', cwd: c.cwd, memory: `${c.home}\\.claude\\projects\\C--Users-ada-lovelace\\m.md` });
    expect(s.line(line)).not.toMatch(/ada|lovelace|Users/i);
  });

  it('scrubs other accounts\' user folders and temp folders that no ctx value names', () => {
    const s = createSanitizer({});
    const out = s.text(
      [
        'C:\\Users\\runneradmin\\AppData\\Local\\Temp\\tmp-123\\a.txt',
        'D:/Users/bob/projects/x',
        '/Users/carol/dev/repo and /home/dave/repo',
        '/private/var/folders/zz/abc123def/T/oide-record-1/x and /tmp/oide-record-2/y',
        'C--Users-erin-repo -Users-frank-repo -home-gina-repo',
      ].join('\n'),
    );
    expect(out).not.toMatch(/runneradmin|bob|carol|dave|abc123def|oide-record|erin|frank|gina/);
    expect(out).toContain('/home/user/projects/x');
    expect(out).toContain('-home-user-repo');
  });

  it('scrubs e-mails, account / org / user ids and identifying uuids', () => {
    const s = createSanitizer(ctx);
    const out = JSON.parse(
      s.line(
        JSON.stringify({
          type: 'system',
          account: { email: 'ada@lovelace.dev', accountUuid: '4f1d2c3b-aaaa-4bbb-8ccc-0123456789ab', organizationUuid: 'b2c3d4e5-1111-4222-8333-444455556666', organizationName: "Ada's Lab", displayName: 'Ada', organization_role: 'admin', billingType: 'max' },
          text: 'signed in as ada%40lovelace.dev (org_01HZX9ABCDEF1234, user-9F8E7D6C5B4A3210) org 4f1d2c3b-aaaa-4bbb-8ccc-0123456789ab',
        }),
      ),
    );
    expect(out.account).toEqual({ email: PLACEHOLDER.email, accountUuid: PLACEHOLDER.secret, organizationUuid: PLACEHOLDER.secret, organizationName: PLACEHOLDER.secret, displayName: PLACEHOLDER.secret, organization_role: PLACEHOLDER.secret, billingType: PLACEHOLDER.secret });
    expect(out.text).toBe(`signed in as ${PLACEHOLDER.email} (acct_0001, acct_0002) org 00000000-0000-4000-8000-000000000001`);
  });

  it('leaves ordinary text, flags and paths alone', () => {
    const s = createSanitizer(ctx);
    const help = '  --permission-prompt-tool <tool>  MCP tool to handle permission prompts\n  --include-partial-messages\n  see /work/repo/src/components/very-long-component-name-for-testing.tsx';
    expect(s.text(help)).toBe(help);
    expect(s.line('not json {')).toBe('not json {');
  });

  it('passes only allow-listed env names to the CLI (same list as the agent env)', () => {
    expect([...ENV_ALLOW_LIST].sort()).toEqual([...AGENT_ENV_ALLOW_LIST].sort());
    const env = allowListEnv({ PATH: '/bin', Path: 'C:\\bin', ANTHROPIC_API_KEY: 'x', CLAUDE_CODE_OAUTH_TOKEN: 'y', GITHUB_TOKEN: 'z', LC_ALL: 'C', HOME: '/h' });
    expect(Object.keys(env).sort()).toEqual(['HOME', 'LC_ALL', 'PATH', 'Path']);
  });

  it('never reads token env vars or files under the CLI config folder', () => {
    const src = readFileSync(RECORD, 'utf8');
    expect(src).not.toMatch(/readFileSync|createReadStream|readdirSync/);
    expect(src).not.toMatch(/process\.env\.(ANTHROPIC|CLAUDE_CODE)/);
  });

  it('prints usage without running anything', () => {
    const r = spawnSync(process.execPath, [RECORD, '--help'], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/--out <dir>/);
  });
});
