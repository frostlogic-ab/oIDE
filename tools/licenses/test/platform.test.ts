import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readLicenseText } from '../fonts.mjs';
import { classifyOptional, lockfilePackages, PLATFORM_ONLY } from '../platform.mjs';

const LOCK = `lockfileVersion: '9.0'

importers:

  .:
    dependencies:
      fsevents:
        specifier: 2.3.3
        version: 2.3.3

packages:

  '@scope/native-darwin@1.0.0':
    resolution: {integrity: sha512-x}
    cpu: [arm64]
    os: [darwin]

  chokidar@3.6.0:
    resolution: {integrity: sha512-y}
    engines: {node: '>= 8.10.0'}

  fsevents@2.3.3:
    resolution: {integrity: sha512-z}
    os: [darwin]

  react-dom@19.0.0(react@19.0.0):
    resolution: {integrity: sha512-w}

snapshots:

  later@1.0.0:
    os: [linux]
`;

describe('lockfilePackages', () => {
  const lock = lockfilePackages(LOCK);

  it('reads versions and platform limits from the packages section', () => {
    expect(lock.get('fsevents')).toEqual([{ version: '2.3.3', restricted: true }]);
    expect(lock.get('@scope/native-darwin')).toEqual([{ version: '1.0.0', restricted: true }]);
    expect(lock.get('chokidar')).toEqual([{ version: '3.6.0', restricted: false }]);
    expect(lock.get('react-dom')).toEqual([{ version: '19.0.0', restricted: false }]);
  });

  it('ignores the importers and snapshots sections', () => {
    expect(lock.has('later')).toBe(false);
    expect(lock.size).toBe(4);
  });

  it('finds fsevents as macOS-only in the real lockfile', () => {
    const real = lockfilePackages(readFileSync(new URL('../../../pnpm-lock.yaml', import.meta.url), 'utf8'));
    expect(real.get('fsevents')?.some((l) => l.restricted)).toBe(true);
    expect(real.get('chokidar')?.every((l) => !l.restricted)).toBe(true);
  });
});

describe('classifyOptional', () => {
  const lock = lockfilePackages(LOCK);
  const fseventsText = readLicenseText(PLATFORM_ONLY.fsevents.file);

  it('renders a recorded package the same whether or not it is installed', () => {
    const absent = classifyOptional('fsevents', null, lock, readLicenseText);
    const present = classifyOptional('fsevents', { version: '2.3.3', license: 'MIT', text: fseventsText, restricted: true }, lock, readLicenseText);
    expect(absent).toEqual({ kind: 'record', record: PLATFORM_ONLY.fsevents, problems: [] });
    expect(present).toEqual(absent);
  });

  it('reports drift from the installed package and from the lockfile', () => {
    const bumped = lockfilePackages(LOCK.replace('fsevents@2.3.3', 'fsevents@2.3.4'));
    expect(classifyOptional('fsevents', null, bumped, readLicenseText).problems).toEqual([expect.stringContaining('pnpm-lock.yaml has 2.3.4')]);
    const drifted = classifyOptional('fsevents', { version: '2.3.4', license: 'ISC', text: 'other', restricted: true }, lock, readLicenseText);
    expect(drifted.problems).toHaveLength(3);
  });

  it('flags a platform-only optional dependency with no record, installed or not', () => {
    expect(classifyOptional('@scope/native-darwin', null, lock, readLicenseText)).toEqual({ kind: 'unlisted' });
    expect(classifyOptional('elsewhere', { version: '1.0.0', license: 'MIT', text: null, restricted: true }, new Map(), readLicenseText)).toEqual({ kind: 'unlisted' });
  });

  it('leaves ordinary optional dependencies alone', () => {
    expect(classifyOptional('chokidar', null, lock, readLicenseText)).toEqual({ kind: 'normal' });
    expect(classifyOptional('nowhere', null, new Map(), readLicenseText)).toEqual({ kind: 'normal' });
  });
});
