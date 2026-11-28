import { basename, relative } from 'node:path';
import type { MainContext } from '../context.js';
import { IpcError, type IpcRouter } from '../ipc/router.js';
import { assertInside } from '../security/paths.js';
import type { Services } from '../services/index.js';

const toPosix = (p: string) => p.split('\\').join('/');

/**
 * deps.* (Files › Dependency versions): the latest npm version of the dependencies an open
 * package.json lists. Project and agent-worktree checkouts only; the file must be a package.json
 * inside the checkout (main reads the `.npmrc` files next to it and above it, up to the root).
 */
export function registerDepsHandlers(router: IpcRouter, s: Services, ctx: MainContext): void {
  router.register('deps.latest', async ({ root, path, names }) => {
    const r = ctx.roots.assertAllowed(root, ['project', 'worktree']);
    const rel = toPosix(relative(r, assertInside(r, path)));
    if (!rel || rel.startsWith('..') || rel.split('/').includes('.git')) throw new IpcError('Not a file of this checkout', 'forbidden_path');
    if (basename(rel) !== 'package.json') throw new IpcError('Only package.json files list npm dependencies', 'invalid_input');
    return s.npm.latest(r, rel, names);
  });
}
