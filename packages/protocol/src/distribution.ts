/**
 * Where oIDE's distribution channels live: the marketplace index, the update feed and the built-in
 * extension packages. One module, so nothing else hard-codes an org, a repo or an npm scope.
 * See docs/wiki/pages/packaging.md and docs/wiki/pages/marketplace.md.
 *
 * Safe defaults until the maintainer has claimed the names (review-publication §3):
 * - The GitHub org `oide-dev` is not claimed yet. Whoever registers it first would control any URL
 *   under it, so no default fetches from it: the marketplace uses the index bundled with the app
 *   unless the user sets Settings › Extensions › Marketplace index URL (main asks for a native
 *   confirmation first), and the updater is off unless the build was given a publish owner and repo
 *   (`OIDE_PUBLISH_OWNER` / `OIDE_PUBLISH_REPO` at build time, set by the release workflow).
 * - The npm scope `@oide` belongs to someone else. Built-in extensions ship inside the app
 *   (`source: 'builtin'`); their index entries carry a `oide-builtin:` pseudo URL, never an npm one,
 *   and the installer never downloads them.
 */

/**
 * The GitHub owner and repos the maintainer intends to use. NOT CLAIMED YET: these are names for
 * docs and the owner checklist only. Runtime code must not build a fetch URL from them.
 */
export const PLANNED_GITHUB_OWNER = 'oide-dev';
export const PLANNED_APP_REPO = 'oide';
export const PLANNED_MARKETPLACE_REPO = 'oide-marketplace';
/** The index URL to configure once `oide-dev/oide-marketplace` exists (documentation only). */
export const PLANNED_MARKETPLACE_INDEX_URL = `https://raw.githubusercontent.com/${PLANNED_GITHUB_OWNER}/${PLANNED_MARKETPLACE_REPO}/main/index.json`;

/** Settings › Extensions › Marketplace index URL default: empty, so only the bundled index is used. */
export const DEFAULT_MARKETPLACE_INDEX_URL = '';

/** Scheme of the pseudo tarball URLs of built-in extensions. Never fetched. */
export const BUILTIN_TARBALL_SCHEME = 'oide-builtin:';

/** Index "tarball" of a built-in extension: it ships inside the app, so this is not a download URL. */
export function builtinTarballUrl(name: string, version: string): string {
  return `${BUILTIN_TARBALL_SCHEME}${name}@${version}`;
}

export function isBuiltinTarballUrl(url: string): boolean {
  return url.startsWith(BUILTIN_TARBALL_SCHEME);
}

/** A remote marketplace index URL is https only, with no `user:password@` part. Returns the problem, if any. */
export function marketplaceIndexUrlProblem(url: string): string | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return 'The marketplace index URL is not a valid URL.';
  }
  if (u.protocol !== 'https:') return 'The marketplace index URL must start with https://.';
  if (u.username || u.password) return 'The marketplace index URL may not contain a user name or password.';
  return undefined;
}

/** GitHub owner and repo names (what GitHub accepts; no slashes, dots-only or empty names). */
const GITHUB_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const GITHUB_REPO = /^(?!\.+$)[A-Za-z0-9._-]{1,100}$/;

export interface PublishTarget {
  owner: string;
  repo: string;
  /** `https://github.com/<owner>/<repo>/releases` */
  releasesUrl: string;
}

/**
 * The GitHub Releases feed this build updates from, or null when the build was not given one.
 * `owner`/`repo` come from `OIDE_PUBLISH_OWNER` / `OIDE_PUBLISH_REPO` at build time; anything
 * missing or malformed means "no feed", and the updater stays off.
 */
export function publishTarget(owner: string | undefined, repo: string | undefined): PublishTarget | null {
  const o = owner?.trim() ?? '';
  const r = repo?.trim() ?? '';
  if (!GITHUB_OWNER.test(o) || !GITHUB_REPO.test(r)) return null;
  return { owner: o, repo: r, releasesUrl: `https://github.com/${o}/${r}/releases` };
}
