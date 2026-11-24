import { samePath } from '@oide/git';
import type { CustomModel, Settings } from '@oide/protocol';
import { BUILTIN_PRESETS, BUILTIN_TECHNIQUES, readOideFile } from '@oide/store';
import { ZodError } from 'zod';
import type { MainContext } from '../context.js';
import { IpcError, type IpcRouter } from '../ipc/router.js';
import type { Services } from '../services/index.js';

const OK = { ok: true as const };
const modelKey = (id: string) => `model:${id}`;

/** Never Anthropic's API on the user's plan: a custom endpoint test only talks to third-party hosts. */
export function isAnthropicHost(url: string): boolean {
  try {
    const h = new URL(url).hostname.toLowerCase();
    // SEC-19: every Anthropic-operated domain, so a typo in a custom endpoint cannot reach one.
    return ['anthropic.com', 'claude.ai', 'claude.com'].some((d) => h === d || h.endsWith(`.${d}`));
  } catch {
    return false;
  }
}

/** A minimal request to a custom model endpoint (`POST <base>/v1/messages`, 1 token). */
export async function testCustomModel(model: CustomModel, key: string | undefined, fetchFn: typeof fetch = fetch): Promise<{ ok: boolean; detail: string }> {
  if (model.provider === 'bedrock' || model.provider === 'vertex') {
    return { ok: false, detail: `${model.provider === 'bedrock' ? 'Bedrock' : 'Vertex'} uses your cloud credentials, which oIDE does not read. Spawn an agent with this model to check it.` };
  }
  if (!model.baseUrl) return { ok: false, detail: 'Add a base URL first.' };
  if (isAnthropicHost(model.baseUrl)) return { ok: false, detail: "oIDE never calls Anthropic's API directly; Claude models go through the Claude Code CLI." };
  let url: URL;
  try {
    url = new URL(model.baseUrl.replace(/\/+$/, '') + '/v1/messages');
  } catch {
    return { ok: false, detail: 'The base URL is not a valid URL.' };
  }
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return { ok: false, detail: 'Use https (plain http is only allowed for localhost).' };
  try {
    const res = await fetchFn(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        ...(key ? { 'x-api-key': key, authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify({ model: model.model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }),
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) return { ok: true, detail: `Connected: ${url.host} answered for ${model.model}.` };
    const text = (await res.text().catch(() => '')).slice(0, 200).replace(/\s+/g, ' ');
    return { ok: false, detail: `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}${text ? `: ${text}` : ''}` };
  } catch (err) {
    return { ok: false, detail: `Could not reach ${url.host}: ${(err as Error).message}` };
  }
}

/** settings.* and usage.summary */
export function registerSettingsHandlers(router: IpcRouter, s: Services, _ctx: MainContext): void {
  const svc = s.store.settings;
  const withKeys = (st: Settings): Settings => ({ ...st, models: { ...st.models, custom: st.models.custom.map((m) => ({ ...m, hasKey: s.secrets.has(modelKey(m.id)) })) } });
  const project = (id: string) => s.projects.require(id);

  router.register('settings.get', () => withKeys(svc.get()));
  router.register('settings.update', ({ patch }) => {
    try {
      return withKeys(svc.update(patch));
    } catch (err) {
      if (err instanceof ZodError) throw new IpcError(`Invalid settings: ${err.issues[0]?.path.join('.')}: ${err.issues[0]?.message}`, 'invalid_input');
      throw err;
    }
  });
  router.register('settings.techniques', async ({ projectId }) => {
    if (!projectId) return svc.get().techniques;
    const p = project(projectId);
    return (await svc.forProject(p.path, { trusted: p.trusted })).techniques;
  });
  router.register('settings.saveTechnique', ({ technique, projectId }) => svc.saveTechnique(technique, projectId ? project(projectId).path : undefined));
  router.register('settings.deleteTechnique', async ({ id, projectId }) => {
    try {
      await svc.deleteTechnique(id, projectId ? project(projectId).path : undefined);
    } catch (err) {
      throw new IpcError((err as Error).message, 'forbidden');
    }
    return OK;
  });
  // The key goes to the keychain store only and never comes back over IPC (hasKey says it exists).
  router.register('settings.saveCustomModel', ({ model, apiKey }) => {
    if (apiKey !== undefined && apiKey !== '') {
      try {
        s.secrets.set(modelKey(model.id), apiKey);
      } catch (err) {
        throw new IpcError((err as Error).message, 'secure_storage_unavailable');
      }
    }
    const list = svc.get().models.custom.filter((m) => m.id !== model.id);
    const saved: CustomModel = { ...model, hasKey: s.secrets.has(modelKey(model.id)) };
    svc.update({ models: { custom: [...list, saved] } });
    return saved;
  });
  router.register('settings.deleteCustomModel', ({ id }) => {
    s.secrets.delete(modelKey(id));
    svc.update({ models: { custom: svc.get().models.custom.filter((m) => m.id !== id) } });
    return OK;
  });
  router.register('settings.testCustomModel', ({ id }) => {
    const m = svc.get().models.custom.find((x) => x.id === id);
    if (!m) throw new IpcError(`Unknown custom model ${id}`, 'not_found');
    return testCustomModel(m, s.secrets.get(modelKey(id)), s.platform.fetch);
  });
  router.register('settings.projectPermissions', async ({ projectId }) => {
    const f = await readOideFile(project(projectId).path, 'permissions');
    return { allow: f.value.allow, ask: f.value.ask, deny: f.value.deny };
  });
  router.register('settings.saveProjectPermissions', async ({ projectId, allow, ask, deny }) => {
    await svc.saveProjectPermissions(project(projectId).path, { allow, ask, deny });
    return OK;
  });
  router.register('settings.builtIns', () => ({ presets: structuredClone(BUILTIN_PRESETS), techniques: structuredClone(BUILTIN_TECHNIQUES) }));
  router.register('settings.loadErrors', async ({ projectId }) => {
    const out: Array<{ projectId?: string; file: string; message: string }> = svc.loadErrors.map((message) => ({ file: 'settings', message }));
    const projects = projectId ? [project(projectId)] : s.projects.list();
    for (const p of projects) {
      const eff = await svc.forProject(p.path, { trusted: p.trusted }).catch(() => undefined);
      for (const message of eff?.errors ?? []) out.push({ projectId: p.id, file: /(\.oide[\\/][\w.-]+\.json)/.exec(message)?.[1] ?? '.oide', message });
    }
    return out;
  });

  router.register('usage.summary', () => {
    const agents = s.agents.list();
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const resets = agents.flatMap((a) => (a.status === 'rate-limited' && a.rateLimitResetAt ? [a.rateLimitResetAt] : []));
    return {
      sessions: agents.filter((a) => !['stopped', 'error', 'done'].includes(a.status)).length,
      worktrees: agents.filter((a) => {
        const p = s.projects.get(a.projectId);
        return a.worktreePath && p && !samePath(p.path, a.worktreePath);
      }).length,
      subagentsActive: agents.reduce((n, a) => n + a.subagents.filter((x) => x.status === 'running' || x.status === 'needs-permission').length, 0),
      projectsOpen: s.projects.list().length,
      tokensToday: s.store.usage.totals({ since: start.getTime() }).total,
      ...(resets.length ? { rateLimitResetAt: Math.min(...resets) } : {}),
    };
  });
}
