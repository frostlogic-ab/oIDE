#!/usr/bin/env node
// Logo exploration for oIDE (docs/brand/concepts/). Writes four concept marks as SVG, a
// 16/32/128/512 px PNG preview of each (@resvg/resvg-js), and docs/brand/concepts.png, a contact
// sheet of all four at several sizes on dark and light grounds (rendered with Playwright Chromium).
// Run: node tools/brand/concepts.mjs   The chosen mark is built by tools/brand/build-brand.mjs.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = join(ROOT, 'docs', 'brand', 'concepts');

// Palette from docs/wiki/pages/design-system.md; the light set is the same hues, deepened for white.
export const PALETTES = {
  dark: { blue: '#7AA2F7', violet: '#C4A7E7', mint: '#7FC8A9', hub: '#E6E8EB', ground: '#0E1013' },
  light: { blue: '#3B6FE6', violet: '#8A5CC8', mint: '#2C9A73', hub: '#0E1013', ground: '#FFFFFF' },
};

const f = (n) => Number(n.toFixed(3));
/** Point on a circle, angle in degrees clockwise from 12 o'clock. */
const polar = (cx, cy, r, deg) => {
  const a = (deg * Math.PI) / 180;
  return [f(cx + r * Math.sin(a)), f(cy - r * Math.cos(a))];
};
const grad = (id, p, x1 = 10, y1 = 8, x2 = 54, y2 = 56) =>
  `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}">` +
  `<stop offset="0" stop-color="${p.blue}"/><stop offset=".55" stop-color="${p.violet}"/><stop offset="1" stop-color="${p.mint}"/></linearGradient>`;

/** 1. Orbit: a thick gradient "o" with a tilted orbit passing behind and in front, carrying two agents. */
function orbit(id, p) {
  const tilt = -28;
  const rx = 29;
  const ry = 10;
  const node = (deg, r, c) => `<circle cx="${f(32 + rx * Math.cos((deg * Math.PI) / 180))}" cy="${f(32 + ry * Math.sin((deg * Math.PI) / 180))}" r="${r}" fill="${c}"/>`;
  return (
    `<defs>${grad(`${id}g`, p)}<clipPath id="${id}front"><rect x="0" y="32" width="64" height="32"/></clipPath></defs>` +
    `<g transform="rotate(${tilt} 32 32)"><ellipse cx="32" cy="32" rx="${rx}" ry="${ry}" fill="none" stroke="${p.violet}" stroke-width="2.5" opacity=".45"/></g>` +
    `<circle cx="32" cy="32" r="16.5" fill="none" stroke="url(#${id}g)" stroke-width="8"/>` +
    `<g transform="rotate(${tilt} 32 32)" clip-path="url(#${id}front)"><ellipse cx="32" cy="32" rx="${rx}" ry="${ry}" fill="none" stroke="${p.violet}" stroke-width="2.5"/>` +
    `${node(35, 3.6, p.mint)}${node(150, 2.8, p.blue)}</g>`
  );
}

/** 2. Facet: an octagonal "o" cut like a gem, eight bevelled facets lit from the top left. */
function facet(id, p) {
  const R = 27;
  const r = 13;
  const parts = [];
  for (let i = 0; i < 8; i++) {
    const a0 = i * 45 - 22.5;
    const a1 = a0 + 45;
    const pts = [polar(32, 32, R, a0), polar(32, 32, R, a1), polar(32, 32, r, a1), polar(32, 32, r, a0)];
    const mid = i * 45; // facet normal, clockwise from top
    const light = Math.cos(((mid - 315) * Math.PI) / 180); // light from the top left
    const shade = light >= 0 ? `fill="#FFFFFF" opacity="${f(light * 0.38)}"` : `fill="#000000" opacity="${f(-light * 0.32)}"`;
    const d = `M${pts.map((q) => q.join(' ')).join('L')}Z`;
    parts.push(`<path d="${d}" fill="url(#${id}g)"/><path d="${d}" ${shade}/>`);
  }
  // Facet seams in the ground colour keep the cut crisp.
  const seams = [];
  for (let i = 0; i < 8; i++) {
    const a = i * 45 - 22.5;
    const [x1, y1] = polar(32, 32, r, a);
    const [x2, y2] = polar(32, 32, R, a);
    seams.push(`M${x1} ${y1}L${x2} ${y2}`);
  }
  return `<defs>${grad(`${id}g`, p)}</defs>${parts.join('')}<path d="${seams.join('')}" stroke="${p.ground}" stroke-width=".9" opacity=".7"/>`;
}

/** 3. Constellation: one hub coordinating six agents on a ring, hub-and-spoke network. */
function constellation(id, p) {
  const nodes = [0, 60, 120, 180, 240, 300].map((deg, i) => ({ xy: polar(32, 32, 21, deg), c: [p.blue, p.violet, p.mint][i % 3] }));
  const spokes = nodes.map(({ xy }) => `M32 32L${xy.join(' ')}`).join('');
  return (
    `<defs>${grad(`${id}g`, p)}</defs>` +
    `<circle cx="32" cy="32" r="21" fill="none" stroke="url(#${id}g)" stroke-width="3"/>` +
    `<path d="${spokes}" stroke="url(#${id}g)" stroke-width="1.6" opacity=".55"/>` +
    nodes.map(({ xy, c }) => `<circle cx="${xy[0]}" cy="${xy[1]}" r="4.6" fill="${c}"/>`).join('') +
    `<circle cx="32" cy="32" r="6" fill="url(#${id}g)"/>`
  );
}

/** 4. Signal: an open "o" whose gap holds the lead agent, with the hub at the centre. */
function signal(id, p) {
  const r = 19;
  const [sx, sy] = polar(32, 32, r, 80);
  const [ex, ey] = polar(32, 32, r, 370);
  const [nx, ny] = polar(32, 32, r, 45);
  return (
    `<defs>${grad(`${id}g`, p)}</defs>` +
    `<path d="M${sx} ${sy}A${r} ${r} 0 1 1 ${ex} ${ey}" fill="none" stroke="url(#${id}g)" stroke-width="8.5"/>` +
    `<circle cx="${nx}" cy="${ny}" r="8.6" fill="none" stroke="${p.mint}" stroke-width="1.4" opacity=".45"/>` +
    `<circle cx="${nx}" cy="${ny}" r="5.2" fill="${p.mint}"/>` +
    `<circle cx="32" cy="32" r="4.2" fill="${p.blue}"/>`
  );
}

export const CONCEPTS = [
  { slug: 'concept-1-orbit', name: 'Orbit', draw: orbit },
  { slug: 'concept-2-facet', name: 'Facet', draw: facet },
  { slug: 'concept-3-constellation', name: 'Constellation', draw: constellation },
  { slug: 'concept-4-signal', name: 'Signal', draw: signal },
];

export const svgDoc = (inner, title, size = 64) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 64 64">\n  <title>${title}</title>\n  ${inner}\n</svg>\n`;

export const rasterise = (svg, size) =>
  Buffer.from(new Resvg(svg, { fitTo: { mode: 'width', value: size }, background: 'rgba(0,0,0,0)', font: { loadSystemFonts: false } }).render().asPng());

/** Contact sheet: every mark at 16…128 px on dark and light, plus the 16 px raster zoomed ×4. */
export async function contactSheet(rows, file, heading) {
  const { chromium } = await import('playwright');
  const sizes = [16, 24, 32, 48, 64, 128];
  const uri = (svg) => `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
  const pngUri = (buf) => `data:image/png;base64,${buf.toString('base64')}`;
  const panel = (svg, tone) =>
    `<div class="panel ${tone}">${sizes.map((s) => `<img src="${uri(svg)}" width="${s}" height="${s}">`).join('')}` +
    `<img class="zoom" src="${pngUri(rasterise(svg, 16))}" width="64" height="64" title="16px x4"></div>`;
  const html = `<!doctype html><html><head><style>
    body{margin:0;padding:32px;background:#0B0D10;color:#E6E8EB;font:13px "Segoe UI",system-ui,sans-serif;width:1240px}
    h1{font-size:18px;margin:0 0 4px} p{margin:0 0 20px;color:#9AA3AE}
    .row{display:grid;grid-template-columns:150px 1fr 1fr;gap:14px;align-items:center;margin-bottom:14px}
    .name{font-weight:600;font-size:15px} .name small{display:block;color:#6B7584;font-weight:400;font-size:11.5px}
    .panel{display:flex;align-items:center;gap:20px;padding:18px 20px;border-radius:10px}
    .dark{background:#0E1013;border:1px solid #232830} .light{background:#FFFFFF;border:1px solid #D0D7DE}
    .zoom{image-rendering:pixelated;margin-left:auto;outline:1px dashed #6B758455}
    </style></head><body><h1>${heading}</h1><p>16 · 24 · 32 · 48 · 64 · 128 px, then the 16 px raster zoomed ×4. Dark ground #0E1013, light ground #FFFFFF.</p>
    ${rows.map((r) => `<div class="row"><div class="name">${r.name}<small>${r.note ?? ''}</small></div>${panel(r.dark, 'dark')}${panel(r.light, 'light')}</div>`).join('')}
    </body></html>`;
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1304, height: 400 }, deviceScaleFactor: 1 });
    await page.setContent(html);
    await page.screenshot({ path: file, fullPage: true });
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  mkdirSync(OUT, { recursive: true });
  const rows = [];
  for (const c of CONCEPTS) {
    const dark = svgDoc(c.draw(c.slug.slice(0, 9).replace(/-/g, ''), PALETTES.dark), `oIDE logo concept: ${c.name}`);
    const light = svgDoc(c.draw(`${c.slug.slice(0, 9).replace(/-/g, '')}l`, PALETTES.light), `oIDE logo concept: ${c.name} (light)`);
    writeFileSync(join(OUT, `${c.slug}.svg`), dark);
    writeFileSync(join(OUT, `${c.slug}-light.svg`), light);
    for (const s of [16, 32, 128, 512]) writeFileSync(join(OUT, `${c.slug}-${s}.png`), rasterise(dark, s));
    rows.push({ name: c.name, dark, light });
  }
  await contactSheet(rows, join(ROOT, 'docs', 'brand', 'concepts.png'), 'oIDE logo concepts');
  console.log(`Wrote ${CONCEPTS.length} concepts to ${OUT} and docs/brand/concepts.png`);
}
