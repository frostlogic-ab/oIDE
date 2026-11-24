import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { z } from 'zod';
import { ProjectConfig, ProjectExtensions, ProjectPermissions, ProjectTechniques } from '@oide/protocol';

/**
 * `<repo>/.oide/{config,permissions,techniques,extensions}.json`: project settings a team shares
 * through git. Each file carries `version` and has a JSON Schema in `packages/protocol/schemas/`.
 * Reads never throw: a missing file gives defaults, an invalid one gives defaults plus errors.
 */

export const OIDE_DIR = '.oide';

export const OIDE_FILES = {
  config: { file: 'config.json', schema: ProjectConfig, title: 'oIDE project config' },
  permissions: { file: 'permissions.json', schema: ProjectPermissions, title: 'oIDE project permissions' },
  techniques: { file: 'techniques.json', schema: ProjectTechniques, title: 'oIDE project techniques' },
  extensions: { file: 'extensions.json', schema: ProjectExtensions, title: 'oIDE project extensions' },
} as const;

export type OideFileKind = keyof typeof OIDE_FILES;
export type OideFileValue<K extends OideFileKind> = z.output<(typeof OIDE_FILES)[K]['schema']>;

export interface OideFileRead<T> {
  value: T;
  exists: boolean;
  /** Human-readable problems ("permissions.json: allow.0: expected string"). Empty when fine. */
  errors: string[];
}

export function oideFilePath(repo: string, kind: OideFileKind): string {
  return join(repo, OIDE_DIR, OIDE_FILES[kind].file);
}

function defaults<K extends OideFileKind>(kind: K): OideFileValue<K> {
  return OIDE_FILES[kind].schema.parse({}) as OideFileValue<K>;
}

function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

export function parseOideFile<K extends OideFileKind>(kind: K, text: string): OideFileRead<OideFileValue<K>> {
  const { file, schema } = OIDE_FILES[kind];
  let json: unknown;
  try {
    json = JSON.parse(stripBom(text));
  } catch (e) {
    return { value: defaults(kind), exists: true, errors: [`${file}: invalid JSON: ${(e as Error).message}`] };
  }
  if (json && typeof json === 'object' && 'version' in json && (json as { version: unknown }).version !== 1) {
    return { value: defaults(kind), exists: true, errors: [`${file}: unsupported version ${JSON.stringify((json as { version: unknown }).version)} (this oIDE reads version 1)`] };
  }
  const r = schema.safeParse(json);
  if (!r.success) {
    const errors = r.error.issues.map((i) => `${file}: ${i.path.join('.') || '(root)'}: ${i.message}`);
    return { value: defaults(kind), exists: true, errors };
  }
  let value = r.data as OideFileValue<K>;
  if (kind === 'techniques') {
    // Techniques read from a project are project-scoped and never "built in".
    const t = value as OideFileValue<'techniques'>;
    value = { ...t, techniques: t.techniques.map((x) => ({ ...x, scope: 'project' as const, builtIn: false })) } as OideFileValue<K>;
  }
  return { value, exists: true, errors: [] };
}

export async function readOideFile<K extends OideFileKind>(repo: string, kind: K): Promise<OideFileRead<OideFileValue<K>>> {
  const p = oideFilePath(repo, kind);
  let text: string;
  try {
    text = await readFile(p, 'utf8');
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { value: defaults(kind), exists: false, errors: [] };
    return { value: defaults(kind), exists: existsSync(p), errors: [`${OIDE_FILES[kind].file}: ${(e as Error).message}`] };
  }
  return parseOideFile(kind, text);
}

/** Validate, then write pretty JSON (with `version`) atomically. A `$schema` key already in the file is kept. */
export async function writeOideFile<K extends OideFileKind>(repo: string, kind: K, value: z.input<(typeof OIDE_FILES)[K]['schema']>): Promise<OideFileValue<K>> {
  const { schema } = OIDE_FILES[kind];
  const parsed = schema.parse(value) as OideFileValue<K>;
  const dir = join(repo, OIDE_DIR);
  await mkdir(dir, { recursive: true });
  const p = oideFilePath(repo, kind);
  let schemaRef: unknown;
  try {
    schemaRef = (JSON.parse(stripBom(await readFile(p, 'utf8'))) as { $schema?: unknown }).$schema;
  } catch {
    schemaRef = undefined;
  }
  const body = typeof schemaRef === 'string' ? { $schema: schemaRef, ...(parsed as object) } : parsed;
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(body, null, 2) + '\n', 'utf8');
  await rename(tmp, p);
  return parsed;
}

export interface OideFiles {
  config: ProjectConfig;
  permissions: ProjectPermissions;
  techniques: ProjectTechniques;
  extensions: ProjectExtensions;
  errors: string[];
}

export async function readAllOideFiles(repo: string): Promise<OideFiles> {
  const [config, permissions, techniques, extensions] = await Promise.all([
    readOideFile(repo, 'config'),
    readOideFile(repo, 'permissions'),
    readOideFile(repo, 'techniques'),
    readOideFile(repo, 'extensions'),
  ]);
  return {
    config: config.value,
    permissions: permissions.value,
    techniques: techniques.value,
    extensions: extensions.value,
    errors: [...config.errors, ...permissions.errors, ...techniques.errors, ...extensions.errors],
  };
}
