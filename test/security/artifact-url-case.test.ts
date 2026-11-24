import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { ArtifactStore } from '../../packages/store/src/index.js';
import { resolveArtifactUrl } from '../../apps/desktop/src/main/services/core.js';

/**
 * SEC-17 (low). resolveArtifactUrl refuses `artifact.json` and `.versions/` with case-sensitive
 * string checks; on Windows/macOS `ARTIFACT.JSON` and `.VERSIONS/` reach the same files.
 * Secure behaviour: compare case-insensitively (or allow-list what may be served).
 */
const dir = mkdtempSync(join(tmpdir(), 'oide-sec-art-'));
mkdirSync(join(dir, '.versions', '1'), { recursive: true });
writeFileSync(join(dir, 'artifact.json'), '{"id":"a1"}');
writeFileSync(join(dir, 'index.html'), '<p>x</p>');
writeFileSync(join(dir, '.versions', '1', 'index.html'), '<p>old</p>');
const store = { dirOf: () => dir } as unknown as ArtifactStore;
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe.skipIf(process.platform === 'linux')('SEC-17 artifact scheme case checks', () => {
  it('serves the entry file', () => {
    expect(resolveArtifactUrl(store, 'oide-artifact://a1/index.html')).not.toBeNull();
  });
  it('refuses ARTIFACT.JSON and .VERSIONS in any case', () => {
    expect(resolveArtifactUrl(store, 'oide-artifact://a1/ARTIFACT.JSON')).toBeNull();
    expect(resolveArtifactUrl(store, 'oide-artifact://a1/.VERSIONS/1/index.html')).toBeNull();
  });
});
