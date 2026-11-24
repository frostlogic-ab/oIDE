import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

export const newId = (): string => randomUUID();

/** Case-folded absolute path key (Windows and macOS file systems are case-insensitive by default). */
export function pathKey(p: string): string {
  let r = resolve(p);
  if (r.length > 1 && /[\\/]$/.test(r)) r = r.slice(0, -1);
  return process.platform === 'win32' || process.platform === 'darwin' ? r.toLowerCase() : r;
}

/** `undefined` for SQL NULL. */
export function opt<T>(v: T | null | undefined): T | undefined {
  return v === null ? undefined : v;
}

export type Row = Record<string, unknown>;

export function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}
export function num(v: unknown): number | undefined {
  return typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : undefined;
}
