import { createHash } from 'node:crypto';
import type { CustomModel } from '@oide/protocol';
import type { SecretStore } from '@oide/store';

/**
 * Custom model keys are bound to what they were entered for (review-security SEC-09, SEC-30): the
 * endpoint origin, the provider and the model's whole `extraEnv` (a proxy, a CA bundle or
 * `NODE_TLS_REJECT_UNAUTHORIZED` would otherwise let the key leave through the same origin). A key
 * is only handed out (to "Test connection" or an agent's env) while all three are unchanged;
 * changing any of them, through `saveCustomModel` or a raw `settings.update`, makes the key
 * unusable until the user enters it again. Keys stored before SEC-30 (origin only) must be
 * entered again.
 */
export const modelKey = (id: string) => `model:${id}`;
const bindingKey = (id: string) => `model:${id}:binding`;
/** Pre-SEC-30 slot (origin only); never read, deleted with the key. */
const legacyOriginKey = (id: string) => `model:${id}:origin`;

/** The origin a key is bound to: the base URL's origin, or the provider for cloud providers. */
export function endpointOrigin(model: Pick<CustomModel, 'provider' | 'baseUrl'>): string | undefined {
  if (model.provider === 'bedrock' || model.provider === 'vertex') return `provider:${model.provider}`;
  try {
    return new URL(model.baseUrl ?? '').origin.toLowerCase();
  } catch {
    return undefined;
  }
}

/** SHA-256 over origin, provider and the sorted `extraEnv` (names and values); undefined without an origin. */
export function modelBinding(model: Pick<CustomModel, 'provider' | 'baseUrl' | 'extraEnv'>): string | undefined {
  const origin = endpointOrigin(model);
  if (!origin) return undefined;
  const env = Object.entries(model.extraEnv ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return createHash('sha256')
    .update(JSON.stringify(['oide-model-key/v1', origin, model.provider, env]))
    .digest('hex');
}

type Secrets = Pick<SecretStore, 'get' | 'set' | 'delete' | 'has'>;

export function storeModelKey(secrets: Secrets, model: CustomModel, key: string): void {
  const binding = modelBinding(model);
  if (!binding) throw new Error('Add a valid base URL before saving a key.');
  secrets.set(modelKey(model.id), key);
  secrets.set(bindingKey(model.id), binding);
  secrets.delete(legacyOriginKey(model.id));
}

export function deleteModelKey(secrets: Secrets, id: string): void {
  secrets.delete(modelKey(id));
  secrets.delete(bindingKey(id));
  secrets.delete(legacyOriginKey(id));
}

/** The stored key, only while origin, provider and extraEnv are exactly what it was entered for. */
export function boundModelKey(secrets: Secrets, model: CustomModel): string | undefined {
  const key = secrets.get(modelKey(model.id));
  if (key === undefined) return undefined;
  const bound = secrets.get(bindingKey(model.id));
  const now = modelBinding(model);
  return bound !== undefined && now !== undefined && bound === now ? key : undefined;
}

export function hasBoundKey(secrets: Secrets, model: CustomModel): boolean {
  return boundModelKey(secrets, model) !== undefined;
}
