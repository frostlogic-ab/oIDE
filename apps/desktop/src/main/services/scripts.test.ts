import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { detectScripts, justRecipes, makeTargets, packageManager, stripJsonComments } from './scripts';

const dirs: string[] = [];
function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'oide-scripts-'));
  dirs.push(dir);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('detectScripts', () => {
  it('lists package.json scripts with the package manager from the lockfile', async () => {
    const root = repo({
      'package.json': JSON.stringify({ scripts: { build: 'tsc', dev: 'vite', 'dev:watch': 'vite --watch', 'rm -rf /; x': 'nope', 'a b': 'nope' } }),
      'pnpm-lock.yaml': '',
    });
    const list = await detectScripts(root, { platform: 'linux' });
    expect(list.map((s) => [s.name, s.command])).toEqual([
      ['build', 'pnpm run build'],
      ['dev', 'pnpm run dev'],
      ['dev:watch', 'pnpm run dev:watch'],
    ]);
    expect(list[0]).toMatchObject({ id: 'pnpm:package.json:build', runner: 'pnpm', file: 'package.json' });
  });

  it('uses the .cmd shim on Windows when it is on PATH', async () => {
    const root = repo({ 'package.json': JSON.stringify({ scripts: { test: 'vitest' } }) });
    expect((await detectScripts(root, { platform: 'win32', hasCmdShim: () => true }))[0]!.command).toBe('npm.cmd run test');
    expect((await detectScripts(root, { platform: 'win32', hasCmdShim: () => false }))[0]!.command).toBe('npm run test');
  });

  it('finds non-Node projects: Makefile, Cargo, Go, just, deno', async () => {
    const root = repo({
      Makefile: '.PHONY: build test\nCC := gcc\nbuild: deps\n\tgo build\ntest:\n\tgo test\nmain.o: main.c\n%.o: %.c\n',
      'Cargo.toml': '[package]\nname = "x"\n',
      'go.mod': 'module x\n',
      justfile: 'set shell := ["bash", "-c"]\nalias b := build\nbuild target="x":\n  echo\n@lint:\n  echo\n',
      'deno.jsonc': '{ // tasks\n "tasks": { "start": "deno run main.ts" /* c */ } }',
    });
    const list = await detectScripts(root, { platform: 'linux' });
    const by = (runner: string) => list.filter((s) => s.runner === runner).map((s) => s.command);
    expect(by('make')).toEqual(['make build', 'make test']);
    expect(by('cargo')).toContain('cargo run');
    expect(by('go')).toContain('go test ./...');
    expect(by('just')).toEqual(['just build', 'just lint']);
    expect(by('deno')).toEqual(['deno task start']);
  });

  it('returns nothing for an unreadable folder or a broken package.json', async () => {
    expect(await detectScripts(join(tmpdir(), 'oide-no-such-folder-x'))).toEqual([]);
    expect(await detectScripts(repo({ 'package.json': '{ not json' }))).toEqual([]);
  });
});

describe('helpers', () => {
  it('packageManager prefers the packageManager field', () => {
    expect(packageManager({ packageManager: 'yarn@4.1.0' }, new Set(['pnpm-lock.yaml']))).toBe('yarn');
    expect(packageManager({}, new Set(['bun.lock']))).toBe('bun');
    expect(packageManager(null, new Set())).toBe('npm');
  });

  it('makeTargets skips variables, special and file targets', () => {
    expect(makeTargets('all: a\nX = 1\nY ::= 2\n.PHONY: all\nout/app: x\nclean::\n\trm\n')).toEqual(['all', 'clean']);
  });

  it('justRecipes skips settings', () => {
    expect(justRecipes('set dotenv-load\nexport A := "1"\ndev:\n  x\n')).toEqual(['dev']);
  });

  it('stripJsonComments keeps strings intact', () => {
    expect(JSON.parse(stripJsonComments('{"a": "http://x" // c\n}'))).toEqual({ a: 'http://x' });
  });
});
