import { describe, expect, it } from 'vitest';
import { fileKind } from './fileIcons';

const glyph = (name: string) => {
  const g = fileKind(name).glyph;
  return g.kind === 'text' ? g.text : 'svg';
};

describe('fileKind', () => {
  it('matches by extension', () => {
    expect(glyph('index.ts')).toBe('TS');
    expect(glyph('App.tsx')).toBe('TSX');
    expect(glyph('data.json')).toBe('{}');
    expect(glyph('pnpm-workspace.yaml')).toBe('!');
  });

  it('prefers exact file names over the extension', () => {
    expect(fileKind('package.json').color).not.toBe(fileKind('tsconfig.base.json').color);
    expect(fileKind('README.md')).not.toEqual(fileKind('notes.md'));
    expect(glyph('.npmrc')).toBe('npm');
  });

  it('falls back to a generic page for unknown types and extensionless names', () => {
    expect(fileKind('blob.xyz')).toEqual(fileKind('NOTICE'));
    expect(glyph('blob.xyz')).toBe('svg');
  });
});
