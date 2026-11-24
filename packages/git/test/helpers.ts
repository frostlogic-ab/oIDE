import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// Tests must not depend on the developer's global git config (signing, hooks, default branch…).
const isolatedHome = mkdtempSync(join(tmpdir(), 'oide-git-home-'));
writeFileSync(join(isolatedHome, 'gitconfig'), '');
process.env.GIT_CONFIG_GLOBAL = join(isolatedHome, 'gitconfig');
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_AUTHOR_NAME = 'Test User';
process.env.GIT_AUTHOR_EMAIL = 'test@example.com';
process.env.GIT_COMMITTER_NAME = 'Test User';
process.env.GIT_COMMITTER_EMAIL = 'test@example.com';

const made: string[] = [];

export function tempDir(prefix = 'oide-git-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  made.push(d);
  return d;
}

export function cleanup(): void {
  for (const d of made.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // Windows may hold a handle briefly; temp dirs are cleaned by the OS eventually.
    }
  }
}

export function sh(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

export function write(root: string, rel: string, content: string | Buffer): void {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}

/** A repo on `main` with one commit containing `files`. */
export function makeRepo(files: Record<string, string> = { 'README.md': '# demo\n' }): string {
  const dir = join(tempDir(), 'repo');
  mkdirSync(dir);
  sh(dir, 'init', '-q', '-b', 'main');
  sh(dir, 'config', 'core.autocrlf', 'false');
  for (const [k, v] of Object.entries(files)) write(dir, k, v);
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

export function commitAll(cwd: string, message: string): string {
  sh(cwd, 'add', '-A');
  sh(cwd, 'commit', '-q', '-m', message);
  return sh(cwd, 'rev-parse', 'HEAD').trim();
}
