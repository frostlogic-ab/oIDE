import { describe, expect, it } from 'vitest';
import { permissionAllowed } from './permissions.js';

const isApp = (url: string) => url.startsWith('file:///app/') || url.startsWith('http://localhost:5173/');

describe('permissionAllowed', () => {
  it('allows clipboard writes from any frame', () => {
    expect(permissionAllowed('clipboard-sanitized-write', { requestingUrl: 'oide-artifact://x/', isMainFrame: false }, isApp)).toBe(true);
  });

  it('allows clipboard reads only for the app page itself (the editor Paste)', () => {
    expect(permissionAllowed('clipboard-read', { requestingUrl: 'file:///app/index.html', isMainFrame: true }, isApp)).toBe(true);
    expect(permissionAllowed('clipboard-read', { requestingUrl: 'http://localhost:5173/', isMainFrame: true }, isApp)).toBe(true);
    // artifact previews and extension panels are iframes; other pages are not the app
    expect(permissionAllowed('clipboard-read', { requestingUrl: 'file:///app/index.html', isMainFrame: false }, isApp)).toBe(false);
    expect(permissionAllowed('clipboard-read', { requestingUrl: 'oide-artifact://a1/index.html', isMainFrame: true }, isApp)).toBe(false);
    expect(permissionAllowed('clipboard-read', { isMainFrame: true }, isApp)).toBe(false);
    expect(permissionAllowed('clipboard-read', undefined, isApp)).toBe(false);
  });

  it('denies everything else', () => {
    for (const p of ['media', 'geolocation', 'notifications', 'openExternal', 'fullscreen'])
      expect(permissionAllowed(p, { requestingUrl: 'file:///app/index.html', isMainFrame: true }, isApp)).toBe(false);
  });
});
