import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { ArtifactMeta } from '@oide/protocol';
import type { ArtifactStore } from '@oide/store';
import { reactPreviewPage, resolveArtifactRequest, REACT_RUNTIME_PATH } from './artifact-preview.js';

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
