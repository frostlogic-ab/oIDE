import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentSpecInput } from '@oide/protocol';

const made: string[] = [];

export function tempDir(prefix = 'oide-store-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  made.push(d);
  return d;
}

export function cleanup(): void {
  for (const d of made.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // Windows can keep a WAL handle for a moment.
    }
  }
}

export function spec(projectId: string, title = 'Fix the flaky test'): AgentSpecInput {
  return { projectId, title, goal: 'Make it green', strategy: { kind: 'single', lead: { model: 'opus' } } };
}
