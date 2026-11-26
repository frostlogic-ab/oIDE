import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { ArtifactMeta } from '@oide/protocol';
import type { ArtifactStore } from '@oide/store';
import { ARTIFACT_CSP } from './core.js';
import { previewUrlOf, reactPreviewPage, resolveArtifactRequest, REACT_RUNTIME_PATH } from './artifact-preview.js';

const root = mkdtempSync(join(tmpdir(), 'oide-preview-'));
const reactDir = join(root, 'react');
const htmlDir = join(root, 'html');
mkdirSync(reactDir, { recursive: true });
mkdirSync(join(htmlDir, '__oide'), { recursive: true });
const SOURCE = 'export default () => <p>Hi</p>;\n// </script><script>alert(1)</script> \u2028';
writeFileSync(join(reactDir, 'App.jsx'), SOURCE);
writeFileSync(join(reactDir, 'logo.svg'), '<svg></svg>');
writeFileSync(join(htmlDir, 'index.html'), '<p>x</p>');
writeFileSync(join(htmlDir, '__oide', 'react-runtime.js'), 'planted()');
const runtime = join(root, 'react-runtime.js');
writeFileSync(runtime, '/* runtime */');
afterAll(() => rmSync(root, { recursive: true, force: true }));

const meta = (id: string, entry: string): ArtifactMeta => ({ id, slug: id, title: id, kind: 'design', location: 'app-data', version: 1, entry, createdAt: 1, updatedAt: 1 });
const metas: Record<string, ArtifactMeta> = { r1: meta('r1', 'App.jsx'), h1: meta('h1', 'index.html') };
const dirs: Record<string, string> = { r1: reactDir, h1: htmlDir };
const store = {
  metaOf: (id: string) => {
    const m = metas[id];
    if (!m) throw new Error(`Unknown artifact ${id}`);
    return m;
  },
  dirOf: (id: string) => {
    const d = dirs[id];
    if (!d) throw new Error(`Unknown artifact ${id}`);
    return d;
  },
  read: async (id: string) => ({ meta: metas[id]!, content: SOURCE }),
} as unknown as ArtifactStore;

describe('React design preview page', () => {
  it('embeds the source as JSON that no source text can break out of', () => {
    const page = reactPreviewPage(SOURCE);
    const block = /<script type="application\/json" id="oide-src">([\s\S]*?)<\/script>/.exec(page)!;
    expect(block).not.toBeNull();
    expect(block[1]).not.toMatch(/[<\u2028]/);
    expect(JSON.parse(block[1]!)).toBe(SOURCE);
    // Exactly the two script tags main writes: the data block and the runtime.
    expect(page.match(/<script/g)).toHaveLength(2);
    expect(page).toContain(`<script src="/${REACT_RUNTIME_PATH}"></script>`);
  });
});

describe('resolveArtifactRequest', () => {
  it("answers a React design's index.html with the generated page", async () => {
    const hit = await resolveArtifactRequest(store, 'oide-artifact://r1/index.html', runtime);
    expect(hit && 'body' in hit && hit.body).toContain('id="oide-src"');
    expect(hit?.mime).toMatch(/text\/html/);
  });

  it('serves the runtime only at its exact path, only for an artifact that exists', async () => {
    const hit = await resolveArtifactRequest(store, `oide-artifact://r1/${REACT_RUNTIME_PATH}`, runtime);
    expect(hit && 'file' in hit && hit.file).toBe(runtime);
    expect(hit?.mime).toMatch(/javascript/);
    expect(await resolveArtifactRequest(store, `oide-artifact://nope/${REACT_RUNTIME_PATH}`, runtime)).toBeNull();
    expect(await resolveArtifactRequest(store, `oide-artifact://r1/${REACT_RUNTIME_PATH}`, undefined)).toBeNull();
  });

  it('refuses every other __oide path, whatever the case, even if the folder has one', async () => {
    for (const p of ['__oide/other.js', '__OIDE/react-runtime.js', '__oide%2F..%2Findex.html', '__oide%2Freact-runtime.js%00', '__oide./react-runtime.js', '__oide/react-runtime.js/x']) {
      expect(await resolveArtifactRequest(store, `oide-artifact://h1/${p}`, runtime), p).toBeNull();
    }
  });

  it('falls back to the folder checks for other files', async () => {
    expect(await resolveArtifactRequest(store, 'oide-artifact://h1/index.html', runtime)).toMatchObject({ mime: expect.stringMatching(/text\/html/) });
    expect(await resolveArtifactRequest(store, 'oide-artifact://r1/logo.svg', runtime)).toMatchObject({ mime: 'image/svg+xml' });
    expect(await resolveArtifactRequest(store, 'oide-artifact://r1/../html/index.html', runtime)).toBeNull();
    expect(await resolveArtifactRequest(store, 'oide-artifact://r1/artifact.json', runtime)).toBeNull();
    expect(await resolveArtifactRequest(store, 'https://r1/index.html', runtime)).toBeNull();
  });
});

describe('multi-file previews (ADR 0014)', () => {
  const siteDir = join(root, 'site');
  mkdirSync(join(siteDir, 'project', 'shots'), { recursive: true });
  mkdirSync(join(siteDir, '.versions', '1'), { recursive: true });
  writeFileSync(join(siteDir, 'project', 'Main page.html'), '<link rel="stylesheet" href="site.css"><img src="shots/a.png">');
  writeFileSync(join(siteDir, 'project', 'site.css'), 'a{}');
  writeFileSync(join(siteDir, 'project', 'shots', 'a.png'), 'png');
  writeFileSync(join(siteDir, '.versions', '1', 'old.html'), 'old');
  const pendingDir = join(root, 'pending');
  mkdirSync(pendingDir, { recursive: true });
  writeFileSync(join(pendingDir, 'index.html'), 'leftover');
  const tsxDir = join(root, 'tsx');
  mkdirSync(join(tsxDir, 'src'), { recursive: true });
  writeFileSync(join(tsxDir, 'src', 'Board.tsx'), SOURCE);
  const m: Record<string, ArtifactMeta> = {
    s1: { ...meta('s1', 'project/Main page.html'), fileCount: 3 },
    p0: { ...meta('p0', 'index.html'), version: 0, fileCount: 0 },
    t1: meta('t1', 'src/Board.tsx'),
  };
  const d: Record<string, string> = { s1: siteDir, p0: pendingDir, t1: tsxDir };
  const multi = {
    metaOf: (id: string) => m[id] ?? (() => { throw new Error('Unknown artifact'); })(),
    dirOf: (id: string) => d[id] ?? (() => { throw new Error('Unknown artifact'); })(),
    read: async (id: string) => ({ meta: m[id]!, content: SOURCE }),
  } as unknown as ArtifactStore;

  it('previewUrlOf encodes each segment of the entry; a React entry opens on the generated page', () => {
    expect(previewUrlOf(m.s1!)).toBe('oide-artifact://s1/project/Main%20page.html');
    expect(previewUrlOf(meta('r1', 'App.jsx'))).toBe('oide-artifact://r1/index.html');
    expect(previewUrlOf(m.t1!)).toBe('oide-artifact://t1/index.html');
  });

  it('serves any file of the current version, so relative links work', async () => {
    expect(await resolveArtifactRequest(multi, 'oide-artifact://s1/project/Main%20page.html', runtime)).toMatchObject({ mime: expect.stringMatching(/text\/html/) });
    expect(await resolveArtifactRequest(multi, 'oide-artifact://s1/project/site.css', runtime)).toMatchObject({ mime: expect.stringMatching(/text\/css/) });
    expect(await resolveArtifactRequest(multi, 'oide-artifact://s1/project/shots/a.png', runtime)).toMatchObject({ mime: 'image/png' });
  });

  it('never serves .versions, artifact.json, .staging or a version-0 artifact', async () => {
    for (const p of ['.versions/1/old.html', '.VERSIONS/1/old.html', 'VERSIO~1/1/old.html', 'artifact.json', '.staging/x', 'project/../.versions/1/old.html']) {
      expect(await resolveArtifactRequest(multi, `oide-artifact://s1/${p}`, runtime), p).toBeNull();
    }
    expect(await resolveArtifactRequest(multi, 'oide-artifact://p0/index.html', runtime)).toBeNull();
  });

  it('a .tsx entry gets the generated React page at index.html', async () => {
    const hit = await resolveArtifactRequest(multi, 'oide-artifact://t1/index.html', runtime);
    expect(hit && 'body' in hit && hit.body).toContain('id="oide-src"');
  });
});

describe('ARTIFACT_CSP (ADR 0015)', () => {
  const directives = new Map(
    ARTIFACT_CSP.split(';').map((d) => {
      const [name, ...values] = d.trim().split(/\s+/);
      return [name, values] as const;
    }),
  );
  it("lets a design's own runtime evaluate code (claude.ai .dc.html exports use new Function)", () => {
    expect(directives.get('script-src')).toEqual(expect.arrayContaining(["'unsafe-inline'", "'unsafe-eval'", "'self'"]));
    expect(directives.get('script-src')).not.toContain('oide-artifact:');
  });
  it('still blocks every network path', () => {
    for (const d of ['default-src', 'connect-src', 'frame-src', 'worker-src', 'form-action', 'base-uri']) {
      expect(directives.get(d)).toEqual(["'none'"]);
    }
  });
});
