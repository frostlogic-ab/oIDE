// Platform-only optional dependencies, for tools/licenses/notices.mjs. Kept apart from notices.mjs
// (which writes THIRD_PARTY_NOTICES.md when imported) so tests can import these helpers.

/**
 * Optional dependencies that install only on some OSes (`os` / `cpu` / `libc` in their package
 * metadata) and are not a `<parent>-<platform>` prebuild. They are listed on every OS from this
 * record, so THIRD_PARTY_NOTICES.md is the same whichever OS generates it. (The v0.2.0 macOS release
 * build failed because `fsevents`, an optional dependency of chokidar, only installs on macOS.)
 * Where the package is installed, the record is checked against it; on every OS, its version is
 * checked against pnpm-lock.yaml. `file` is the package's licence text in tools/licenses/texts.
 */
export const PLATFORM_ONLY = {
  fsevents: { version: '2.3.3', license: 'MIT', repo: 'https://github.com/fsevents/fsevents', platforms: 'macOS only', file: 'fsevents-MIT.txt' },
};

/**
 * Versions in pnpm-lock.yaml's `packages:` section, each with whether it is limited to some OSes,
 * CPUs or libcs. The lockfile lists every platform's optional packages, so this works on any OS.
 * @param {string} text pnpm-lock.yaml contents (lockfile v9)
 * @returns {Map<string, Array<{ version: string, restricted: boolean }>>}
 */
export function lockfilePackages(text) {
  const map = new Map();
  const lines = text.split(/\r?\n/);
  let inPackages = false;
  let current = null;
  for (const line of lines) {
    if (/^\S/.test(line)) {
      inPackages = line === 'packages:';
      current = null;
      continue;
    }
    if (!inPackages) continue;
    // `  name@1.2.3:`, `  '@scope/name@1.2.3':`, `  name@1.2.3(peer@4.5.6):`
    const key = /^ {2}'?((?:@[^@/'\s]+\/)?[^@/'\s]+)@([^('\s:]+)[^:]*'?:\s*$/.exec(line);
    if (key) {
      current = { version: key[2], restricted: false };
      map.set(key[1], [...(map.get(key[1]) ?? []), current]);
    } else if (current && /^ {4}(?:os|cpu|libc):/.test(line)) {
      current.restricted = true;
    }
  }
  return map;
}

/**
 * How notices.mjs should treat an optional dependency that is not a `<parent>-<platform>` prebuild.
 * - `record`: listed in PLATFORM_ONLY; render it from the record. `problems` lists drift between
 *   the record and the installed package or the lockfile.
 * - `unlisted`: installs only on some platforms but has no PLATFORM_ONLY record (a problem: the
 *   notices would differ per OS).
 * - `normal`: an ordinary optional dependency (installed: record it; not installed anywhere: skip).
 * @param {string} name
 * @param {{ version: string, license: string | null, text: string | null, restricted: boolean } | null} installed
 *   the package as installed here (`text`: its normalised licence file), or null when not installed
 * @param {Map<string, Array<{ version: string, restricted: boolean }>>} lock from lockfilePackages
 * @param {(file: string) => string} readText reads a licence text from tools/licenses/texts
 */
export function classifyOptional(name, installed, lock, readText) {
  const rec = PLATFORM_ONLY[name];
  const locked = lock.get(name) ?? [];
  if (rec) {
    const problems = [];
    if (locked.length && !locked.some((l) => l.version === rec.version)) {
      problems.push(`${name}: PLATFORM_ONLY records ${rec.version} but pnpm-lock.yaml has ${locked.map((l) => l.version).join(', ')}. Update the record and tools/licenses/texts/${rec.file}.`);
    }
    if (installed) {
      if (installed.version !== rec.version) problems.push(`${name}: installed ${installed.version}, PLATFORM_ONLY records ${rec.version}.`);
      if (installed.license !== rec.license) problems.push(`${name}: installed licence ${installed.license ?? 'none'}, PLATFORM_ONLY records ${rec.license}.`);
      if (installed.text !== null && installed.text !== readText(rec.file)) problems.push(`${name}: the installed licence text differs from tools/licenses/texts/${rec.file}.`);
    }
    return { kind: 'record', record: rec, problems };
  }
  if (installed?.restricted || locked.some((l) => l.restricted)) return { kind: 'unlisted' };
  return { kind: 'normal' };
}
