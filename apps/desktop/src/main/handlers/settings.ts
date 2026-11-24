import { resolve } from 'node:path';
import { pathKey, samePath } from '@oide/git';
import type { CustomModel, Settings } from '@oide/protocol';
import { BUILTIN_PRESETS, BUILTIN_TECHNIQUES, readOideFile } from '@oide/store';
import { ZodError } from 'zod';
import type { MainContext } from '../context.js';
import { IpcError, type IpcRouter } from '../ipc/router.js';
import { confirmNative } from '../security/confirm.js';
import { boundModelKey, deleteModelKey, endpointOrigin, hasBoundKey, storeModelKey } from '../security/model-keys.js';
import type { Services } from '../services/index.js';

const OK = { ok: true as const };

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
export function registerSettingsHandlers(router: IpcRouter, s: Services, ctx: MainContext): void {
  const svc = s.store.settings;
  const withKeys = (st: Settings): Settings => ({ ...st, models: { ...st.models, custom: st.models.custom.map((m) => ({ ...m, hasKey: hasBoundKey(s.secrets, m) })) } });
  const project = (id: string) => s.projects.require(id);

  router.register('settings.get', () => withKeys(svc.get()));
  router.register('settings.update', async ({ patch }) => {
    await confirmExecSettings(s, ctx, patch);
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
  // SEC-09: a key is bound to the endpoint origin it was entered for; pointing the model at another
  // origin without a new key in the same call deletes the old one.
  router.register('settings.saveCustomModel', ({ model, apiKey }) => {
    const prev = svc.get().models.custom.find((m) => m.id === model.id);
    if (apiKey !== undefined && apiKey !== '') {
      try {
        storeModelKey(s.secrets, model, apiKey);
      } catch (err) {
        throw new IpcError((err as Error).message, /valid base URL/.test((err as Error).message) ? 'invalid_input' : 'secure_storage_unavailable');
      }
    } else if (prev && endpointOrigin(prev) !== endpointOrigin(model)) {
      deleteModelKey(s.secrets, model.id);
    }
    const list = svc.get().models.custom.filter((m) => m.id !== model.id);
    const saved: CustomModel = { ...model, hasKey: hasBoundKey(s.secrets, model) };
    svc.update({ models: { custom: [...list, saved] } });
    return saved;
  });
  router.register('settings.deleteCustomModel', ({ id }) => {
    deleteModelKey(s.secrets, id);
    svc.update({ models: { custom: svc.get().models.custom.filter((m) => m.id !== id) } });
    return OK;
  });
  router.register('settings.testCustomModel', ({ id }) => {
    const m = svc.get().models.custom.find((x) => x.id === id);
    if (!m) throw new IpcError(`Unknown custom model ${id}`, 'not_found');
    return testCustomModel(m, boundModelKey(s.secrets, m), s.platform.fetch);
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

/**
 * SEC-07: settings that make main execute something (the CLI path, which `cli.detect` runs at once;
 * extra CLI flags, passed to every agent) are changed from the renderer only after a native
 * confirmation in main that shows the exact value. A CLI path the user picked in the file dialog
 * this session needs no second confirmation. Clearing either value needs none.
 */
export async function confirmExecSettings(s: Services, ctx: MainContext, patch: Record<string, unknown>): Promise<void> {
  const claude = patch.claude;
  if (!claude || typeof claude !== 'object') return;
  const cur = s.store.settings.get().claude;
  const c = claude as { cliPath?: unknown; extraFlags?: unknown };
  if (typeof c.cliPath === 'string' && c.cliPath.trim() && c.cliPath !== cur.cliPath) {
    const picked = s.picked.has(pathKey(resolve(c.cliPath)));
    const ok =
      picked ||
      (await confirmNative(ctx, {
        title: 'Use this Claude Code CLI?',
        message: 'oIDE will run this program as the Claude Code CLI for every agent.',
        detail: `${c.cliPath}\n\nOnly continue if you typed or chose this path yourself.`,
        confirmLabel: 'Use this CLI',
        danger: true,
      }));
    if (!ok) throw new IpcError('The CLI path was not changed.', 'forbidden');
  }
  if (typeof c.extraFlags === 'string' && c.extraFlags.trim() && c.extraFlags.trim() !== cur.extraFlags.trim()) {
    const ok = await confirmNative(ctx, {
      title: 'Pass these flags to every agent?',
      message: 'oIDE will add these extra flags to every Claude Code agent it starts.',
      detail: `${c.extraFlags}\n\nFlags that would change oIDE's own settings, MCP servers, permissions or directories are ignored.`,
      confirmLabel: 'Use these flags',
      danger: true,
    });
    if (!ok) throw new IpcError('The extra CLI flags were not changed.', 'forbidden');
  }
}
