import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadManifest, ManifestError, parseManifest } from '../src/manifest.js';
import { compareVersions, satisfies } from '../src/semver.js';
import { samplePkg, tempDir } from './helpers.js';

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

function pkgDir(pkg: Record<string, unknown>, files: Record<string, string> = { 'dist/host.js': '', 'dist/mcp.js': '', 'dist/panel.html': '' }): string {
  const t = tempDir();
  cleanups.push(t.cleanup);
  writeFileSync(path.join(t.dir, 'package.json'), JSON.stringify(pkg));
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(t.dir, p)), { recursive: true });
    writeFileSync(path.join(t.dir, p), body);
  }
  return t.dir;
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return e instanceof ManifestError ? e.code : 'other';
  }
  return undefined;
}

describe('loadManifest', () => {
  it('loads a valid manifest and resolves paths inside the package', () => {
    const dir = pkgDir(samplePkg());
    const l = loadManifest(dir);
    expect(l.main).toBe(path.join(dir, 'dist', 'host.js'));
    expect(l.panels[0]?.entry).toBe(path.join(dir, 'dist', 'panel.html'));
    expect(l.mcpServers['sample']?.args).toEqual([path.join(dir, 'dist', 'mcp.js')]);
    expect(l.mcpServers['sample']?.command).toBe('node');
    expect(l.activation).toEqual(['onAgentSpawn', 'onCommand:sample.hello']);
    expect(l.tools.map((t) => `${t.tool}:${t.risk}`)).toEqual(['db.schema:read', 'db.write:ask']);
  });

  it('rejects a main that escapes the package', () => {
    expect(codeOf(() => loadManifest(pkgDir(samplePkg({}, { main: '../outside.js' }))))).toBe('path-escape');
    expect(codeOf(() => loadManifest(pkgDir(samplePkg({}, { main: 'dist/../../outside.js' }))))).toBe('path-escape');
  });

  it('rejects absolute paths', () => {
    expect(codeOf(() => loadManifest(pkgDir(samplePkg({}, { main: '/etc/passwd' }))))).toBe('path-escape');
    expect(codeOf(() => loadManifest(pkgDir(samplePkg({}, { main: 'C:\\Windows\\x.js' }))))).toBe('path-escape');
  });

  it('rejects MCP server scripts and panel entries outside the package', () => {
    const mcp = samplePkg({}, { mcpServers: { s: { command: 'node', args: ['../../evil.js'], tools: {} } } });
    expect(codeOf(() => loadManifest(pkgDir(mcp)))).toBe('path-escape');
    const panel = samplePkg({}, { contributes: { panels: [{ id: 'p', title: 'P', entry: '../x.html' }] } });
    expect(codeOf(() => loadManifest(pkgDir(panel)))).toBe('path-escape');
    const cmd = samplePkg({}, { mcpServers: { s: { command: '../bin/run', args: [], tools: {} } } });
    expect(codeOf(() => loadManifest(pkgDir(cmd)))).toBe('path-escape');
  });

  it('rejects a symlink that points outside', () => {
    const outside = tempDir();
    cleanups.push(outside.cleanup);
    writeFileSync(path.join(outside.dir, 'evil.js'), '');
    const dir = pkgDir(samplePkg({}, { main: 'dist/link.js' }), { 'dist/mcp.js': '', 'dist/panel.html': '' });
    try {
      symlinkSync(path.join(outside.dir, 'evil.js'), path.join(dir, 'dist', 'link.js'), 'file');
    } catch {
      return; // symlinks need extra rights on some Windows setups
    }
    expect(codeOf(() => loadManifest(dir))).toBe('path-escape');
  });

  it('requires referenced files to exist', () => {
    expect(codeOf(() => loadManifest(pkgDir(samplePkg(), { 'dist/mcp.js': '', 'dist/panel.html': '' })))).toBe('missing-file');
  });

  it('checks the engine range', () => {
    expect(codeOf(() => parseManifest(samplePkg({}, { engine: '^2.0.0' })))).toBe('engine');
    expect(codeOf(() => parseManifest(samplePkg({}, { engine: '>=0.9.0 <2' })))).toBeUndefined();
  });

  it('rejects schema problems, bad server names and unknown activation events', () => {
    expect(codeOf(() => parseManifest({ name: 'x', version: '1.0.0' }))).toBe('schema');
    expect(codeOf(() => parseManifest(samplePkg({ name: 'Bad Name' })))).toBe('schema');
    expect(codeOf(() => parseManifest(samplePkg({}, { mcpServers: { 'a b': { command: 'node', tools: {} } } })))).toBe('invalid');
    expect(codeOf(() => parseManifest(samplePkg({}, { activation: ['onBoot'] })))).toBe('invalid');
    expect(codeOf(() => parseManifest(samplePkg({ version: 'one' })))).toBe('invalid');
  });

  it('reports a missing package.json', () => {
    const t = tempDir();
    cleanups.push(t.cleanup);
    expect(codeOf(() => loadManifest(t.dir))).toBe('not-found');
  });
});

describe('semver', () => {
  it('handles the common ranges', () => {
    expect(satisfies('1.0.0', '^1.0.0')).toBe(true);
    expect(satisfies('1.9.3', '^1.0.0')).toBe(true);
    expect(satisfies('2.0.0', '^1.0.0')).toBe(false);
    expect(satisfies('0.2.5', '^0.2.1')).toBe(true);
    expect(satisfies('0.3.0', '^0.2.1')).toBe(false);
    expect(satisfies('1.2.9', '~1.2.3')).toBe(true);
    expect(satisfies('1.3.0', '~1.2.3')).toBe(false);
    expect(satisfies('1.5.0', '>=1.2.0 <2.0.0')).toBe(true);
    expect(satisfies('1.5.0', '1.x')).toBe(true);
    expect(satisfies('3.0.0', '1.x || >=3')).toBe(true);
    expect(satisfies('1.0.0', '*')).toBe(true);
    expect(satisfies('1.2.3', '1.0.0 - 1.2.3')).toBe(true);
    expect(satisfies('2.0.0-beta.1', '^1.0.0')).toBe(false);
    expect(satisfies('2.0.0-beta.2', '>=2.0.0-beta.1')).toBe(true);
    expect(compareVersions('1.10.0', '1.9.0')).toBe(1);
    expect(compareVersions('1.0.0-alpha', '1.0.0')).toBe(-1);
  });
});
