// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import type { OideBridge } from '@oide/protocol';
import { installFallbackBridge } from '../lib/bridge';
import { buildErrorReport, reduceFrames, sanitizeMessage } from '../lib/errorReport';
import { ScreenErrorBoundary } from './ErrorBoundary';

const invoke = vi.fn(async (..._args: unknown[]) => ({ ok: true }));
installFallbackBridge({ invoke, on: () => () => {}, platform: 'win32' } as unknown as OideBridge);
afterEach(() => {
  cleanup();
  invoke.mockClear();
});

let explode = true;
function Bomb() {
  if (explode) throw new Error('Cannot read "the secret prompt text here" at C:\\Users\\me\\proj\\src\\a.ts token sk-ant-api03-zzzzzzzzzzzz');
  return <p>screen ok</p>;
}

describe('ScreenErrorBoundary', () => {
  it('shows a recover panel, reports a sanitized error to main, and Try again re-mounts', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    explode = true;
    render(
      <div>
        <nav>rail still here</nav>
        <ScreenErrorBoundary screen="focus">
          <Bomb />
        </ScreenErrorBoundary>
      </div>,
    );
    expect(screen.getByRole('alert').textContent).toContain('This screen ran into a problem');
    expect(screen.getByText('rail still here')).toBeTruthy();
    const [command, input] = invoke.mock.calls.find((c) => c[0] === 'app.reportError')! as [string, { screen: string; message: string }];
    expect(command).toBe('app.reportError');
    expect(input.screen).toBe('focus');
    expect(input.message).not.toMatch(/secret prompt|Users|sk-ant/);
    explode = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(screen.getByText('screen ok')).toBeTruthy();
  });

  it('clears when the screen changes', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    explode = true;
    function Host() {
      const [s, setS] = useState('files');
      return (
        <>
          <button type="button" onClick={() => ((explode = false), setS('wall'))}>
            go
          </button>
          <ScreenErrorBoundary screen={s}>
            <Bomb />
          </ScreenErrorBoundary>
        </>
      );
    }
    render(<Host />);
    expect(screen.getByTestId('screen-error')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'go' }));
    expect(screen.getByText('screen ok')).toBeTruthy();
  });
});

describe('error report', () => {
  it('holds no paths, prompts, code or tokens', () => {
    const e = new Error('Unexpected token in `const apiKey = "abc"` from /home/zoë/work/app.ts');
    e.stack = 'Error: x\n    at Transcript (file:///C:/Users/zoe/oIDE/out/renderer/assets/index-abc123.js:10:20)\n    at http://localhost:5173/src/screens/Focus/index.tsx?t=123:4:5';
    const r = buildErrorReport({ screen: 'focus', error: e, componentStack: '\n    at Transcript (file:///C:/x/index.js:1:1)\n    at FocusScreen (file:///C:/x/index.js:2:2)', now: new Date(0) });
    expect(r.text).not.toMatch(/zoë|zoe|Users|apiKey|localhost|home/);
    expect(r.stack).toEqual(['at Transcript (index-abc123.js:10:20)', 'at <anonymous> (index.tsx:4:5)']);
    expect(r.componentStack).toEqual(['at Transcript (index.js:1:1)', 'at FocusScreen (index.js:2:2)']);
  });

  it('helpers', () => {
    expect(sanitizeMessage('Bearer abcdefgh123 ghp_abcdefghijklmnopqrstu')).toBe('[redacted] [redacted]');
    expect(reduceFrames('fn@file:///a/b/c.js:1:2')).toEqual(['at fn (c.js:1:2)']);
  });
});
