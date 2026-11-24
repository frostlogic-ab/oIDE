// Writes packages/protocol/schemas/oide-*.schema.json. Run: pnpm --filter @oide/store gen:schemas
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildOideSchemas } from '../src/schemas.js';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'protocol', 'schemas');
mkdirSync(outDir, { recursive: true });
for (const [name, text] of Object.entries(buildOideSchemas())) {
  writeFileSync(join(outDir, name), text);
  console.log(`wrote ${join(outDir, name)}`);
}
