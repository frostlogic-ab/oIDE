import { describe, expect, it } from 'vitest';
import { parseFeed, verifyFeed } from '../verify-feed.mjs';

// The feed files electron-builder 26 uploaded to the v0.2.0 draft (sha512 shortened).
const WIN = `version: 0.2.0
files:
  - url: oIDE-0.2.0-win.exe
    sha512: YonCa2==
    size: 277009647
  - url: oIDE-0.2.0-win-x64.exe
    sha512: fmaYNR==
    size: 141742986
  - url: oIDE-0.2.0-win-arm64.exe
    sha512: uSdNf2==
    size: 135921968
path: oIDE-0.2.0-win.exe
sha512: YonCa2==
releaseDate: '2026-11-26T14:39:28.892Z'
`;
const LINUX = `version: 0.2.0
files:
  - url: oIDE-0.2.0-linux-x86_64.AppImage
    sha512: oa60b2==
    size: 147797272
    blockMapSize: 156972
  - url: oIDE-0.2.0-linux-amd64.deb
    sha512: rGymEn==
    size: 122045788
path: oIDE-0.2.0-linux-x86_64.AppImage
sha512: oa60b2==
releaseDate: '2026-11-26T14:38:33.923Z'
`;
const LINUX_ARM = LINUX.replace(/x86_64/g, 'arm64').replace('amd64', 'arm64');
const MAC = `version: 0.2.0
files:
  - url: oIDE-0.2.0-mac-arm64.zip
    sha512: aaa==
    size: 100
  - url: oIDE-0.2.0-mac-x64.zip
    sha512: bbb==
    size: 200
path: oIDE-0.2.0-mac-arm64.zip
sha512: aaa==
releaseNotes: |
  - url: not-a-file.zip
releaseDate: '2026-11-26T14:40:00.000Z'
`;

const feeds = { 'latest.yml': WIN, 'latest-mac.yml': MAC, 'latest-linux.yml': LINUX, 'latest-linux-arm64.yml': LINUX_ARM };
const assetsOf = (f: Record<string, string>) =>
  Object.values(f).flatMap((t) => parseFeed(t).files.map((x) => ({ name: x.url!, size: x.size! })));

describe('parseFeed', () => {
  it('reads version, path and the files list', () => {
    const f = parseFeed(WIN);
    expect(f.version).toBe('0.2.0');
    expect(f.path).toBe('oIDE-0.2.0-win.exe');
    expect(f.files).toHaveLength(3);
    expect(f.files[1]).toEqual({ url: 'oIDE-0.2.0-win-x64.exe', sha512: 'fmaYNR==', size: 141742986 });
    expect(parseFeed(LINUX).files[0]?.blockMapSize).toBe(156972);
  });

  it('skips other keys and block scalars', () => {
    expect(parseFeed(MAC).files.map((f) => f.url)).toEqual(['oIDE-0.2.0-mac-arm64.zip', 'oIDE-0.2.0-mac-x64.zip']);
  });
});

describe('verifyFeed', () => {
  it('passes a complete feed', () => {
    expect(verifyFeed({ version: '0.2.0', feeds, assets: assetsOf(feeds) })).toEqual([]);
  });

  it('fails the v0.2.0 draft: no macOS feed (the macOS build failed)', () => {
    const draft = { ...feeds, 'latest-mac.yml': undefined };
    expect(verifyFeed({ version: '0.2.0', feeds: draft, assets: assetsOf({ ...feeds }) })).toEqual(['latest-mac.yml is missing: macOS users would get no updates.']);
  });

  it('fails when a named file is not attached, has another size, or the version is wrong', () => {
    const assets = assetsOf(feeds)
      .filter((a) => a.name !== 'oIDE-0.2.0-win-arm64.exe')
      .map((a) => (a.name === 'oIDE-0.2.0-linux-x86_64.AppImage' ? { ...a, size: 1 } : a));
    const problems = verifyFeed({ version: '0.2.1', feeds, assets });
    expect(problems).toEqual(
      expect.arrayContaining([
        'latest.yml: oIDE-0.2.0-win-arm64.exe is not attached to the release.',
        'latest-linux.yml: oIDE-0.2.0-linux-x86_64.AppImage is 1 bytes on the release, the feed says 147797272.',
        'latest.yml: version is 0.2.0, expected 0.2.1.',
      ]),
    );
  });

  it('fails when a platform installer is missing from its feed', () => {
    const noArm = WIN.replace(/ {2}- url: oIDE-0\.2\.0-win-arm64\.exe\n.*\n.*\n/, '');
    const f = { ...feeds, 'latest.yml': noArm };
    expect(verifyFeed({ version: '0.2.0', feeds: f, assets: assetsOf(f) })).toEqual(['latest.yml: no arm64 installer (Windows (NSIS)).']);
  });
});
