import { z } from 'zod';

/**
 * Run scripts (Files › project header › Run): the tasks main finds in a checkout's own files
 * (package.json scripts, Makefile targets, Cargo, Go, and so on). The renderer only ever sends a
 * script `id` back; main finds the script again in the same checkout and builds the command line
 * itself (SEC-05: no renderer-chosen command line).
 */
export const SCRIPT_RUNNERS = ['npm', 'pnpm', 'yarn', 'bun', 'deno', 'composer', 'make', 'just', 'cargo', 'go', 'dotnet', 'gradle', 'maven', 'python'] as const;
export const ScriptRunner = z.enum(SCRIPT_RUNNERS);
export type ScriptRunner = z.infer<typeof ScriptRunner>;

export const ProjectScript = z.object({
  /** Stable within a checkout: `<runner>:<file>:<name>`. */
  id: z.string().min(1).max(300),
  /** The script's own name (`build`, `dev:watch`, a make target). */
  name: z.string().min(1).max(200),
  runner: ScriptRunner,
  /** The command line it runs in the terminal, for display (`pnpm run build`). */
  command: z.string(),
  /** The file it came from, relative to the checkout (`package.json`, `Makefile`). */
  file: z.string(),
});
export type ProjectScript = z.infer<typeof ProjectScript>;
