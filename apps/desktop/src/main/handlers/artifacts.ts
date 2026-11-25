import { HTML_DESIGN_ENTRY } from '@oide/protocol';
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
    // An import refused before anything was created carries its reason (telemetry only, never shown).
    const reason = (err as unknown as { reason?: unknown }).reason;
    throw new IpcError(err.message, typeof code === 'string' && !/^E[A-Z]+$/.test(code) ? code : 'artifact_failed', typeof reason === 'string' ? reason : undefined);
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
  router.register('artifacts.save', ({ id, content, note, baseVersion }) => wrap(a.save(id, content, { author: 'user', ...(note ? { note } : {}), ...(baseVersion ? { baseVersion } : {}) })));
  router.register('artifacts.rename', ({ id, title }) => wrap(a.rename(id, title)));
  router.register('artifacts.delete', async ({ id }) => {
    if (!(await wrap(a.delete(id)))) throw new IpcError(`Unknown artifact ${id}`, 'not_found');
    return OK;
  });
  router.register('artifacts.readVersion', async ({ id, version }) => ({ content: await wrap(a.readVersion(id, version)) }));
  // A file import must be a file the user picked with dialog.pickFile or dropped (never an arbitrary
  // renderer path). Main never fetches the link: claude.ai has no public content API and oIDE never uses
  // the user's claude.ai sign-in, so content comes from the user (pasted, or a downloaded file). A link
  // alone is refused (Zod, then the store): nothing is created without the artifact's content.
  router.register('artifacts.import', async ({ url, content, filePath, title, kind, projectId, location }) => {
    if (projectId) s.projects.require(projectId);
    if (location === 'repo' && !projectId) throw new IpcError('Repo artifacts need a project', 'invalid_input');
    if (filePath && content !== undefined) throw new IpcError('Paste the content or pick a file, not both.', 'invalid_input');
    const where = { ...(title ? { title } : {}), ...(kind ? { kind } : {}), ...(projectId ? { projectId } : {}), ...(location ? { location } : {}) };
    let meta;
    if (filePath) {
      if (!wasPicked(s, filePath)) throw new IpcError('Pick the file with the file dialog first.', 'forbidden_path');
      meta = await wrap(a.importFile({ filePath, ...(url ? { url } : {}), ...where }));
    } else if (url) {
      meta = await wrap(a.importUrl({ url, ...(content !== undefined ? { content } : {}), ...where }));
    } else {
      throw new IpcError("Paste the artifact's code or pick the file you downloaded.", 'invalid_input', 'no_content');
    }
    registerRoot(meta.location === 'repo' ? meta.projectId : undefined);
    return meta;
  });
  router.register('artifacts.uses', ({ ids }) => {
    const out: Record<string, ReturnType<typeof a.uses>> = {};
    for (const id of ids) out[id] = a.uses(id);
    return out;
  });
  router.register('artifacts.previewUrl', async ({ id }) => {
    const { meta } = await wrap(a.get(id));
    // A React design (App.jsx) is previewed through a page main generates at index.html (core.ts).
    const page = meta.kind === 'design' ? HTML_DESIGN_ENTRY : ENTRY_FILES[meta.kind];
    return { url: `${ARTIFACT_SCHEME}://${encodeURIComponent(meta.id)}/${page}` };
  });
}
