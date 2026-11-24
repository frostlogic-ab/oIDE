import { afterEach, describe, expect, it } from 'vitest';
import type { MainContext } from '../context.js';
import { confirmNative, dialogOrigin, safeDialogText, setConfirmOverride, type ConfirmOptions } from './confirm.js';

afterEach(() => setConfirmOverride(null));

describe('safeDialogText (SEC-31)', () => {
  it('shows newlines, CR, tab and other controls as visible escapes', () => {
    expect(safeDialogText('a\nb\r\nc\td')).toBe('a\\nb\\r\\nc\\td');
    expect(safeDialogText('x\u0000y\u001bz\u007f\u0085')).toBe('x\\u{0}y\\u{1b}z\\u{7f}\\u{85}');
  });

  it('escapes Unicode line separators, bidi controls and zero-width characters', () => {
    expect(safeDialogText('a\u2028b\u2029c')).toBe('a\\u{2028}b\\u{2029}c');
    expect(safeDialogText('evil\u202eexe.txt')).toBe('evil\\u{202e}exe.txt');
    expect(safeDialogText('\u2066x\u2069\u200by\ufeff\u061c')).toBe('\\u{2066}x\\u{2069}\\u{200b}y\\u{feff}\\u{61c}');
  });

  it('keeps ordinary text, including non-ASCII letters, unchanged and shows non-strings as JSON', () => {
    expect(safeDialogText('C:\\Program Files\\claude.exe --flag "é ü 日本"')).toBe('C:\\Program Files\\claude.exe --flag "é ü 日本"');
    expect(safeDialogText(undefined)).toBe('');
    expect(safeDialogText({ a: 1 })).toBe('{"a":1}');
    expect(safeDialogText(42)).toBe('42');
  });

  it('truncates only when asked, from the middle, keeping both ends', () => {
    const long = `start-${'x'.repeat(200)}-end`;
    expect(safeDialogText(long)).toBe(long);
    const t = safeDialogText(long, { max: 21 });
    expect(t).toHaveLength(21);
    expect(t.startsWith('start-')).toBe(true);
    expect(t.endsWith('-end')).toBe(true);
    expect(t).toContain('…');
    expect(safeDialogText('short', { max: 21 })).toBe('short');
  });

  it('escapes before truncating, so a truncated value cannot reintroduce a raw newline', () => {
    expect(safeDialogText(`${'a'.repeat(50)}\n${'b'.repeat(50)}`, { max: 20 })).not.toMatch(/\n/);
  });

  it('dialogOrigin shows the origin in full, or nothing for an unparseable or opaque URL', () => {
    expect(dialogOrigin('https://llm.example.com:8443/a/very/long/path?q=1')).toBe('https://llm.example.com:8443');
    expect(dialogOrigin('not a url')).toBeUndefined();
    expect(dialogOrigin('data:text/plain,hi')).toBeUndefined();
  });

  it('confirmNative sanitizes every field, line by line, whatever the caller passed', async () => {
    let seen: ConfirmOptions | undefined;
    setConfirmOverride((o) => {
      seen = o;
      return true;
    });
    await confirmNative({} as MainContext, { title: 'T\nfake', message: 'M\u202e', detail: 'line 1\nline\r2\u2028x', confirmLabel: 'OK\t' });
    expect(seen).toEqual({ title: 'T\\nfake', message: 'M\\u{202e}', detail: 'line 1\nline\\r2\\u{2028}x', confirmLabel: 'OK\\t' });
  });
});
