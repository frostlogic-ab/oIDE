#!/usr/bin/env node
// Builds every app icon from apps/desktop/build/icon.svg (pnpm icons):
//   build/icon.png            1024×1024 (electron-builder fallback, docs)
//   build/icons/<n>x<n>.png   Linux icon set
//   build/icon.ico            Windows, PNG-encoded entries 16…256
//   build/icon.icns           macOS, PNG-encoded entries 16…1024
// Rasterised with @resvg/resvg-js (a build-time devDependency; nothing here ships). The ICO and ICNS
// containers are written by hand: both are a small header plus the PNGs.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BUILD = join(ROOT, 'apps', 'desktop', 'build');
const svg = readFileSync(join(BUILD, 'icon.svg'), 'utf8');

const cache = new Map();
function png(size) {
  if (!cache.has(size)) {
    const r = new Resvg(svg, { fitTo: { mode: 'width', value: size }, background: 'rgba(0,0,0,0)', font: { loadSystemFonts: false } });
    cache.set(size, Buffer.from(r.render().asPng()));
  }
  return cache.get(size);
}

/** ICO: ICONDIR (6 bytes) + one ICONDIRENTRY (16 bytes) per image + the PNG data. */
export function buildIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);
  let offset = 6 + 16 * images.length;
  const entries = images.map(({ size, data }) => {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0); // width (0 means 256)
    e.writeUInt8(size >= 256 ? 0 : size, 1); // height
    e.writeUInt8(0, 2); // palette colours
    e.writeUInt8(0, 3); // reserved
    e.writeUInt16LE(1, 4); // colour planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    return e;
  });
  return Buffer.concat([header, ...entries, ...images.map((i) => i.data)]);
}

/** ICNS: 'icns' + total length (big-endian), then per image a 4-char type + length + PNG data. */
export function buildIcns(images) {
  const chunks = images.map(({ type, data }) => {
    const h = Buffer.alloc(8);
    h.write(type, 0, 4, 'ascii');
    h.writeUInt32BE(data.length + 8, 4);
    return Buffer.concat([h, data]);
  });
  const header = Buffer.alloc(8);
  header.write('icns', 0, 4, 'ascii');
  header.writeUInt32BE(8 + chunks.reduce((n, c) => n + c.length, 0), 4);
  return Buffer.concat([header, ...chunks]);
}

const LINUX_SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
const ICNS_TYPES = [
  ['icp4', 16],
  ['icp5', 32],
  ['icp6', 64],
  ['ic07', 128],
  ['ic08', 256],
  ['ic09', 512],
  ['ic10', 1024],
];

mkdirSync(join(BUILD, 'icons'), { recursive: true });
writeFileSync(join(BUILD, 'icon.png'), png(1024));
for (const s of LINUX_SIZES) writeFileSync(join(BUILD, 'icons', `${s}x${s}.png`), png(s));
writeFileSync(join(BUILD, 'icon.ico'), buildIco(ICO_SIZES.map((size) => ({ size, data: png(size) }))));
writeFileSync(join(BUILD, 'icon.icns'), buildIcns(ICNS_TYPES.map(([type, size]) => ({ type, data: png(size) }))));
console.log(`Icons written to ${BUILD}: icon.png, icons/{${LINUX_SIZES.join(',')}}, icon.ico (${ICO_SIZES.length} sizes), icon.icns (${ICNS_TYPES.length} sizes).`);
