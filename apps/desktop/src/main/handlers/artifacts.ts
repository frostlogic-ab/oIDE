import { classifyClaudeLink, type ArtifactMeta } from '@oide/protocol';
import type { MainContext } from '../context.js';
import { IpcError, type IpcRouter } from '../ipc/router.js';
import { previewUrlOf } from '../services/artifact-preview.js';
import type { Services } from '../services/index.js';
import { wasPicked } from './extensions.js';

const OK = { ok: true as const };

function wrap<T>(p: Promise<T>): Promise<T> {
  return p.catch((err: Error) => {
    if (err instanceof IpcError) throw err;
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
  const registerRoot = (meta: ArtifactMeta) => {
    if (meta.location === 'repo' && meta.projectId) ctx.roots.add(a.root('repo', meta.projectId), 'artifact');
  };
  const metaOf = (id: string): ArtifactMeta => {
    try {
      return a.metaOf(id);
    } catch {
      throw new IpcError(`Unknown artifact ${id}`, 'not_found');
    }
  };
  const needsRepoProject = (location: string | undefined, projectId: string | undefined) => {
    if (location === 'repo' && !projectId) throw new IpcError('Repo artifacts need a project', 'invalid_input');
  };
  router.register('artifacts.list', ({ projectId, kind }) => a.list({ ...(projectId ? { projectId } : {}), ...(kind ? { kind } : {}) }));
  router.register('artifacts.get', ({ id }) => wrap(a.get(id)));
  router.register('artifacts.create', async ({ title, kind, projectId, location, content }) => {
    if (projectId) s.projects.require(projectId);
    needsRepoProject(location, projectId);
    const meta = await wrap(a.create({ title, kind, location, ...(projectId ? { projectId } : {}), ...(content !== undefined ? { content } : {}) }));
    registerRoot(meta);
    return meta;
  });
  router.register('artifacts.save', ({ id, content, note, baseVersion }) => wrap(a.save(id, content, { author: 'user', ...(note ? { note } : {}), ...(baseVersion ? { baseVersion } : {}) })));
  router.register('artifacts.rename', ({ id, title }) => wrap(a.rename(id, title)));
  router.register('artifacts.delete', async ({ id }) => {
    // A running retrieval stops first, so its agent does not hand files to an artifact that is gone.
    if (metaOf(id).retrieval?.status === 'retrieving') await s.retrieval.cancel(id).catch(() => undefined);
    if (!(await wrap(a.delete(id)))) throw new IpcError(`Unknown artifact ${id}`, 'not_found');
    return OK;
  });
  router.register('artifacts.restore', ({ id, version, baseVersion }) => wrap(a.restore(id, version, { author: 'user', ...(baseVersion !== undefined ? { baseVersion } : {}) })));
  router.register('artifacts.readVersion', async ({ id, version }) => ({ content: await wrap(a.readVersion(id, version)) }));
  // A file import must be a file the user picked with dialog.pickFile or dropped (never an arbitrary
  // renderer path). Main never fetches the link: claude.ai has no public content API and oIDE never uses
  // the user's claude.ai sign-in, so pasted content comes from the user; a link alone goes through
  // artifacts.importLink (an agent retrieves it, ADR 0014).
  router.register('artifacts.import', async ({ url, content, filePath, title, kind, projectId, location }) => {
    if (projectId) s.projects.require(projectId);
    needsRepoProject(location, projectId);
    if (filePath && content !== undefined) throw new IpcError('Paste the content or pick a file, not both.', 'invalid_input');
    const where = { ...(title ? { title } : {}), ...(kind ? { kind } : {}), ...(projectId ? { projectId } : {}), ...(location ? { location } : {}) };
    let meta;
    if (filePath) {
      if (!wasPicked(s, filePath)) throw new IpcError('Pick the file with the file dialog first.', 'forbidden_path');
      meta = await wrap(a.importFile({ filePath, ...(url ? { url } : {}), ...where }));
    } else if (url || content !== undefined) {
      meta = await wrap(a.importUrl({ ...(url ? { url } : {}), ...(content !== undefined ? { content } : {}), ...where }));
    } else {
      throw new IpcError("Paste the artifact's code or pick the file you downloaded.", 'invalid_input', 'no_content');
    }
    registerRoot(meta);
    return meta;
  });
  router.register('artifacts.uses', ({ ids }) => {
    const out: Record<string, ReturnType<typeof a.uses>> = {};
    for (const id of ids) out[id] = a.uses(id);
    return out;
  });
  router.register('artifacts.previewUrl', async ({ id }) => {
    const { meta } = await wrap(a.get(id));
    // Each path segment encoded, so relative links resolve; a React design opens on the generated page.
    return { url: previewUrlOf(meta) };
  });

  // ------------------------------------------------------------ multi-file artifacts (ADR 0014)

  // A link becomes an artifact at version 0 and an agent (the user's own CLI) retrieves its files.
  // Main never downloads it. The link is checked before anything is created.
  router.register('artifacts.importLink', async ({ url, title, kind, projectId, location }) => {
    const link = classifyClaudeLink(url);
    if (!link.ok) throw new IpcError(link.reason, 'invalid_input', 'bad_link');
    s.projects.require(projectId);
    const meta = await wrap(a.createLinked({ url: link.url, ...(title ? { title } : {}), ...(kind ? { kind } : {}), projectId, location }));
    registerRoot(meta);
    try {
      return await s.retrieval.start(meta.id, 'import', projectId);
    } catch (err) {
      // The artifact exists: show why its agent could not start (Retry and Delete are there).
      ctx.log.warn('artifact retrieval could not start', err);
      return wrap(a.setRetrieval(meta.id, { status: 'failed', trigger: 'import', startedAt: Date.now(), finishedAt: Date.now(), error: (err as Error).message.slice(0, 2000) }));
    }
  });
  // Update (or Retry): a new agent retrieves the link again; the result is the next version. This is
  // also how an old link-only import (brokenImport) gets its content.
  router.register('artifacts.refresh', async ({ id, projectId }) => {
    const meta = metaOf(id);
    if (!meta.importedFrom || !classifyClaudeLink(meta.importedFrom).ok) throw new IpcError('This artifact has no claude.ai link to retrieve it from.', 'invalid_input', 'needs_link');
    if (meta.retrieval?.status === 'retrieving') throw new IpcError(`${meta.title} is already being retrieved.`, 'busy');
    const where = (meta.projectId && s.projects.get(meta.projectId) ? meta.projectId : undefined) ?? projectId;
    if (!where) throw new IpcError('Choose the project the retrieval agent works in.', 'needs_project');
    s.projects.require(where);
    const trigger = meta.retrieval?.status === 'failed' || meta.version === 0 ? 'retry' : 'update';
    return wrap(s.retrieval.start(id, trigger, where));
  });
  router.register('artifacts.cancelRetrieval', ({ id }) => wrap(s.retrieval.cancel(id)));
  // The artifact agent: edits this artifact only, in an empty folder of its own (services/artifact-agent.ts).
  router.register('artifacts.startAgent', ({ id, projectId, text, attachments, mode, model }) =>
    s.artifactAgents.start({ id, text, ...(projectId ? { projectId } : {}), ...(attachments?.length ? { attachments } : {}), ...(mode ? { mode } : {}), ...(model ? { model } : {}) }),
  );
  router.register('artifacts.files', ({ id, version }) => wrap(a.files(id, version)));
  router.register('artifacts.readFile', ({ id, path, version }) => wrap(a.readFile(id, path, version)));
  router.register('artifacts.writeFiles', ({ id, files, deletes, entry, note, baseVersion }) =>
    wrap(a.writeFiles(id, { files, deletes, author: 'user', ...(entry ? { entry } : {}), ...(note ? { note } : {}), ...(baseVersion !== undefined ? { baseVersion } : {}) })),
  );
  // Only paths picked (dialog.pickArtifactFiles, dialog.pickFile) or dropped in this session.
  router.register('artifacts.importFiles', async ({ filePaths, folderPath, entry, url, title, kind, projectId, location }) => {
    if (projectId) s.projects.require(projectId);
    needsRepoProject(location, projectId);
    if (folderPath && filePaths.length) throw new IpcError('Pick files or a folder, not both.', 'invalid_input');
    for (const p of [...filePaths, ...(folderPath ? [folderPath] : [])]) {
      if (!wasPicked(s, p)) throw new IpcError('Pick the files with the file dialog, or drop them, first.', 'forbidden_path');
    }
    const meta = await wrap(
      a.importFiles({
        ...(folderPath ? { folderPath } : { filePaths }),
        ...(entry ? { entry } : {}),
        ...(url ? { url } : {}),
        ...(title ? { title } : {}),
        ...(kind ? { kind } : {}),
        ...(projectId ? { projectId } : {}),
        location,
      }),
    );
    registerRoot(meta);
    return meta;
  });
}
