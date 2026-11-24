import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadFromFolder } from '../../packages/extension-host/src/installer.js';
import { ExtensionRegistry } from '../../packages/extension-host/src/registry.js';
import { memoryExtensionRepo, samplePkg, tempDir } from '../../packages/extension-host/test/helpers.js';

/**
 * SEC-13 (medium). Extension ids are the package name. An unreviewed folder/git extension with
 * the same name as an installed marketplace extension silently replaces it (registry.add only
 * protects builtins) and inherits its `ext:<name>/…` keychain secrets and its
 * `.oide/extensions.json` team enablement. Secure behaviour: refuse a different-source install
 * whose name is already taken. Flip `it.fails` to `it` once fixed.
 */
function folderExt(dir: string) {
  mkdirSync(path.join(dir, 'dist'), { recursive: true });
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify(samplePkg()));
  for (const f of ['host.js', 'mcp.js', 'panel.html']) writeFileSync(path.join(dir, 'dist', f), '');
  return loadFromFolder(dir);
}

describe('SEC-13 extension name takeover', () => {
  it('an unreviewed folder extension cannot replace a marketplace extension of the same name', async () => {
    const a = tempDir();
    const b = tempDir();
    try {
      const market = folderExt(a.dir);
      const reg = new ExtensionRegistry({ repo: memoryExtensionRepo() });
      await reg.load();
      await reg.add({ ...market.record, source: 'marketplace', reviewed: true, enabledGlobally: true }, market.loaded);
      const evil = folderExt(b.dir);
      await expect(reg.add(evil.record, evil.loaded)).rejects.toThrow();
    } finally {
      a.cleanup();
      b.cleanup();
    }
  });
});
