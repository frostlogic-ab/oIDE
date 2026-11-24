import { existsSync, lstatSync, readdirSync, rmdirSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Synchronous delete that also works for non-ASCII paths on Windows. Some Node releases (seen on
 * 24.11) make `fs.rmSync` return without deleting anything when the path holds characters
 * outside ASCII (`C:\Users\Zoë\…`, `文档`), with no error. `unlinkSync` / `rmdirSync` are not
 * affected, so after `rmSync` this checks and, if needed, walks the tree itself. Never throws for
 * a missing path; other errors (a locked file) are thrown so callers can retry or schedule.
 */
export function removeSync(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch (err) {
    if (!existsSync(path)) return;
    throw err;
  }
  if (!pathExists(path)) return;
  walkRemove(path);
}

function pathExists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

function walkRemove(p: string): void {
  const st = lstatSync(p);
  if (!st.isDirectory()) {
    unlinkSync(p);
    return;
  }
  for (const name of readdirSync(p)) walkRemove(join(p, name));
  rmdirSync(p);
}
