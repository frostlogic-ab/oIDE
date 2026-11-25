import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TELEMETRY_EVENT_NAMES } from '../packages/protocol/src/index.js';

/** CLAUDE.md: every telemetry event is documented on the wiki page in the same change. */
describe('telemetry docs', () => {
  it('docs/wiki/pages/telemetry.md lists every catalogue event', () => {
    const page = readFileSync(
      fileURLToPath(new URL('../docs/wiki/pages/telemetry.md', import.meta.url)),
      'utf8',
    );
    const missing = TELEMETRY_EVENT_NAMES.filter((n) => !page.includes(`\`${n}\``));
    expect(missing).toEqual([]);
  });
});
