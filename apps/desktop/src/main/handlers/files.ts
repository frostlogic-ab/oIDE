import { basename, dirname, join, relative } from 'node:path';
import { fileHistory, isInside as gitIsInside, plainFs, samePath } from '@oide/git';
import { buildSearchRegExp, type ArtifactMeta, type FileNode } from '@oide/protocol';
import type { MainContext } from '../context.js';
import { IpcError, type IpcRouter } from '../ipc/router.js';
import { assertInside, isInside } from '../security/paths.js';
import { ContentSearch, FileIndex, replaceInFiles, type ReplaceTarget } from '../services/file-search.js';
import type { Services } from '../services/index.js';

// Not node:fs: in Electron it treats `*.asar` files as folders and keeps them open (@oide/git plain-fs).
const { existsSync } = plainFs;
const { mkdir, readdir, readFile, stat, writeFile } = plainFs.promises;

const MAX_READ = 5 * 1024 * 1024;
const toPosix = (p: string) => p.split('\\').join('/');

/** The project (and checkout root) a path belongs to: a project folder or an agent worktree. */
export function checkoutOf(s: Services, abs: string): { root: string; projectId: string } | undefined {
  for (const a of s.agents.list()) {
    if (a.worktreePath && gitIsInside(a.worktreePath, abs)) {
      const p = s.projects.get(a.projectId);
      if (p && samePath(p.path, a.worktreePath)) continue;
      return { root: a.worktreePath, projectId: a.projectId };
    }
  }
  for (const p of s.projects.list()) if (gitIsInside(p.path, abs)) return { root: p.path, projectId: p.id };
  return undefined;
}

/** files.* — every path goes through ctx.roots (project, worktree or artifact folders). */
export function registerFileHandlers(router: IpcRouter, s: Services, ctx: MainContext): void {
  const rootOf = (root: string) => ctx.roots.assertAllowed(root, ['project', 'worktree', 'artifact']);
  const inRoot = (root: string, rel: string) => {
    const r = rootOf(root);
    const abs = assertInside(r, rel || '.');
    if (toPosix(relative(r, abs)).split('/').includes('.git')) throw new IpcError('The .git folder is not available here', 'forbidden_path');
    return { root: r, abs };
  };

  // Quick-open index and content search (services/file-search.ts), fed by the checkout watchers.
  const index = new FileIndex({ isWatched: (r) => s.git.isWatching(r), log: ctx.log });
  const search = new ContentSearch({ index, emit: (batch) => void ctx.emit('files.searchResults', batch), log: ctx.log });
  s.git.onCheckoutChange((path) => index.invalidate(path));
  ctx.onQuit(() => {
    search.cancelAll();
    index.dispose();
  }, 'files-search');

  router.register('files.tree', async ({ root, dir }) => {
    const { root: r, abs } = inRoot(root, dir);
    let entries;
    try {
      entries = await readdir(abs, { withFileTypes: true });
    } catch (err) {
      throw new IpcError(`Cannot list ${dir || '/'}: ${(err as Error).message}`, 'not_found');
    }
    const out: FileNode[] = [];
    for (const e of entries) {
      if (e.name === '.git') continue;
      const full = join(abs, e.name);
      let kind: FileNode['kind'] | undefined = e.isDirectory() ? 'dir' : e.isFile() ? 'file' : undefined;
      if (e.isSymbolicLink()) {
        if (!isInside(r, full)) continue; // links out of the checkout are not shown
        kind = (await stat(full).catch(() => undefined))?.isDirectory() ? 'dir' : 'file';
      }
      if (!kind) continue;
      out.push({ name: e.name, path: toPosix(relative(r, full)), kind });
    }
    return out.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1));
  });

  router.register('files.read', async ({ root, path }) => {
    const { abs } = inRoot(root, path);
    const st = await stat(abs).catch(() => undefined);
    if (!st?.isFile()) throw new IpcError(`Not a file: ${path}`, 'not_found');
    if (st.size > MAX_READ) return { content: '', binary: true };
    const buf = await readFile(abs);
    if (buf.subarray(0, 8000).includes(0)) return { content: '', binary: true };
    return { content: buf.toString('utf8'), binary: false };
  });

  router.register('files.write', async ({ root, path, content }) => {
    const { root: r, abs } = inRoot(root, path);
    if (!path) throw new IpcError('A file path is required', 'invalid_input');
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, 'utf8');
    index.invalidate(r);
    const co = checkoutOf(s, abs);
    if (co) s.git.changed(co.projectId);
    return { ok: true as const };
  });

  // ---------------------------------------------------------------- quick open, search, replace
  // Roots must be a project or worktree (path guard); results echo the caller's spelling of the root.
  const checkoutRoots = (roots: string[]) => {
    const seen = new Set<string>();
    const out: Array<{ root: string; real: string }> = [];
    for (const root of roots) {
      const real = ctx.roots.assertAllowed(root, ['project', 'worktree']);
      const key = process.platform === 'win32' || process.platform === 'darwin' ? real.toLowerCase() : real;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ root, real });
    }
    return out;
  };
  const regexOf = (o: { query: string; isRegex: boolean; matchCase: boolean; wholeWord: boolean }) => {
    try {
      return buildSearchRegExp(o);
    } catch (err) {
      throw new IpcError(`Invalid regular expression: ${(err as Error).message}`, 'invalid_input');
    }
  };

  router.register('files.findByName', async ({ roots, query, limit, recent }) => {
    const rs = checkoutRoots(roots);
    return index.find({ roots: rs, query, limit, recent });
  });

  router.register('files.searchContent', ({ searchId, roots, query, isRegex, matchCase, wholeWord, include, exclude, maxResults }) => {
    regexOf({ query, isRegex, matchCase, wholeWord });
    const rs = checkoutRoots(roots);
    void search.start({ searchId, roots: rs, query, isRegex, matchCase, wholeWord, include, exclude, maxResults });
    return { ok: true as const };
  });

  router.register('files.cancelSearch', ({ searchId }) => {
    search.cancel(searchId);
    return { ok: true as const };
  });

  router.register('files.replace', async ({ files, query, isRegex, matchCase, wholeWord, replacement }) => {
    regexOf({ query, isRegex, matchCase, wholeWord });
    // Guard every path before touching any file: one bad path refuses the whole request.
    const targets: ReplaceTarget[] = files.map((f) => {
      ctx.roots.assertAllowed(f.root, ['project', 'worktree']);
      const { abs } = inRoot(f.root, f.path);
      if (!f.path) throw new IpcError('A file path is required', 'invalid_input');
      return { root: f.root, path: f.path, abs, hash: f.hash, matches: f.matches };
    });
    const results = await replaceInFiles(targets, { query, isRegex, matchCase, wholeWord }, replacement);
    const projects = new Set<string>();
    for (const [i, r] of results.entries()) {
      if (r.status !== 'replaced') continue;
      const co = checkoutOf(s, targets[i]!.abs);
      if (co) projects.add(co.projectId);
    }
    for (const id of projects) s.git.changed(id);
    return { results };
  });

  router.register('files.history', async ({ root, path }) => {
    const { root: r, abs } = inRoot(root, path);
    return fileHistory(r, toPosix(relative(r, abs)));
  });

  // Agents whose own checkout is changing the same project-relative file (from Edit/Write tool calls).
  router.register('files.editingAgents', ({ path }) => {
    const abs = ctx.roots.assertAllowed(path, ['project', 'worktree']);
    const co = checkoutOf(s, abs);
    return co ? s.agents.editing.agentsFor(abs, co) : [];
  });

  // Artifacts whose content mentions this file (its relative path, or its name when distinctive).
  router.register('files.mentionedIn', async ({ root, path }) => {
    const { root: r, abs } = inRoot(root, path);
    const rel = toPosix(relative(r, abs));
    const name = basename(rel);
    const co = checkoutOf(s, abs);
    const list = await s.artifacts.list(co ? {} : {});
    const out: ArtifactMeta[] = [];
    for (const m of list) {
      if (co && m.projectId && m.projectId !== co.projectId) continue;
      try {
        if (!existsSync(s.artifacts.dirOf(m.id))) continue;
        const { content } = await s.artifacts.read(m.id);
        if (content.includes(rel) || (name.length >= 6 && name.includes('.') && content.includes(name))) out.push(m);
      } catch {
        /* unreadable artifact */
      }
    }
    return out;
  });
}
