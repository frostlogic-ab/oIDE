import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkBuiltFonts, collectFonts, FONT_ASSETS, licenseHints, woff2Names } from '../fonts.mjs';

/** The Excalidraw package folder, resolved the way the build does (apps/desktop/excalidraw-assets.ts). */
const excalidrawDir = join(dirname(createRequire(new URL('../../../apps/desktop/package.json', import.meta.url)).resolve('@excalidraw/excalidraw')), '..', '..');
const resolvePackage = (name: string) => (name === '@excalidraw/excalidraw' ? excalidrawDir : null);
const allowAll = () => true;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'oide-fonts-'));
  dirs.push(d);
  return d;
};

describe('font licence records (tools/licenses/fonts.mjs)', () => {
  it('reads the name table of a shipped WOFF2 font and finds its licence', () => {
    const names = woff2Names(readFileSync(join(excalidrawDir, 'dist/prod/fonts/Virgil/Virgil-Regular.woff2')));
    expect(names[1]).toBe('Virgil');
    expect(names[0]).toMatch(/Your Own Font Foundry/);
    expect([...licenseHints(names)]).toEqual(['OFL-1.1']);
    expect(() => woff2Names(Buffer.from('not a font'))).toThrow(/WOFF2/);
  });

  it('records every Excalidraw font family with a licence that matches the shipped files', () => {
    const excalidraw = FONT_ASSETS.filter((a) => a.from.pkg === '@excalidraw/excalidraw');
    const { records, problems } = collectFonts({ resolvePackage, isAllowed: allowAll, assets: excalidraw });
    expect(problems).toEqual([]);
    expect(records.map((r) => r.from.dir.split('/').pop()).sort()).toEqual(['Assistant', 'Cascadia', 'ComicShanns', 'Excalifont', 'Liberation', 'Lilita', 'Nunito', 'Virgil', 'Xiaolai']);
    expect(records.find((r) => r.name === 'Comic Shanns')?.text).toMatch(/^MIT License/);
  });

  it('fails a font family that has no record, a wrong licence and a non-MIT licence without a reason', () => {
    const excalidraw = FONT_ASSETS.filter((a) => a.from.pkg === '@excalidraw/excalidraw');
    const missing = collectFonts({ resolvePackage, isAllowed: allowAll, assets: excalidraw.filter((a) => a.name !== 'Nunito') });
    expect(missing.problems).toEqual(['@excalidraw/excalidraw ships the font folder Nunito/ but it has no licence record in tools/licenses/fonts.mjs']);
    const wrong = collectFonts({ resolvePackage, isAllowed: allowAll, assets: excalidraw.map((a) => (a.name === 'Virgil' ? { ...a, license: 'MIT' } : a)) });
    expect(wrong.problems.join('\n')).toMatch(/Virgil: .*Virgil-Regular\.woff2 says OFL-1\.1, the record says MIT/);
    const strict = (spdx: string) => spdx === 'OFL-1.1' || spdx === 'MIT';
    const noReason = collectFonts({ resolvePackage, isAllowed: strict, assets: excalidraw.map((a) => (a.name === 'Liberation Sans' ? { ...a, exception: undefined } : a)) });
    expect(noReason.problems.join('\n')).toMatch(/Liberation Sans: licence GPL-2\.0-only WITH Font-exception-2\.0 is not MIT-compatible/);
    expect(collectFonts({ resolvePackage, isAllowed: strict, assets: excalidraw }).problems).toEqual([]);
  });

  it('after a build, fails any font file in out/renderer that matches no record', () => {
    const out = tmp();
    mkdirSync(join(out, 'assets'), { recursive: true });
    mkdirSync(join(out, 'excalidraw-assets', 'fonts', 'Virgil'), { recursive: true });
    writeFileSync(join(out, 'assets', 'inter-latin-400-normal-C38fXH4l.woff2'), '');
    writeFileSync(join(out, 'assets', 'codicon-MIjLT6Vj.ttf'), '');
    writeFileSync(join(out, 'excalidraw-assets', 'fonts', 'Virgil', 'Virgil-Regular.woff2'), '');
    expect(checkBuiltFonts(out)).toEqual({ checked: 3, problems: [] });
    writeFileSync(join(out, 'assets', 'KaTeX_Main-Regular-AbCdEfGh.woff2'), '');
    mkdirSync(join(out, 'excalidraw-assets', 'fonts', 'Emoji'), { recursive: true });
    writeFileSync(join(out, 'excalidraw-assets', 'fonts', 'Emoji', 'Emoji.woff2'), '');
    expect(checkBuiltFonts(out).problems).toEqual([
      'out/renderer/assets/KaTeX_Main-Regular-AbCdEfGh.woff2: shipped font with no recorded licence (add it to tools/licenses/fonts.mjs)',
      'out/renderer/excalidraw-assets/fonts/Emoji/Emoji.woff2: shipped font with no recorded licence (add it to tools/licenses/fonts.mjs)',
    ]);
    expect(checkBuiltFonts(join(out, 'nope'))).toEqual({ checked: 0, problems: [] });
  });
});
