import type { CustomModel } from '@oide/protocol';
import type { SecretStore } from '@oide/store';

/**
 * Custom model keys are bound to the endpoint origin they were entered for (review-security
 * SEC-09). A key is only handed out (to "Test connection" or an agent's env) while the model's
 * base URL still has that origin; re-pointing the model elsewhere, through `saveCustomModel` or a
 * raw `settings.update`, makes the key unusable until the user enters it again.
 */
export const modelKey = (id: string) => `model:${id}`;
const originKey = (id: string) => `model:${id}:origin`;

/** The origin a key is bound to: the base URL's origin, or the provider for cloud providers. */
export function endpointOrigin(model: Pick<CustomModel, 'provider' | 'baseUrl'>): string | undefined {
  if (model.provider === 'bedrock' || model.provider === 'vertex') return `provider:${model.provider}`;
  try {
    return new URL(model.baseUrl ?? '').origin.toLowerCase();
  } catch {
    return undefined;
  }
}

type Secrets = Pick<SecretStore, 'get' | 'set' | 'delete' | 'has'>;

export function storeModelKey(secrets: Secrets, model: CustomModel, key: string): void {
  const origin = endpointOrigin(model);
  if (!origin) throw new Error('Add a valid base URL before saving a key.');
  secrets.set(modelKey(model.id), key);
  secrets.set(originKey(model.id), origin);
}

export function deleteModelKey(secrets: Secrets, id: string): void {
  secrets.delete(modelKey(id));
  secrets.delete(originKey(id));
}

/** The stored key, only while the model still points at the origin it was entered for. */
export function boundModelKey(secrets: Secrets, model: CustomModel): string | undefined {
  const key = secrets.get(modelKey(model.id));
  if (key === undefined) return undefined;
  const bound = secrets.get(originKey(model.id));
  const now = endpointOrigin(model);
  return bound !== undefined && now !== undefined && bound === now ? key : undefined;
}

export function hasBoundKey(secrets: Secrets, model: CustomModel): boolean {
  return boundModelKey(secrets, model) !== undefined;
}
