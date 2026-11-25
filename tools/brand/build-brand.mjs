#!/usr/bin/env node
// Builds the oIDE brand set from one geometry (docs/brand/README.md). Run: node tools/brand/build-brand.mjs
// then pnpm icons (rasterises the app icons written here).
//
//   docs/brand/logo-mark{,-light,-mono}.svg       the symbol ("Signal": open o, lead agent in the gap, hub)
//   docs/brand/logo-wordmark{,-light}.svg         symbol + "oIDE" as outlines (no font needed)
//   docs/brand/logo-mark-{16,32,128,512}.png      previews; docs/brand/logo-sheet.png (sizes on dark/light)
//   docs/brand/social-preview.png                 1280×640 GitHub social preview (Playwright Chromium, Inter)
//   apps/desktop/build/icon.svg, icon-small.svg   app icon sources (large sizes / 16-32 px)
//   docs/site/public/{logo-mark,logo-mark-light,favicon}.svg, social-preview.png
//   packages/ui/src/logoGeometry.ts               the path data <Logo> draws (generated, do not edit)
//   apps/desktop/src/renderer/index.html          the favicon <link> (inlined icon-small.svg)

import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PALETTES, contactSheet, rasterise } from './concepts.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BRAND = join(ROOT, 'docs', 'brand');
const f = (n) => Number(n.toFixed(3));
const polar = (r, deg, c = 32) => {
  const a = (deg * Math.PI) / 180;
  return [f(c + r * Math.sin(a)), f(c - r * Math.cos(a))];
};

/**
 * Geometry on a 64-unit grid. `full` for 48 px and up; `small` (thicker ring, bigger agent and
 * bite) for 16-32 px, where a 1 px gap must survive rasterisation.
 */
export const GEOMETRY = {
  full: { r: 21, stroke: 9, gapAt: 45, node: 6, bite: 10.5, hub: 4.8, highlight: true },
  small: { r: 20.5, stroke: 11, gapAt: 45, node: 7.4, bite: 11.6, hub: 5.6, highlight: false },
};

/** The open ring as one closed path: outer arc, bite, inner arc, bite (no masks, so any tool can read it). */
function ringPath(g) {
  const ro = g.r + g.stroke / 2;
  const ri = g.r - g.stroke / 2;
  const [nx, ny] = polar(g.r, g.gapAt);
  const off = (rho) => (Math.acos((rho * rho + g.r * g.r - g.bite * g.bite) / (2 * rho * g.r)) * 180) / Math.PI;
  const ao = off(ro);
  const ai = off(ri);
  const p1 = polar(ro, g.gapAt + ao);
  const p2 = polar(ro, g.gapAt - ao + 360);
  const p3 = polar(ri, g.gapAt - ai + 360);
  const p4 = polar(ri, g.gapAt + ai);
  const sweep = (a, b) => ((a[0] - nx) * (b[1] - ny) - (a[1] - ny) * (b[0] - nx) > 0 ? 1 : 0);
  return (
    `M${p1.join(' ')}A${ro} ${ro} 0 1 1 ${p2.join(' ')}` +
    `A${g.bite} ${g.bite} 0 0 ${sweep(p2, p3)} ${p3.join(' ')}` +
    `A${ri} ${ri} 0 1 0 ${p4.join(' ')}` +
    `A${g.bite} ${g.bite} 0 0 ${sweep(p4, p1)} ${p1.join(' ')}Z`
  );
}

/** Specular highlight along the upper-left of the ring (the "glass"). */
function highlightPath(g) {
  const rr = g.r + g.stroke / 2 - 1.7;
  const a = polar(rr, 232);
  const b = polar(rr, 328);
  return `M${a.join(' ')}A${rr} ${rr} 0 0 1 ${b.join(' ')}`;
}

export function shapes(kind) {
  const g = GEOMETRY[kind];
  const [nx, ny] = polar(g.r, g.gapAt);
  return { ring: ringPath(g), highlight: g.highlight ? highlightPath(g) : null, node: { cx: nx, cy: ny, r: g.node }, hub: { cx: 32, cy: 32, r: g.hub } };
}

/** SVG markup of the mark on the 64 grid. `p` null = monochrome (currentColor). */
export function markInner(id, p, kind = 'full') {
  const s = shapes(kind);
  if (!p) {
    return `<path d="${s.ring}"/><circle cx="${s.node.cx}" cy="${s.node.cy}" r="${s.node.r}"/><circle cx="32" cy="32" r="${s.hub.r}"/>`;
  }
  return (
    `<defs>` +
    `<linearGradient id="${id}-ring" gradientUnits="userSpaceOnUse" x1="12" y1="10" x2="52" y2="56"><stop offset="0" stop-color="${p.blue}"/><stop offset="1" stop-color="${p.violet}"/></linearGradient>` +
    `<radialGradient id="${id}-agent" gradientUnits="userSpaceOnUse" cx="${f(s.node.cx - s.node.r * 0.35)}" cy="${f(s.node.cy - s.node.r * 0.35)}" r="${f(s.node.r * 1.35)}"><stop offset="0" stop-color="${p.mintHi}"/><stop offset="1" stop-color="${p.mint}"/></radialGradient>` +
    `<radialGradient id="${id}-hub" gradientUnits="userSpaceOnUse" cx="${f(32 - s.hub.r * 0.35)}" cy="${f(32 - s.hub.r * 0.35)}" r="${f(s.hub.r * 1.35)}"><stop offset="0" stop-color="${p.blueHi}"/><stop offset="1" stop-color="${p.blue}"/></radialGradient>` +
    `</defs>` +
    `<path d="${s.ring}" fill="url(#${id}-ring)"/>` +
    (s.highlight ? `<path d="${s.highlight}" fill="none" stroke="#FFFFFF" stroke-opacity="${p.shine}" stroke-width="1.5" stroke-linecap="round"/>` : '') +
    `<circle cx="${s.node.cx}" cy="${s.node.cy}" r="${s.node.r}" fill="url(#${id}-agent)"/>` +
    `<circle cx="32" cy="32" r="${s.hub.r}" fill="url(#${id}-hub)"/>`
  );
}

const BRAND_P = {
  dark: { ...PALETTES.dark, blueHi: '#B4CBFB', mintHi: '#C2EBD8', shine: 0.38, ink: '#E6E8EB' },
  light: { ...PALETTES.light, blueHi: '#6E95F0', mintHi: '#5CC39C', shine: 0.3, ink: '#0E1013' },
};

const header = (title, desc) => `  <title>${title}</title>\n  <desc>${desc}</desc>\n`;
const markSvg = (id, p, title, kind = 'full') =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"${p ? '' : ' fill="currentColor"'}>\n` +
  header(title, 'oIDE mark: an open lowercase o (the workspace), the lead agent in its opening, the hub at its centre. MIT, see docs/brand/README.md.') +
  `  ${markInner(id, p, kind)}\n</svg>\n`;

// ---------------------------------------------------------------- wordmark letters (outlines)

/**
 * "oIDE" drawn as geometric outlines with Inter 700's proportions (cap height 100, stem 19,
 * x-height 75), so the wordmark needs no font. Origin at the baseline's left; returns path + advance.
 */
function letters() {
  const o = (x) => {
    // Lowercase o: x-height 75 plus overshoot; horizontal strokes slightly thinner than vertical.
    const cx = x + 39;
    const cy = 100 - 38.5;
    return `M${cx - 39} ${cy}A39 39.5 0 1 0 ${cx + 39} ${cy}A39 39.5 0 1 0 ${cx - 39} ${cy}Z M${cx - 20.5} ${cy}A20.5 23.2 0 1 1 ${cx + 20.5} ${cy}A20.5 23.2 0 1 1 ${cx - 20.5} ${cy}Z`;
  };
  const I = (x) => `M${x} 0H${x + 19}V100H${x}Z`;
  const D = (x) =>
    `M${x} 0H${x + 35}C${x + 59} 0 ${x + 75} 19 ${x + 75} 50C${x + 75} 81 ${x + 59} 100 ${x + 35} 100H${x}Z` +
    `M${x + 19} 17V83H${x + 34}C${x + 48} 83 ${x + 56} 71 ${x + 56} 50C${x + 56} 29 ${x + 48} 17 ${x + 34} 17Z`;
  const E = (x) => `M${x} 0H${x + 59}V17H${x + 19}V41.5H${x + 54}V58H${x + 19}V83H${x + 59}V100H${x}Z`;
  const parts = [o(0), I(90), D(121), E(207)];
  return { d: parts.join(''), width: 266 };
}

function wordmarkSvg(id, p, title) {
  const { d, width } = letters();
  const markScale = 1.9; // mark box 121.6 (ring ≈ 97); letters at cap height 58, as in Inter 700 beside the mark
  const box = 64 * markScale;
  const gap = 24;
  const k = 0.58;
  const capTop = (box - 100 * k) / 2;
  const W = f(box + gap + width * k + 2);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${f(box)}" viewBox="0 0 ${W} ${f(box)}">\n` +
    header(title, 'oIDE wordmark: the mark followed by "oIDE" as outlines (Inter 700 proportions). MIT, see docs/brand/README.md.') +
    `  <g transform="scale(${markScale})">${markInner(id, p, 'full')}</g>\n` +
    `  <path transform="translate(${f(box + gap)} ${f(capTop)}) scale(${k})" fill="${p.ink}" fill-rule="evenodd" d="${d}"/>\n</svg>\n`
  );
}

// ---------------------------------------------------------------- app icon (tile + mark)

function iconSvg(kind) {
  const small = kind === 'small';
  const p = BRAND_P.dark;
  const inset = small ? 24 : 72;
  const size = 1024 - inset * 2;
  const rx = small ? 210 : 200;
  const markPx = small ? 900 : 620;
  const scale = f(markPx / 64);
  const off = f((1024 - markPx) / 2);
  const s = shapes(kind);
  const nodeX = f(off + s.node.cx * scale);
  const nodeY = f(off + s.node.cy * scale);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">\n` +
    `  <title>oIDE</title>\n` +
    `  <!-- Generated by tools/brand/build-brand.mjs (${small ? 'icon-small: 16-32 px entries' : 'icon: 48 px and up'}); rasterised by pnpm icons. -->\n` +
    `  <defs>\n` +
    `    <linearGradient id="tile" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#171C27"/><stop offset="1" stop-color="#0B0D10"/></linearGradient>\n` +
    `    <linearGradient id="edge" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${p.blue}" stop-opacity=".55"/><stop offset=".5" stop-color="#343A44" stop-opacity=".6"/><stop offset="1" stop-color="${p.violet}" stop-opacity=".45"/></linearGradient>\n` +
    `    <radialGradient id="core" cx="512" cy="512" r="${small ? 420 : 360}" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${p.blue}" stop-opacity=".22"/><stop offset="1" stop-color="${p.blue}" stop-opacity="0"/></radialGradient>\n` +
    (small ? '' : `    <radialGradient id="glow" cx="${nodeX}" cy="${nodeY}" r="150" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${p.mint}" stop-opacity=".45"/><stop offset="1" stop-color="${p.mint}" stop-opacity="0"/></radialGradient>\n`) +
    `  </defs>\n` +
    `  <rect x="${inset}" y="${inset}" width="${size}" height="${size}" rx="${rx}" fill="url(#tile)"/>\n` +
    `  <rect x="${inset}" y="${inset}" width="${size}" height="${size}" rx="${rx}" fill="url(#core)"/>\n` +
    (small ? '' : `  <circle cx="${nodeX}" cy="${nodeY}" r="150" fill="url(#glow)"/>\n`) +
    `  <rect x="${inset + 3}" y="${inset + 3}" width="${size - 6}" height="${size - 6}" rx="${rx - 3}" fill="none" stroke="url(#edge)" stroke-width="${small ? 10 : 6}"/>\n` +
    `  <g transform="translate(${off} ${off}) scale(${scale})">${markInner('m', p, kind)}</g>\n</svg>\n`
  );
}

// ---------------------------------------------------------------- outputs

function geometryModule() {
  const obj = (o) => `{ ${Object.entries(o).map(([k, v]) => `${k}: ${v}`).join(', ')} }`;
  const entry = (kind) => {
    const s = shapes(kind);
    return (
      `  ${kind}: {
    ring: '${s.ring}',
    highlight: ${s.highlight ? `'${s.highlight}'` : 'null'},
` +
      `    node: ${obj(s.node)},
    hub: ${obj(s.hub)},
  },
`
    );
  };
  const c = BRAND_P.dark;
  return (
    `// Generated by tools/brand/build-brand.mjs from the brand geometry. Do not edit by hand.
` +
    `// The oIDE mark on a 64-unit grid: \`full\` for 48 px and up, \`small\` (heavier) for 16-32 px.

` +
    `export interface LogoShapes {
  ring: string;
  highlight: string | null;
  node: { cx: number; cy: number; r: number };
  hub: { cx: number; cy: number; r: number };
}

` +
    `export const LOGO_SHAPES: { full: LogoShapes; small: LogoShapes } = {
${entry('full')}${entry('small')}};

` +
    `/** Brand colours (fixed; they do not follow the user-selected accent). */
` +
    `export const LOGO_COLORS = ${obj({ blue: `'${c.blue}'`, blueHi: `'${c.blueHi}'`, violet: `'${c.violet}'`, mint: `'${c.mint}'`, mintHi: `'${c.mintHi}'` })} as const;
`
  );
}

async function socialPreview(file) {
  const { chromium } = await import('playwright');
  const font = (w) => `data:font/woff2;base64,${readFileSync(join(ROOT, 'node_modules', '@fontsource', 'inter', 'files', `inter-latin-${w}-normal.woff2`)).toString('base64')}`;
  const mark = `data:image/svg+xml;base64,${Buffer.from(markSvg('sp', BRAND_P.dark, 'oIDE')).toString('base64')}`;
  const html = `<!doctype html><html><head><style>
    @font-face{font-family:Inter;font-weight:400;src:url(${font(400)}) format('woff2')}
    @font-face{font-family:Inter;font-weight:700;src:url(${font(700)}) format('woff2')}
    html,body{margin:0;width:1280px;height:640px;overflow:hidden}
    body{background:#0E1013;font-family:Inter;color:#E6E8EB;position:relative}
    .bg{position:absolute;inset:0;background:
      radial-gradient(520px 420px at 300px 320px, rgba(122,162,247,.20), transparent 70%),
      radial-gradient(420px 360px at 1120px 80px, rgba(196,167,231,.14), transparent 70%),
      radial-gradient(380px 300px at 1100px 600px, rgba(127,200,169,.10), transparent 70%)}
    .grid{position:absolute;inset:0;background-image:radial-gradient(rgba(154,163,174,.16) 1.2px, transparent 1.3px);background-size:32px 32px;
      -webkit-mask-image:radial-gradient(800px 500px at 50% 50%, #000 30%, transparent 80%)}
    .wrap{position:absolute;inset:0;display:flex;align-items:center;gap:64px;padding:0 120px}
    img{width:300px;height:300px;flex:none}
    h1{margin:0;font-weight:700;font-size:132px;letter-spacing:-.02em;line-height:1}
    .tag{margin:22px 0 0;font-size:38px;font-weight:700;letter-spacing:-.01em;background:linear-gradient(90deg,#9DBBFA,#C4A7E7 60%,#A8E0C6);-webkit-background-clip:text;color:transparent}
    .sub{margin:18px 0 0;font-size:24px;color:#9AA3AE;line-height:1.4;max-width:640px}
    .foot{position:absolute;left:120px;right:120px;bottom:44px;display:flex;justify-content:space-between;color:#6B7584;font-size:20px}
  </style></head><body><div class="bg"></div><div class="grid"></div>
    <div class="wrap"><img src="${mark}" alt=""><div><h1>oIDE</h1><p class="tag">Mission Control for coding agents</p>
    <p class="sub">Run many Claude Code CLI agents in parallel, across many projects, in one window.</p></div></div>
    <div class="foot"><span>Open source · MIT</span><span>Windows · macOS · Linux</span></div></body></html>`;
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 640 }, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: 'load' });
    await page.evaluate('document.fonts.ready');
    await page.screenshot({ path: file });
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  mkdirSync(BRAND, { recursive: true });
  const outputs = {
    'logo-mark.svg': markSvg('oide-mark', BRAND_P.dark, 'oIDE'),
    'logo-mark-light.svg': markSvg('oide-mark-l', BRAND_P.light, 'oIDE'),
    'logo-mark-mono.svg': markSvg('oide-mark-m', null, 'oIDE', 'small'),
    'logo-wordmark.svg': wordmarkSvg('oide-wm', BRAND_P.dark, 'oIDE'),
    'logo-wordmark-light.svg': wordmarkSvg('oide-wm-l', BRAND_P.light, 'oIDE'),
  };
  for (const [name, svg] of Object.entries(outputs)) writeFileSync(join(BRAND, name), svg);
  for (const s of [16, 32, 128, 512]) writeFileSync(join(BRAND, `logo-mark-${s}.png`), rasterise(outputs['logo-mark.svg'], s));

  const icon = iconSvg('full');
  const iconSmall = iconSvg('small');
  const build = join(ROOT, 'apps', 'desktop', 'build');
  writeFileSync(join(build, 'icon.svg'), icon);
  writeFileSync(join(build, 'icon-small.svg'), iconSmall);

  const site = join(ROOT, 'docs', 'site', 'public');
  mkdirSync(site, { recursive: true });
  copyFileSync(join(BRAND, 'logo-mark.svg'), join(site, 'logo-mark.svg'));
  copyFileSync(join(BRAND, 'logo-mark-light.svg'), join(site, 'logo-mark-light.svg'));
  writeFileSync(join(site, 'favicon.svg'), iconSmall);

  writeFileSync(join(ROOT, 'packages', 'ui', 'src', 'logoGeometry.ts'), geometryModule());

  // Renderer favicon: the small icon inlined (CSP allows data: images; no file:// lookup in packaged builds).
  const html = join(ROOT, 'apps', 'desktop', 'src', 'renderer', 'index.html');
  const favicon = `data:image/svg+xml;base64,${Buffer.from(iconSmall.replace(/\s*<!--.*?-->/g, '').replace(/\n\s*/g, '')).toString('base64')}`;
  writeFileSync(html, readFileSync(html, 'utf8').replace(/<link rel="icon"[^>]*\/>/, `<link rel="icon" type="image/svg+xml" href="${favicon}" />`));

  const mono = (color) => outputs['logo-mark-mono.svg'].replace('fill="currentColor"', `fill="${color}"`);
  await contactSheet(
    [
      { name: 'Mark', note: 'full geometry', dark: outputs['logo-mark.svg'], light: outputs['logo-mark-light.svg'] },
      { name: 'Mark, small', note: 'geometry for 16-32 px', dark: markSvg('a', BRAND_P.dark, 'oIDE', 'small'), light: markSvg('b', BRAND_P.light, 'oIDE', 'small') },
      { name: 'Mono', note: 'one colour (tray, stamps)', dark: mono('#E6E8EB'), light: mono('#0E1013') },
      { name: 'App icon', note: 'icon-small ≤32, icon ≥48', dark: iconSmall, light: icon },
    ],
    join(BRAND, 'logo-sheet.png'),
    'oIDE mark: final set',
  );
  await socialPreview(join(BRAND, 'social-preview.png'));
  copyFileSync(join(BRAND, 'social-preview.png'), join(site, 'social-preview.png'));
  // Wordmark previews for the README check.
  writeFileSync(join(BRAND, 'logo-wordmark.png'), rasterise(outputs['logo-wordmark.svg'], 832));
  console.log('Brand set written: docs/brand, apps/desktop/build/icon{,-small}.svg, docs/site/public, packages/ui/src/logoGeometry.ts');
}
