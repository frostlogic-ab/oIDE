import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import type { InstalledExtension } from '@oide/protocol';
import type { CustomServerRepository, ExtensionRepository, SecretStore } from '../src/interfaces.js';

export function tempDir(prefix = 'oide-ext-'): { dir: string; cleanup(): void } {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export interface RawTarEntry {
  path: string;
  /** '0' file, '1' hard link, '2' symlink, '5' directory, '3' char device */
  type?: '0' | '1' | '2' | '3' | '5';
  body?: string | Buffer;
  linkpath?: string;
}

function octal(n: number, len: number): string {
  return n.toString(8).padStart(len - 1, '0') + '\0';
}

/** Hand-built ustar archive, so tests can write entries `tar.c` would refuse to create. */
export function makeTar(entries: RawTarEntry[], gzip = true): Buffer {
  const blocks: Buffer[] = [];
  for (const e of entries) {
    const body = e.body === undefined ? Buffer.alloc(0) : Buffer.isBuffer(e.body) ? e.body : Buffer.from(e.body);
    const type = e.type ?? '0';
    const h = Buffer.alloc(512, 0);
    h.write(e.path.slice(0, 100), 0, 'utf8');
    h.write(octal(type === '5' ? 0o755 : 0o644, 8), 100, 'ascii');
    h.write(octal(0, 8), 108, 'ascii');
    h.write(octal(0, 8), 116, 'ascii');
    h.write(octal(type === '0' ? body.length : 0, 12), 124, 'ascii');
    h.write(octal(1_700_000_000, 12), 136, 'ascii');
    h.write('        ', 148, 'ascii');
    h.write(type, 156, 'ascii');
    if (e.linkpath) h.write(e.linkpath.slice(0, 100), 157, 'utf8');
    h.write('ustar\0', 257, 'ascii');
    h.write('00', 263, 'ascii');
    let sum = 0;
    for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
    blocks.push(h);
    if (type === '0' && body.length) {
      blocks.push(body);
      const pad = (512 - (body.length % 512)) % 512;
      if (pad) blocks.push(Buffer.alloc(pad, 0));
    }
  }
  blocks.push(Buffer.alloc(1024, 0));
  const tar = Buffer.concat(blocks);
  return gzip ? gzipSync(tar) : tar;
}

/** An npm-style tarball (`package/…`) of a small valid extension. */
export function extensionTarball(pkg: Record<string, unknown>, files: Record<string, string> = {}): Buffer {
  const entries: RawTarEntry[] = [{ path: 'package/package.json', body: JSON.stringify(pkg, null, 2) }];
  for (const [p, body] of Object.entries(files)) entries.push({ path: `package/${p}`, body });
  return makeTar(entries);
}

export function memoryExtensionRepo(initial: InstalledExtension[] = []): ExtensionRepository & { items: Map<string, InstalledExtension> } {
  const items = new Map(initial.map((e) => [e.id, e]));
  return {
    items,
    list: () => [...items.values()],
    upsert: (e) => {
      items.set(e.id, e);
    },
    remove: (id) => {
      items.delete(id);
    },
  };
}

export function memoryCustomRepo(): CustomServerRepository & { items: Map<string, import('@oide/protocol').CustomServer> } {
  const items = new Map<string, import('@oide/protocol').CustomServer>();
  return {
    items,
    list: () => [...items.values()],
    upsert: (s) => {
      items.set(s.id, s);
    },
    remove: (id) => {
      items.delete(id);
    },
  };
}

export function memorySecrets(): SecretStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    get: (k) => data.get(k),
    set: (k, v) => {
      data.set(k, v);
    },
    delete: (k) => {
      data.delete(k);
    },
  };
}

export const samplePkg = (over: Record<string, unknown> = {}, oide: Record<string, unknown> = {}) => ({
  name: '@oide-community/sample',
  version: '1.2.0',
  type: 'module',
  oide: {
    engine: '^1.0.0',
    displayName: 'Sample',
    categories: ['agent-tools'],
    activation: ['onAgentSpawn'],
    main: 'dist/host.js',
    mcpServers: {
      sample: { command: 'node', args: ['dist/mcp.js'], tools: { 'db.schema': { risk: 'read' }, 'db.write': { risk: 'ask' } } },
    },
    contributes: { panels: [{ id: 'sample.panel', title: 'Panel', entry: 'dist/panel.html' }], commands: [{ id: 'sample.hello', title: 'Hello' }] },
    ...oide,
  },
  ...over,
});
