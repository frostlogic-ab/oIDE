// Fonts and other non-code assets that ship in the renderer bundle, for tools/licenses/notices.mjs.
//
// npm packages are noticed by package; fonts need more: Excalidraw copies its whole font folder into
// out/renderer/excalidraw-assets/fonts/ (apps/desktop/excalidraw-assets.ts), Vite emits the fonts
// referenced by bundled CSS into out/renderer/assets/, and the published Excalidraw package has no
// LICENSE file at all. Every shipped font is recorded below with its licence and copyright, checked
// against the name table of the files themselves where they carry one, and `licenses:check` fails when:
//   - a font family folder in the Excalidraw package has no record (or a record has no folder),
//   - a shipped font's embedded licence disagrees with the recorded one,
//   - a recorded licence is not MIT-compatible and the record gives no reason it may ship,
//   - after a build (apps/desktop/out/renderer exists), any font file in it matches no record.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliDecompressSync } from 'node:zlib';

const HERE = dirname(fileURLToPath(import.meta.url));
export const FONT_FILE = /\.(?:woff2?|ttf|otf|eot)$/i;

/** Licence texts kept in tools/licenses/texts/ (the packages that ship the fonts do not include them). */
export const LICENSE_TEXTS = {
  'OFL-1.1': 'OFL-1.1.txt',
  'GPL-2.0-only WITH Font-exception-2.0': ['Liberation-1.x.txt', 'GPL-2.0.txt'],
};
export const readLicenseText = (file) => readFileSync(join(HERE, 'texts', file), 'utf8').replace(/\r\n/g, '\n').trimEnd();

/** Upstream licence texts for shipped packages whose npm tarball has none. */
export const UPSTREAM_PACKAGE_TEXTS = {
  '@excalidraw/excalidraw': { file: 'excalidraw-MIT.txt', from: 'https://github.com/excalidraw/excalidraw/blob/master/LICENSE' },
};

const EXCALIDRAW_FONTS = 'https://github.com/excalidraw/excalidraw/tree/master/packages/excalidraw/fonts';
/** Vite's content hash suffix on emitted assets (`name-<8 chars>.ext`). */
const HASH = String.raw`-[A-Za-z0-9_-]{8}`;

/**
 * Every font that ships. `from`: the package and folder it is copied from. `out`: how its files are
 * named in apps/desktop/out/renderer (relative, `/` separators). `copyright`: lines from the upstream
 * licence; the shipped files' own copyright strings are added when the notices are rendered.
 */
export const FONT_ASSETS = [
  {
    name: 'Assistant',
    from: { pkg: '@excalidraw/excalidraw', dir: 'dist/prod/fonts/Assistant' },
    out: [/^excalidraw-assets\/fonts\/Assistant\//, new RegExp(String.raw`^assets\/Assistant-[A-Za-z]+${HASH}\.woff2$`)],
    license: 'OFL-1.1',
    copyright: ["Copyright 2010 The Assistant Project Authors, with Reserved Font Name 'Source'. Source is a trademark of Adobe Systems Incorporated in the United States and/or other countries."],
    upstream: 'https://github.com/hafontia/Assistant',
    verified: 'name table of the shipped files (OFL 1.1) and the upstream OFL.txt',
    shippedAs: 'Excalidraw UI font (copied with the Excalidraw fonts, and emitted by Vite from its CSS)',
  },
  {
    name: 'Cascadia Code',
    from: { pkg: '@excalidraw/excalidraw', dir: 'dist/prod/fonts/Cascadia' },
    out: [/^excalidraw-assets\/fonts\/Cascadia\//],
    license: 'OFL-1.1',
    copyright: ['Copyright (c) 2019 - Present, Microsoft Corporation, with Reserved Font Name Cascadia Code.'],
    upstream: 'https://github.com/microsoft/cascadia-code',
    verified: 'licence URL in the shipped file (scripts.sil.org/OFL) and the upstream LICENSE (OFL 1.1)',
    shippedAs: 'Excalidraw "Code" font family',
  },
  {
    name: 'Comic Shanns',
    from: { pkg: '@excalidraw/excalidraw', dir: 'dist/prod/fonts/ComicShanns' },
    out: [/^excalidraw-assets\/fonts\/ComicShanns\//],
    license: 'MIT',
    copyright: ['Copyright (c) 2018 Shannon Miwa', 'Copyright (c) 2023 Jesus Gonzalez', 'Copyright (c) 2023 Rodrigo Batista de Moraes', 'Copyright (c) 2024 Fini Jastrow', 'Copyright (c) 2024 Kyle Beechly'],
    upstream: 'https://github.com/jesusmgg/comic-shanns-mono',
    verified: 'the MIT licence embedded in the shipped files',
    shippedAs: 'Excalidraw "Comic Shanns" font family',
    embeddedText: true,
  },
  {
    name: 'Excalifont',
    from: { pkg: '@excalidraw/excalidraw', dir: 'dist/prod/fonts/Excalifont' },
    out: [/^excalidraw-assets\/fonts\/Excalifont\//],
    license: 'OFL-1.1',
    copyright: ['Copyright (c) 2024 by Excalidraw.', 'Based on Virgil, Copyright (c) 2011 by Your Own Font Foundry; modifications by Ján Filípek / DizajnDesign.'],
    upstream: `${EXCALIDRAW_FONTS}/Excalifont`,
    verified: 'the original font name table quoted in the upstream source (packages/excalidraw/fonts/Excalifont/index.ts); the subset files ship without a licence string',
    shippedAs: 'Excalidraw default hand-drawn font',
  },
  {
    name: 'Liberation Sans',
    from: { pkg: '@excalidraw/excalidraw', dir: 'dist/prod/fonts/Liberation' },
    out: [/^excalidraw-assets\/fonts\/Liberation\//],
    license: 'GPL-2.0-only WITH Font-exception-2.0',
    copyright: ['Digitized data copyright (c) 2007 Ascender Corporation. All rights reserved.', 'Copyright (c) 2007-2011 Red Hat, Inc. All rights reserved. LIBERATION is a trademark of Red Hat, Inc.'],
    upstream: 'https://github.com/liberationfonts/liberation-1.7-fonts',
    verified: 'name table of the shipped file (Liberation Sans 1.05, "subject to the license agreement under which you accepted the Liberation font software") and the Liberation 1.x License.txt',
    shippedAs: 'Excalidraw "Helvetica" fallback font',
    // Not on the MIT-compatible list: shipped as a separate, unmodified font file (aggregation, not a
    // combined work), with the font exception covering documents that embed it. Its licence and the
    // GPL text are reproduced below; the source is the unmodified upstream font named here.
    exception:
      'Liberation Sans 1.05 is under the GNU GPL v2 with the font exception (Red Hat\'s Liberation 1.x licence). oIDE ships it unmodified, as a separate file that Excalidraw loads for its "Helvetica" family; it is not linked into oIDE\'s code. Its source is the upstream Liberation 1.x font release (https://github.com/liberationfonts/liberation-1.7-fonts) and the identical file in the Excalidraw repository (https://github.com/excalidraw/excalidraw/tree/master/packages/excalidraw/fonts/Liberation).',
  },
  {
    name: 'Lilita One',
    from: { pkg: '@excalidraw/excalidraw', dir: 'dist/prod/fonts/Lilita' },
    out: [/^excalidraw-assets\/fonts\/Lilita\//],
    license: 'OFL-1.1',
    copyright: ['Copyright (c) 2011 Juan Montoreano (juan@remolacha.biz), with Reserved Font Names "Lilita One"'],
    upstream: 'https://fonts.google.com/specimen/Lilita+One',
    verified: 'name table of the shipped files (copyright, licence URL scripts.sil.org/OFL)',
    shippedAs: 'Excalidraw "Lilita One" font family',
  },
  {
    name: 'Nunito',
    from: { pkg: '@excalidraw/excalidraw', dir: 'dist/prod/fonts/Nunito' },
    out: [/^excalidraw-assets\/fonts\/Nunito\//],
    license: 'OFL-1.1',
    copyright: ['Copyright 2014 The Nunito Project Authors (https://github.com/googlefonts/nunito)'],
    upstream: 'https://github.com/googlefonts/nunito',
    verified: 'name table of the shipped files (copyright, licence URL scripts.sil.org/OFL) and the upstream OFL.txt',
    shippedAs: 'Excalidraw "Nunito" font family',
  },
  {
    name: 'Virgil',
    from: { pkg: '@excalidraw/excalidraw', dir: 'dist/prod/fonts/Virgil' },
    out: [/^excalidraw-assets\/fonts\/Virgil\//],
    license: 'OFL-1.1',
    copyright: ['Copyright (c) 2011 by Your Own Font Foundry. All rights reserved.'],
    upstream: `${EXCALIDRAW_FONTS}/Virgil`,
    verified: 'the OFL 1.1 licence embedded in the shipped file',
    shippedAs: 'Excalidraw legacy hand-drawn font',
  },
  {
    name: 'Xiaolai SC',
    from: { pkg: '@excalidraw/excalidraw', dir: 'dist/prod/fonts/Xiaolai' },
    out: [/^excalidraw-assets\/fonts\/Xiaolai\//],
    license: 'OFL-1.1',
    copyright: ['Copyright 2020-2024 LXGW (https://github.com/lxgw/kose-font)', 'Copyright 2014 Nozomi Seto (https://ja.osdn.net/projects/setofont/)'],
    upstream: 'https://github.com/lxgw/kose-font',
    verified: 'the original font name table quoted in the upstream source (packages/excalidraw/fonts/Xiaolai/index.ts) and the upstream OFL.txt; the subset files ship without a licence string',
    shippedAs: 'Excalidraw CJK fallback font (209 subset files)',
  },
  {
    name: 'Inter',
    from: { pkg: '@fontsource/inter', dir: 'files' },
    out: [new RegExp(String.raw`^assets\/inter-[a-z0-9-]+${HASH}\.woff2?$`)],
    license: 'OFL-1.1',
    copyright: ['Copyright 2016 The Inter Project Authors (https://github.com/rsms/inter)'],
    upstream: 'https://github.com/rsms/inter',
    verified: 'the package LICENSE (OFL 1.1, reproduced in the @fontsource/inter section)',
    shippedAs: 'oIDE UI font (latin 400-700, emitted by Vite)',
  },
  {
    name: 'JetBrains Mono',
    from: { pkg: '@fontsource/jetbrains-mono', dir: 'files' },
    out: [new RegExp(String.raw`^assets\/jetbrains-mono-[a-z0-9-]+${HASH}\.woff2?$`)],
    license: 'OFL-1.1',
    copyright: ['Copyright 2020 The JetBrains Mono Project Authors (https://github.com/JetBrains/JetBrainsMono)'],
    upstream: 'https://github.com/JetBrains/JetBrainsMono',
    verified: 'the package LICENSE (OFL 1.1, reproduced in the @fontsource/jetbrains-mono section)',
    shippedAs: 'oIDE code and path font (latin 400-500, emitted by Vite)',
  },
  {
    name: 'Codicons',
    from: { pkg: 'monaco-editor', dir: 'esm/vs/base/browser/ui/codicons/codicon' },
    out: [new RegExp(String.raw`^assets\/codicon${HASH}\.ttf$`)],
    license: 'CC-BY-4.0',
    copyright: ['Copyright (c) Microsoft Corporation. Codicons are licensed under the Creative Commons Attribution 4.0 International licence: https://creativecommons.org/licenses/by/4.0/'],
    upstream: 'https://github.com/microsoft/vscode-codicons',
    verified: 'the upstream LICENSE (CC BY 4.0 for the icons; the code is MIT)',
    shippedAs: 'Monaco editor icon font (emitted by Vite)',
  },
];

/* ------------------------------------------------------------------ WOFF2 name table */

const WOFF2_TAGS = 'cmap,head,hhea,hmtx,maxp,name,OS/2,post,cvt ,fpgm,glyf,loca,prep,CFF ,VORG,EBDT,EBLC,gasp,hdmx,kern,LTSH,PCLT,VDMX,vhea,vmtx,BASE,GDEF,GPOS,GSUB,EBSC,JSTF,MATH,CBDT,CBLC,COLR,CPAL,SVG ,sbix,acnt,avar,bdat,bloc,bsln,cvar,fdsc,feat,fmtx,fvar,gvar,hsty,just,lcar,mort,morx,opbd,prop,trak,Zapf,Silf,Glat,Gloc,Feat,Sill'.split(',');

/**
 * The name table of a WOFF2 font (W3C WOFF2 §4-5): nameID → string, Windows (UTF-16BE) records
 * preferred. 0 copyright, 1 family, 5 version, 13 licence, 14 licence URL. Throws on a non-WOFF2 file.
 */
export function woff2Names(buf) {
  if (buf.toString('latin1', 0, 4) !== 'wOF2') throw new Error('not a WOFF2 file');
  const numTables = buf.readUInt16BE(12);
  const compressed = buf.readUInt32BE(20);
  let p = 48;
  const base128 = () => {
    let v = 0;
    for (let i = 0; i < 5; i++) {
      const b = buf[p++];
      v = v * 128 + (b & 0x7f);
      if (!(b & 0x80)) return v;
    }
    throw new Error('bad UIntBase128');
  };
  const tables = [];
  for (let i = 0; i < numTables; i++) {
    const flags = buf[p++];
    let tag = WOFF2_TAGS[flags & 0x3f];
    if ((flags & 0x3f) === 63) {
      tag = buf.toString('latin1', p, p + 4);
      p += 4;
    }
    const version = flags >> 6;
    const length = base128();
    const transformed = tag === 'glyf' || tag === 'loca' ? version === 0 : version !== 0;
    tables.push({ tag, length: transformed ? base128() : length });
  }
  const data = brotliDecompressSync(buf.subarray(p, p + compressed));
  let off = 0;
  for (const t of tables) {
    if (t.tag === 'name') return parseNameTable(data.subarray(off, off + t.length));
    off += t.length;
  }
  return {};
}

function parseNameTable(d) {
  const count = d.readUInt16BE(2);
  const strings = d.readUInt16BE(4);
  const out = {};
  for (let i = 0; i < count; i++) {
    const r = 6 + i * 12;
    const platform = d.readUInt16BE(r);
    const id = d.readUInt16BE(r + 6);
    const raw = d.subarray(strings + d.readUInt16BE(r + 10), strings + d.readUInt16BE(r + 10) + d.readUInt16BE(r + 8));
    let s = '';
    if (platform === 0 || platform === 3) for (let k = 0; k + 1 < raw.length; k += 2) s += String.fromCharCode(raw.readUInt16BE(k));
    else s = raw.toString('latin1');
    if (!(id in out) || platform === 3) out[id] = s.replace(/\r\n?/g, '\n').trim();
  }
  return out;
}

/** Licences a font's own name table points at (copyright, licence text, licence URL). */
export function licenseHints(names) {
  const text = [names[0], names[13], names[14]].filter(Boolean).join('\n');
  const hints = new Set();
  if (/Open Font License|scripts\.sil\.org\/OFL|openfontlicense\.org/i.test(text)) hints.add('OFL-1.1');
  if (/^MIT License|copy of this software and associated documentation files/m.test(text)) hints.add('MIT');
  if (/Apache License/i.test(text)) hints.add('Apache-2.0');
  if (/Liberation font software/i.test(text)) hints.add('GPL-2.0-only WITH Font-exception-2.0');
  if (/GNU General Public License/i.test(text) && !hints.size) hints.add('GPL');
  return hints;
}

/* ------------------------------------------------------------------ collect and check */

function listFonts(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...listFonts(p));
    else if (FONT_FILE.test(e.name)) out.push(p);
  }
  return out.sort();
}

/**
 * Resolve each record's files, read the embedded copyright strings and check them.
 * `resolvePackage(name)` returns the package folder or null. `isAllowed(spdx)` is the allow-list.
 * Returns { records, problems } where each record gains `files`, `embedded` (unique copyright strings).
 */
export function collectFonts({ resolvePackage, isAllowed, assets = FONT_ASSETS }) {
  const problems = [];
  const records = [];
  const fontRoots = new Map(); // package → fonts root folder holding one folder per family
  for (const a of assets) {
    const pkgDir = resolvePackage(a.from.pkg);
    if (!pkgDir) {
      problems.push(`${a.name}: package ${a.from.pkg} is not installed`);
      continue;
    }
    const dir = join(pkgDir, ...a.from.dir.split('/'));
    const files = listFonts(dir);
    if (!files.length) problems.push(`${a.name}: no font files in ${a.from.pkg}/${a.from.dir}`);
    if (a.from.pkg === '@excalidraw/excalidraw') fontRoots.set(dirname(dir), a.from.pkg);
    if (!isAllowed(a.license) && !a.exception) problems.push(`${a.name}: licence ${a.license} is not MIT-compatible and the record gives no reason it may ship`);
    const embedded = new Set();
    let text;
    for (const f of files.filter((x) => x.endsWith('.woff2'))) {
      let names;
      try {
        names = woff2Names(readFileSync(f));
      } catch (err) {
        problems.push(`${a.name}: cannot read ${relative(pkgDir, f)}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      if (names[0] && !a.embeddedText) embedded.add(names[0]);
      for (const h of licenseHints(names)) {
        if (h !== a.license) problems.push(`${a.name}: ${relative(pkgDir, f).split(sep).join('/')} says ${h}, the record says ${a.license}`);
      }
      if (a.embeddedText && names[0]) text ??= names[0];
    }
    records.push({ ...a, files, embedded: [...embedded].sort(), ...(text ? { text } : {}) });
  }
  // Every family folder Excalidraw ships must have a record.
  for (const [root, pkg] of fontRoots) {
    for (const fam of readdirSync(root).sort()) {
      const p = join(root, fam);
      if (!statSync(p).isDirectory() || !listFonts(p).length) continue;
      if (!assets.some((a) => a.from.pkg === pkg && a.from.dir.split('/').pop() === fam)) problems.push(`${pkg} ships the font folder ${fam}/ but it has no licence record in tools/licenses/fonts.mjs`);
    }
  }
  const dedup = [...new Set(problems)];
  return { records, problems: dedup };
}

/** After a build: every font file in `outDir` (apps/desktop/out/renderer) must match a record. */
export function checkBuiltFonts(outDir, assets = FONT_ASSETS) {
  if (!existsSync(outDir)) return { checked: 0, problems: [] };
  const problems = [];
  const files = listFonts(outDir);
  for (const f of files) {
    const rel = relative(outDir, f).split(sep).join('/');
    if (!assets.some((a) => a.out.some((re) => re.test(rel)))) problems.push(`out/renderer/${rel}: shipped font with no recorded licence (add it to tools/licenses/fonts.mjs)`);
  }
  return { checked: files.length, problems };
}

/** The "Bundled fonts" part of THIRD_PARTY_NOTICES.md (deterministic). */
export function renderFonts(records) {
  const esc = (s) => String(s).replace(/\|/g, '\\|');
  let md = '## Bundled fonts\n\n';
  md += 'Fonts are files, not code, so they are listed here by family. The Excalidraw fonts are copied from\n';
  md += '`@excalidraw/excalidraw` into `excalidraw-assets/fonts/`; the others are emitted by the build from the\n';
  md += 'packages named. Licence texts follow the table; each family lists its copyright notices, including the\n';
  md += 'strings embedded in the shipped files.\n\n';
  md += '| Font | Licence | From | Font files in source | Shipped as |\n| --- | --- | --- | --- | --- |\n';
  for (const r of records) md += `| [${esc(r.name)}](${r.upstream}) | ${esc(r.license)} | \`${esc(r.from.pkg)}\` | ${r.files.length} | ${esc(r.shippedAs)} |\n`;
  md += '\n';
  for (const r of records) {
    md += `### Font: ${r.name}\n\n`;
    md += `Licence: ${r.license} · ${r.upstream} · from \`${r.from.pkg}/${r.from.dir}\`\n\n`;
    md += `Licence verified from ${r.verified}.\n\n`;
    if (r.exception) md += `${r.exception}\n\n`;
    const lines = [...r.copyright, ...r.embedded.filter((e) => !r.copyright.includes(e)).map((e) => `${e} (embedded in the shipped files)`)];
    for (const l of lines) md += `- ${l.replace(/\n+/g, ' ')}\n`;
    md += '\n';
    if (r.text) md += `${fence(r.text)}text\n${r.text}\n${fence(r.text)}\n\n`;
  }
  const used = [...new Set(records.map((r) => r.license))].filter((l) => LICENSE_TEXTS[l]).sort();
  for (const l of used) {
    const files = [LICENSE_TEXTS[l]].flat();
    md += `### Licence text: ${l}\n\n`;
    md += `Applies to: ${records.filter((r) => r.license === l).map((r) => r.name).join(', ')}.\n\n`;
    for (const f of files) {
      const t = readLicenseText(f);
      md += `${fence(t)}text\n${t}\n${fence(t)}\n\n`;
    }
  }
  return md;
}

const fence = (t) => (t.includes('```') ? '~~~~' : '```');
