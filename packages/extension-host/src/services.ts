import type { AgentInfo, ArtifactContent, SettingValue } from '@oide/extension-api';
import type { InstalledExtension } from '@oide/protocol';
import type { HostServices } from './host-client.js';
import type { MaybePromise, SecretStore, SettingsStore } from './interfaces.js';

export interface HostServicesDeps {
  /** Look up an installed extension by name (for its manifest's settings and enable state). */
  extension(name: string): InstalledExtension | undefined;
  isEnabledFor(ext: InstalledExtension, projectId: string): MaybePromise<boolean>;
  settings: SettingsStore;
  secrets: SecretStore;
  /** All agents; filtered here to projects where the extension is enabled. */
  listAgents(): MaybePromise<AgentInfo[]>;
  postMessage(agentId: string, text: string): MaybePromise<void>;
  openPanel(ext: string, panelId: string, opts: { agentId?: string; projectId?: string }): MaybePromise<void>;
  postPanelMessage(ext: string, panelId: string, data: unknown): MaybePromise<void>;
  readArtifact(id: string): MaybePromise<ArtifactContent>;
  log(ext: string, level: 'debug' | 'info' | 'warn' | 'error', message: string): void;
}

/** Keychain key of an extension's secret setting. Scoped per extension. */
export function extensionSecretKey(ext: string, key: string): string {
  return `extension/${ext}/${key}`;
}

/** Settings key of an extension's plain setting. */
export function extensionSettingKey(ext: string, key: string): string {
  return `extensions.${ext}.${key}`;
}

/**
 * Default HostServices: settings namespaced per extension (secret ones in the keychain), agents
 * and events limited to projects where the extension is enabled.
 */
export function createHostServices(d: HostServicesDeps): HostServices {
  const ext = (name: string) => {
    const e = d.extension(name);
    if (!e) throw new Error(`unknown extension ${name}`);
    return e;
  };
  const isSecret = (e: InstalledExtension, key: string) => e.manifest.oide.contributes.settings[key]?.secret === true;
  const agentProjectAllowed = async (e: InstalledExtension, agentId: string) => {
    const a = (await d.listAgents()).find((x) => x.id === agentId);
    return a ? d.isEnabledFor(e, a.projectId) : false;
  };
  return {
    async settingsGet(name, key) {
      const e = ext(name);
      if (isSecret(e, key)) return d.secrets.get(extensionSecretKey(name, key));
      const v = await d.settings.get(extensionSettingKey(name, key));
      if (v !== undefined) return v as SettingValue;
      return e.manifest.oide.contributes.settings[key]?.default as SettingValue | undefined;
    },
    async settingsSet(name, key, value) {
      const e = ext(name);
      const decl = e.manifest.oide.contributes.settings[key];
      if (decl && value !== null && typeof value !== decl.type) throw new Error(`${key} must be a ${decl.type}`);
      if (isSecret(e, key)) {
        if (value === null) await d.secrets.delete(extensionSecretKey(name, key));
        else await d.secrets.set(extensionSecretKey(name, key), String(value));
        return;
      }
      await d.settings.set(extensionSettingKey(name, key), value);
    },
    async listAgents(name, filter) {
      const e = ext(name);
      const out: AgentInfo[] = [];
      for (const a of await d.listAgents()) {
        if (filter.projectId && a.projectId !== filter.projectId) continue;
        if (await d.isEnabledFor(e, a.projectId)) out.push(a);
      }
      return out;
    },
    async postMessage(name, agentId, text) {
      if (!(await agentProjectAllowed(ext(name), agentId))) throw new Error('agent not found');
      await d.postMessage(agentId, text);
    },
    openPanel: (name, panelId, opts) => d.openPanel(name, panelId, opts),
    postPanelMessage: (name, panelId, data) => d.postPanelMessage(name, panelId, data),
    readArtifact: (_name, id) => d.readArtifact(id),
    canSeeProject: (name, projectId) => d.isEnabledFor(ext(name), projectId),
    log: d.log,
  };
}
