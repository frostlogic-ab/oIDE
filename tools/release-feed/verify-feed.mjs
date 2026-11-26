#!/usr/bin/env node
// Checks a GitHub release's auto-update feed before it is published (.github/workflows/release.yml,
// job "finalize"). electron-updater reads latest*.yml from the release and downloads the files it
// names, so a release missing a platform's feed file, or naming an asset that is not attached (or has
// another size), would leave that platform's users without updates or with failing downloads.
//
//   node tools/release-feed/verify-feed.mjs --version 0.2.0 --feed <dir with latest*.yml> --assets <assets.json>
//
// assets.json: `gh release view <tag> --json assets --jq '[.assets[] | {name, size}]'`.
// Plain Node, no dependencies: the finalize job runs it without `pnpm install`.
// See docs/wiki/pages/release-pipeline.md.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Feed files every release must carry, by electron-updater's naming (`latest` + platform suffix;
 * Linux adds the arch when it is not x64), and the installers each must offer. `match` tests a
 * feed entry's file name.
 */
export const REQUIRED_FEEDS = {
  'latest.yml': {
    platform: 'Windows (NSIS)',
    needs: [
      { what: 'x64 installer', match: (f) => /\.exe$/i.test(f) && /x64/.test(f) },
      { what: 'arm64 installer', match: (f) => /\.exe$/i.test(f) && /arm64/.test(f) },
    ],
  },
  'latest-mac.yml': {
    platform: 'macOS',
    needs: [
      { what: 'arm64 zip', match: (f) => /\.zip$/i.test(f) && /arm64/.test(f) },
      { what: 'x64 zip', match: (f) => /\.zip$/i.test(f) && /x64/.test(f) },
    ],
  },
  'latest-linux.yml': { platform: 'Linux x64 (AppImage)', needs: [{ what: 'x64 AppImage', match: (f) => /\.AppImage$/.test(f) }] },
  'latest-linux-arm64.yml': { platform: 'Linux arm64 (AppImage)', needs: [{ what: 'arm64 AppImage', match: (f) => /\.AppImage$/.test(f) }] },
};

const unquote = (v) => {
  const t = v.trim();
  if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'))) return t.slice(1, -1).replace(/''/g, "'");
  return t;
};

/**
 * Parses the subset of YAML electron-builder writes for update info: top-level scalars and the
 * `files:` list of maps. Other keys (and block scalars such as release notes) are skipped.
 * @returns {{ version?: string, path?: string, sha512?: string, files: Array<{ url?: string, sha512?: string, size?: number }> }}
 */
export function parseFeed(text) {
  const out = { files: [] };
  let inFiles = false;
  let item = null;
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || raw.trimStart().startsWith('#')) continue;
    const top = /^([A-Za-z0-9_]+):(.*)$/.exec(raw);
    if (top) {
      inFiles = top[1] === 'files';
      item = null;
      if (!inFiles && ['version', 'path', 'sha512'].includes(top[1])) out[top[1]] = unquote(top[2]);
      continue;
    }
    if (!inFiles) continue;
    const entry = /^\s*-\s+([A-Za-z0-9_]+):(.*)$/.exec(raw);
    const field = /^\s+([A-Za-z0-9_]+):(.*)$/.exec(raw);
    if (entry) {
      item = {};
      out.files.push(item);
    }
    const m = entry ?? field;
    if (m && item) {
      const v = unquote(m[2]);
      item[m[1]] = m[1] === 'size' || m[1] === 'blockMapSize' ? Number(v) : v;
    }
  }
  return out;
}

/**
 * @param {{ version: string, feeds: Record<string, string | undefined>, assets: Array<{ name: string, size: number }> }} input
 *   feeds: feed file name → contents (undefined when the release has none)
 * @returns {string[]} problems; empty when every platform's feed is complete
 */
export function verifyFeed({ version, feeds, assets }) {
  const problems = [];
  const byName = new Map(assets.map((a) => [a.name, a]));
  for (const [file, spec] of Object.entries(REQUIRED_FEEDS)) {
    const text = feeds[file];
    if (text === undefined) {
      problems.push(`${file} is missing: ${spec.platform} users would get no updates.`);
      continue;
    }
    const feed = parseFeed(text);
    if (feed.version !== version) problems.push(`${file}: version is ${feed.version ?? 'missing'}, expected ${version}.`);
    if (!feed.files.length) problems.push(`${file}: lists no files.`);
    for (const f of feed.files) {
      if (!f.url) {
        problems.push(`${file}: an entry has no url.`);
        continue;
      }
      const asset = byName.get(f.url);
      if (!asset) problems.push(`${file}: ${f.url} is not attached to the release.`);
      else if (f.size !== undefined && asset.size !== f.size) problems.push(`${file}: ${f.url} is ${asset.size} bytes on the release, the feed says ${f.size}.`);
      if (!f.sha512) problems.push(`${file}: ${f.url} has no sha512.`);
    }
    if (feed.path && !feed.files.some((f) => f.url === feed.path)) problems.push(`${file}: path ${feed.path} is not among its files.`);
    for (const need of spec.needs) {
      if (!feed.files.some((f) => f.url && need.match(f.url))) problems.push(`${file}: no ${need.what} (${spec.platform}).`);
    }
  }
  return problems;
}

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  if (!v) {
    console.error(`usage: verify-feed.mjs --version X.Y.Z --feed <dir> --assets <assets.json> (missing --${name})`);
    process.exit(2);
  }
  return v;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const version = arg('version');
  const dir = arg('feed');
  const assets = JSON.parse(readFileSync(arg('assets'), 'utf8'));
  const feeds = Object.fromEntries(Object.keys(REQUIRED_FEEDS).map((f) => [f, existsSync(join(dir, f)) ? readFileSync(join(dir, f), 'utf8') : undefined]));
  const problems = verifyFeed({ version, feeds, assets });
  if (problems.length) {
    for (const p of problems) console.log(`::error::${p}`);
    console.error(`The update feed of v${version} is incomplete; the release stays a draft.`);
    process.exit(1);
  }
  console.log(`Update feed of v${version} is complete: ${Object.keys(REQUIRED_FEEDS).join(', ')} name only attached assets.`);
}
