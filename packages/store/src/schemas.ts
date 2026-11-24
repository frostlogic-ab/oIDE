import { z } from 'zod';
import { OIDE_FILES, type OideFileKind } from './oide-files.js';

/**
 * JSON Schemas for the `.oide/*.json` files, generated from the protocol Zod schemas with
 * zod v4's `z.toJSONSchema` (input side, so fields with defaults are optional). Written to
 * `packages/protocol/schemas/` by `pnpm --filter @oide/store gen:schemas`; a test checks they are current.
 */
export function buildOideSchemas(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const kind of Object.keys(OIDE_FILES) as OideFileKind[]) {
    const { file, schema, title } = OIDE_FILES[kind];
    const json = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
    const props = (json.properties ?? {}) as Record<string, unknown>;
    const doc = {
      $schema: json.$schema,
      title,
      description: `Schema for <repo>/.oide/${file}.`,
      ...json,
      properties: { $schema: { type: 'string', description: 'Optional pointer to this schema, for editors.' }, ...props },
    };
    out[`oide-${kind}.schema.json`] = JSON.stringify(doc, null, 2) + '\n';
  }
  return out;
}
