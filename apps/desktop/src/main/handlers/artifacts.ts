import { ENTRY_FILES } from '@oide/store';
import type { MainContext } from '../context.js';
import { IpcError, type IpcRouter } from '../ipc/router.js';
import { ARTIFACT_SCHEME } from '../services/core.js';
import type { Services } from '../services/index.js';
import { wasPicked } from './extensions.js';

const OK = { ok: true as const };

function wrap<T>(p: Promise<T>): Promise<T> {
  return p.catch((err: Error) => {
    if (/^Unknown artifact/.test(err.message)) throw new IpcError(err.message, 'not_found');
    const code = (err as unknown as { code?: unknown }).code;
    throw new IpcError(err.message, typeof code === 'string' && !/^E[A-Z]+$/.test(code) ? code : 'artifact_failed');
  });
}

/** artifacts.* (and the preview URL scheme served by services/electron-platform.ts) */
export function registerArtifactHandlers(router: IpcRouter, s: Services, ctx: MainContext): void {
  const a = s.artifacts;
  const registerRoot = (projectId?: string) => {
    if (projectId) ctx.roots.add(a.root('repo', projectId), 'artifact');
  };
  router.register('artifacts.list', ({ projectId, kind }) => a.list({ ...(projectId ? { projectId } : {}), ...(kind ? { kind } : {}) }));
  router.register('artifacts.get', ({ id }) => wrap(a.get(id)));
  router.register('artifacts.create', async ({ title, kind, projectId, location, content }) => {
    if (projectId) s.projects.require(projectId);
    if (location === 'repo' && !projectId) throw new IpcError('Repo artifacts need a project', 'invalid_input');
    const meta = await wrap(a.create({ title, kind, location, ...(projectId ? { projectId } : {}), ...(content !== undefined ? { content } : {}) }));
    registerRoot(meta.location === 'repo' ? meta.projectId : undefined);
    return meta;
  });
  router.register('artifacts.save', ({ id, content, note }) => wrap(a.save(id, content, { author: 'user', ...(note ? { note } : {}) })));
  router.register('artifacts.delete', async ({ id }) => {
    if (!(await wrap(a.delete(id)))) throw new IpcError(`Unknown artifact ${id}`, 'not_found');
    return OK;
  });
  router.register('artifacts.readVersion', async ({ id, version }) => ({ content: await wrap(a.readVersion(id, version)) }));
  // A file import must be a file the user picked with dialog.pickFile (never an arbitrary renderer path).
  router.register('artifacts.import', async ({ url, filePath, title, kind, projectId, location }) => {
    if (projectId) s.projects.require(projectId);
    const where = { ...(title ? { title } : {}), ...(kind ? { kind } : {}), ...(projectId ? { projectId } : {}), ...(location ? { location } : {}) };
    if (url) return wrap(a.importUrl({ url, ...where }));
    if (!filePath) throw new IpcError('Give a claude.ai link or pick a file', 'invalid_input');
    if (!wasPicked(s, filePath)) throw new IpcError('Pick the file with the file dialog first.', 'forbidden_path');
    return wrap(a.importFile({ filePath, ...where }));
  });
  router.register('artifacts.uses', ({ ids }) => {
    const out: Record<string, ReturnType<typeof a.uses>> = {};
    for (const id of ids) out[id] = a.uses(id);
    return out;
  });
  router.register('artifacts.previewUrl', async ({ id }) => {
    const { meta } = await wrap(a.get(id));
    return { url: `${ARTIFACT_SCHEME}://${encodeURIComponent(meta.id)}/${ENTRY_FILES[meta.kind]}` };
  });
}
