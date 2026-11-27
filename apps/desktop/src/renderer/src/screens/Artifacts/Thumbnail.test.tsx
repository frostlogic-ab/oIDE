// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import { ArtifactMeta, type OideBridge } from '@oide/protocol';
import { installFallbackBridge } from '../../lib/bridge';
import { ArtifactThumbnail, hasThumbnail } from './Thumbnail';

const now = Date.now();
const meta = (id: string, kind: ArtifactMeta['kind'], extra: Partial<ArtifactMeta> = {}) =>
  ArtifactMeta.parse({ id, slug: id, title: `T ${id}`, kind, location: 'app-data', version: 1, entry: 'x', createdAt: now, updatedAt: now, ...extra });

let previewUrl: string | null = 'oide-artifact://d1/Main.dc.html';
const invoke = vi.fn(async (command: string, input: unknown): Promise<unknown> => {
  const { id } = input as { id: string };
  if (command === 'artifacts.previewUrl') {
    if (!previewUrl) throw new Error('[not_implemented] artifacts.previewUrl');
    return { url: previewUrl };
  }
  if (command === 'artifacts.get') return { content: id === 'w1' ? '{"elements":[{"type":"rectangle","x":0,"y":0,"width":10,"height":10}]}' : '# Retry policy\n\nBack off with jitter.' };
  throw new Error(`[not_implemented] ${command}`);
});

beforeEach(() => {
  previewUrl = 'oide-artifact://d1/Main.dc.html';
  invoke.mockClear();
  installFallbackBridge({ invoke: invoke as unknown as OideBridge['invoke'], on: (() => () => {}) as OideBridge['on'], platform: 'win32' });
});
afterEach(cleanup);

const placeholder = <span data-testid="placeholder" />;

describe('ArtifactThumbnail', () => {
  it('shows the real design in a scaled, sandboxed frame kept out of the tab order', async () => {
    const { container, queryByTestId } = render(<ArtifactThumbnail meta={meta('d1', 'design')} placeholder={placeholder} className="h-[120px]" />);
    await waitFor(() => expect(container.querySelector('iframe')?.getAttribute('src')).toBe('oide-artifact://d1/Main.dc.html'));
    const frame = container.querySelector('iframe')!;
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame.getAttribute('tabindex')).toBe('-1');
    expect(container.firstElementChild?.getAttribute('aria-hidden')).toBe('true');
    expect(queryByTestId('placeholder')).toBeNull();
  });

  it('keeps the placeholder when main serves no preview URL (never an srcdoc frame)', async () => {
    previewUrl = null;
    const { container, findByTestId } = render(<ArtifactThumbnail meta={meta('d1', 'design')} placeholder={placeholder} />);
    expect(await findByTestId('placeholder')).toBeTruthy();
    expect(container.querySelector('iframe')).toBeNull();
  });

  it('renders a doc and a whiteboard from their content', async () => {
    const doc = render(<ArtifactThumbnail meta={meta('m1', 'doc')} placeholder={placeholder} />);
    await waitFor(() => expect(doc.container.querySelector('h1')?.textContent).toBe('Retry policy'));
    const board = render(<ArtifactThumbnail meta={meta('w1', 'whiteboard')} placeholder={placeholder} />);
    await waitFor(() => expect(board.container.querySelector('svg rect')).toBeTruthy());
  });

  it('shows the placeholder for an artifact with nothing to show yet', () => {
    for (const m of [meta('a', 'design', { version: 0 }), meta('b', 'design', { brokenImport: true }), meta('c', 'doc', { retrieval: { status: 'retrieving', trigger: 'import', startedAt: now } })]) {
      expect(hasThumbnail(m)).toBe(false);
    }
    const { getByTestId } = render(<ArtifactThumbnail meta={meta('a', 'design', { version: 0 })} placeholder={placeholder} />);
    expect(getByTestId('placeholder')).toBeTruthy();
    expect(invoke).not.toHaveBeenCalled();
  });
});
