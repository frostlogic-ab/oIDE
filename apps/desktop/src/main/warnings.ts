/**
 * Imported first by src/main/index.ts (ESM evaluates imports in order), before anything can load
 * `node:sqlite`. Suppresses only the node:sqlite ExperimentalWarning; every other warning passes.
 */
const originalEmitWarning = process.emitWarning.bind(process);

function warningType(warning: string | Error, rest: unknown[]): string | undefined {
  const first = rest[0];
  if (typeof first === 'string') return first;
  if (first && typeof first === 'object' && 'type' in first) return String((first as { type?: unknown }).type);
  return warning instanceof Error ? warning.name : undefined;
}

process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const message = typeof warning === 'string' ? warning : warning.message;
  if (warningType(warning, rest) === 'ExperimentalWarning' && /sqlite/i.test(message)) return;
  return (originalEmitWarning as (...args: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;

export {};
