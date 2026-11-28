import { z } from 'zod';

/**
 * Files › package.json: the latest published version of each dependency, from the public npm
 * registry (wiki: screen-files.md › Dependency versions). Main does the lookup; the renderer only
 * sends package names (never versions, paths or file content) and the file the names came from, so
 * main can honour the project's `.npmrc` registry settings.
 */

/** An npm package name (lower case, optional `@scope/`, at most 214 characters). */
export const NpmPackageName = z
  .string()
  .max(214)
  .regex(/^(?:@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/);
export type NpmPackageName = z.infer<typeof NpmPackageName>;

/** A version as published (`5.3.0`, `2.0.0-alpha.21`). Anything else from the registry is dropped. */
export const NpmVersion = z
  .string()
  .max(256)
  .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);

/** Most dependency names one lookup takes (a big monorepo root lists a few hundred). */
export const DEPENDENCY_LOOKUP_MAX = 500;

export const DependencyVersionsInput = z.object({
  root: z.string(),
  /** The package.json the names come from, relative to `root`. */
  path: z.string().min(1).max(1024),
  names: z.array(NpmPackageName).max(DEPENDENCY_LOOKUP_MAX),
});
export type DependencyVersionsInput = z.infer<typeof DependencyVersionsInput>;

/** One package's dist-tags: `latest` plus other channels (`next`, `beta`…), at most 20. */
export const PackageVersions = z.object({
  latest: NpmVersion,
  tags: z.record(z.string().max(64), NpmVersion),
});
export type PackageVersions = z.infer<typeof PackageVersions>;

export const DependencyVersions = z.object({
  /**
   * `ok`: looked up. `off`: Settings › Privacy turned the lookups off. `private-registry`: the
   * project's `.npmrc` points every package at another registry, so nothing was asked.
   */
  status: z.enum(['ok', 'off', 'private-registry']),
  /**
   * Name → versions; `null` when the public registry does not have it (private, unpublished, or
   * the lookup failed). Scopes the `.npmrc` sends to another registry are left out.
   */
  packages: z.record(z.string(), PackageVersions.nullable()),
});
export type DependencyVersions = z.infer<typeof DependencyVersions>;
