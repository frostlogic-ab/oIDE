import * as nodeFs from 'node:fs';
import { createRequire } from 'node:module';

/**
 * Node's own `fs`, without Electron's asar support. Use it for every file operation on user
 * folders (worktrees, project checkouts) in the Electron main process.
 *
 * Electron patches `node:fs` so that any `*.asar` file looks like a folder, and it opens each
 * archive it touches and keeps the file handle in a process-wide cache that is never closed. A
 * worktree with `node_modules` has such a file (`electron/dist/resources/default_app.asar`), so
 * `fs.rm(worktree, { recursive: true })` walked into it, failed with
 * `EBUSY: rmdir '…\default_app.asar'`, and from then on oIDE held that file open: neither oIDE's
 * background retries nor Explorer could delete the folder until oIDE quit. The same applies to a
 * `stat`, `open` or `readFile` of such a file. `original-fs` is the unpatched module Electron ships
 * for exactly this; outside Electron (tests, the CLI) this is plain `node:fs`.
 */
export const plainFs: typeof nodeFs = loadPlainFs();

/** `plainFs.promises`. */
export const plainFsPromises: typeof nodeFs.promises = plainFs.promises;

function loadPlainFs(): typeof nodeFs {
  if (!process.versions.electron) return nodeFs;
  try {
    return createRequire(import.meta.url)('original-fs') as typeof nodeFs;
  } catch {
    return nodeFs;
  }
}
