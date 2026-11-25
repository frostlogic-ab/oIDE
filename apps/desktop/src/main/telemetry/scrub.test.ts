import { describe, expect, it } from 'vitest';
import { Redactor } from '../reliability/redact.js';
import { createScrubber, MAX_MESSAGE } from './scrub.js';

/** Small seeded PRNG (mulberry32), so a failure is reproducible from the seed. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WIN_HOME = 'C:\\Users\\Jane Doe';
const POSIX_HOME = '/home/jdoe';

describe('error scrubber', () => {
  const sc = createScrubber({
    redactor: new Redactor({
      home: WIN_HOME,
      paths: { 'C:\\Users\\Jane Doe\\AppData\\Roaming\\oIDE': '<userData>' },
    }),
    username: 'jdoe',
    hostname: 'JANES-LAPTOP',
    appRoots: ['C:\\Program Files\\oIDE\\resources\\app.asar', '/opt/oIDE/resources/app.asar'],
    appOrigins: ['http://localhost:5173'],
  });

  it('keeps an identifier-only name', () => {
    expect(sc.name('TypeError')).toBe('TypeError');
    expect(sc.name('Error: C:\\x')).toBe('ErrorCx');
    expect(sc.name('<script>')).toBe('script');
    expect(sc.name('')).toBe('Error');
    expect(sc.name(42)).toBe('Error');
  });

  it('replaces paths, emails, URLs, quoted text and tokens with placeholders', () => {
    const m = sc.message(
      "ENOENT: no such file or directory, open 'C:\\Users\\Jane Doe\\acme\\plan.md' (jane.doe@acme.com) https://git.acme.internal/x?token=abc sk-ant-api03-abcdefghijklmnop 0123456789abcdef0123 /home/jdoe/acme/src/x.ts src/secret/thing.ts notes.md",
    );
    expect(m).not.toMatch(
      /Jane|acme|plan|jane\.doe|git\.acme|token=|sk-ant|0123456789abcdef|jdoe|secret|thing|notes/i,
    );
    expect(m).toMatch(/^ENOENT: no such file or directory, open/);
    expect(m).toContain('<email>');
    expect(m).toContain('<url>');
  });

  it('removes the home folder on Windows and POSIX, in both slash styles', () => {
    const posix = createScrubber({ redactor: new Redactor({ home: POSIX_HOME }), username: 'jdoe' });
    expect(posix.message('cannot read /home/jdoe/.config/x')).toBe('cannot read <path>');
    expect(posix.message('cwd ~/projects/acme failed')).toBe('cwd <path> failed');
    expect(sc.message('at c:/users/jane doe/projects/app')).not.toMatch(/jane|projects|app\b/i);
    expect(sc.message('file:///C:/Users/Jane%20Doe/x.txt missing')).toBe('<url> missing');
    expect(sc.message('\\\\fileserver\\share\\team\\doc.docx is locked')).toBe('<path> is locked');
  });

  it('removes the user and machine names wherever they stand alone', () => {
    expect(sc.message('permission denied for jdoe on JANES-LAPTOP')).toBe(
      'permission denied for <user> on <user>',
    );
  });

  it('caps the message length', () => {
    expect(sc.message('word '.repeat(1000)).length).toBeLessThanOrEqual(MAX_MESSAGE);
  });

  it('keeps only app-bundle frames, app-relative, behind a rebuilt first line', () => {
    const stack = [
      "TypeError: Cannot read properties of undefined (reading 'title') in C:\\Users\\Jane Doe\\acme",
      '    at renderTile (file:///C:/Program%20Files/oIDE/resources/app.asar/out/renderer/assets/index-3f9a2c1b.js:12:345)',
      '    at Object.<anonymous> (C:\\Program Files\\oIDE\\resources\\app.asar\\out\\main\\index.js:99:7)',
      '    at readFile (node:internal/fs/promises:1:1)',
      '    at userCode (C:\\Users\\Jane Doe\\acme\\tool.js:1:1)',
      '    at async run (/opt/oIDE/resources/app.asar/out/main/index.js:5:5)',
      '    at App (http://localhost:5173/src/App.tsx?t=123:10:2)',
      '    at evil (http://attacker.example/x.js:1:1)',
      'onClick@file:///C:/Program%20Files/oIDE/resources/app.asar/out/renderer/assets/index.js:3:4',
    ].join('\n');
    const name = sc.name('TypeError');
    const message = sc.message(
      "Cannot read properties of undefined (reading 'title') in C:\\Users\\Jane Doe\\acme",
    );
    const out = sc.stack(stack, name, message);
    expect(out.split('\n')).toEqual([
      `TypeError: ${message}`,
      '    at renderTile (/out/renderer/assets/index-3f9a2c1b.js:12:345)',
      '    at Object.<anonymous> (/out/main/index.js:99:7)',
      '    at run (/out/main/index.js:5:5)',
      '    at App (/src/App.tsx:10:2)',
      '    at onClick (/out/renderer/assets/index.js:3:4)',
    ]);
    expect(out).not.toMatch(/Jane|acme|node:internal|attacker|title/);
  });

  it('matches the frame format Umami parses (`at fn (/file:line:col)`)', () => {
    const out = sc.stack(
      'Error: x\n    at f (/opt/oIDE/resources/app.asar/out/main/index.js:1:2)',
      'Error',
      'x',
    );
    const line = out.split('\n')[1]!;
    // From umami v3.5.0 src/lib/errors/normalize.ts
    const umami = /^(?:at\s+)?(?:(.*?)\s*[@(])?((?:https?:\/\/|\/|webpack:|file:)[^\s]*?):(\d+):(\d+)\)?$/;
    expect(umami.exec(line.trim())?.slice(1)).toEqual(['f', '/out/main/index.js', '1', '2']);
  });

  it('fuzz: paths, emails, URLs, home folders, user names and tokens never survive (2000 seeded cases)', () => {
    const r = rng(0xc0ffee);
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
    const word = (n = 6 + Math.floor(r() * 6)) => {
      let s = 'q';
      for (let i = 1; i < n; i++) s += 'abcdefghijkmnpqrstuvwxyz23456789'[Math.floor(r() * 32)];
      return s;
    };
    const hex = (n: number) =>
      Array.from({ length: n }, () => '0123456789abcdef'[Math.floor(r() * 16)]).join('');
    const b64 = (n: number) =>
      Array.from(
        { length: n },
        () => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'[Math.floor(r() * 64)],
      ).join('');
    const ext = () => pick(['ts', 'md', 'json', 'py', 'tsx', 'txt', 'yml', 'rs', 'go', 'png']);

    const makers: Array<() => { text: string; secrets: string[] }> = [
      () => {
        const [a, b] = [word(), word()];
        return { text: `C:\\Users\\Jane Doe\\${a}\\${b}.${ext()}`, secrets: [a, b, 'Jane'] };
      },
      () => {
        const [a, b] = [word(), word()];
        return { text: `c:/users/jane doe/${a}/${b}.${ext()}`, secrets: [a, b, 'jane'] };
      },
      () => {
        const [a, b] = [word(), word()];
        return { text: `D:\\work\\${a}\\${b}`, secrets: [a, b] };
      },
      () => {
        const [a, b] = [word(), word()];
        return { text: `\\\\${a}\\${b}\\x.${ext()}`, secrets: [a, b] };
      },
      () => {
        const [a, b] = [word(), word()];
        return { text: `/home/jdoe/${a}/${b}.${ext()}`, secrets: [a, b, 'jdoe'] };
      },
      () => {
        const [a, b] = [word(), word()];
        return { text: `/Users/${a}/Library/${b}`, secrets: [a, b] };
      },
      () => {
        const a = word();
        return { text: `~/${a}/x.${ext()}`, secrets: [a] };
      },
      () => {
        const [a, b] = [word(), word()];
        return { text: `./${a}/${b}.${ext()}`, secrets: [a, b] };
      },
      () => {
        const [a, b] = [word(), word()];
        return { text: `${a}/${b}/index.${ext()}`, secrets: [a, b] };
      },
      () => {
        const a = word();
        return { text: `${a}.${ext()}`, secrets: [a] };
      },
      () => {
        const [a, b] = [word(), word()];
        return { text: `file:///C:/Users/Jane%20Doe/${a}/${b}.${ext()}`, secrets: [a, b] };
      },
      () => {
        const [a, b, c] = [word(), word(), word()];
        return { text: `${a}.${b}@${c}.com`, secrets: [a, b, c] };
      },
      () => {
        const [a, b, c] = [word(), word(), word()];
        return { text: `https://${a}.example.com/${b}?q=${c}&token=${hex(24)}`, secrets: [a, b, c] };
      },
      () => {
        const t = hex(32 + Math.floor(r() * 32));
        return { text: t, secrets: [t.slice(0, 16)] };
      },
      () => {
        const t = b64(40);
        return { text: t, secrets: [t.slice(0, 24)] };
      },
      () => {
        const t = `eyJ${b64(20).replace(/[+/]/g, 'x')}.eyJ${b64(30).replace(/[+/]/g, 'x')}.${b64(20).replace(/[+/]/g, 'x')}`;
        return { text: t, secrets: [t.slice(0, 20)] };
      },
      () => {
        const t = `sk-ant-api03-${b64(30).replace(/[+/]/g, 'x')}`;
        return { text: t, secrets: [t.slice(0, 20)] };
      },
      () => {
        const t = `ghp_${b64(36).replace(/[+/]/g, 'x')}`;
        return { text: t, secrets: [t.slice(0, 16)] };
      },
      () => {
        const a = word();
        return { text: `'${a} something private'`, secrets: [a] };
      },
      () => {
        const a = word();
        return { text: `branch "${a}"`, secrets: [a] };
      },
      () => ({ text: 'running as jdoe on JANES-LAPTOP', secrets: ['jdoe', 'JANES-LAPTOP'] }),
      () => {
        const [a, b] = [
          `${Math.floor(r() * 255)}.${Math.floor(r() * 255)}.${Math.floor(r() * 255)}.${Math.floor(r() * 255)}`,
          word(),
        ];
        return { text: `connect ${a} ${b}/x`, secrets: [a, b] };
      },
    ];
    const fillers = [
      'Error while reading',
      'failed:',
      'at step 3',
      'ENOENT',
      '(',
      ')',
      ',',
      'TypeError: x',
      'in',
      'value',
      '—',
      ':',
      '=',
      '[',
      ']',
    ];

    for (let i = 0; i < 2000; i++) {
      const parts: string[] = [];
      const secrets: string[] = [];
      const n = 1 + Math.floor(r() * 4);
      for (let k = 0; k < n; k++) {
        parts.push(pick(fillers));
        const m = pick(makers)();
        parts.push(m.text);
        secrets.push(...m.secrets);
      }
      parts.push(pick(fillers));
      const input = parts.join(pick([' ', ' ', '  ', '\n', '\t']));
      const out = sc.message(input);
      for (const s of secrets)
        expect(
          out.toLowerCase().includes(s.toLowerCase()),
          `case ${i}: "${s}" survived in ${JSON.stringify(out)} from ${JSON.stringify(input)}`,
        ).toBe(false);
      expect(out, `case ${i}`).not.toMatch(/[A-Za-z]:[\\/]|\\\\|[\w.-]+@[\w-]+\.\w|https?:\/\//);
      expect(out.length).toBeLessThanOrEqual(MAX_MESSAGE);
    }
  });
});
