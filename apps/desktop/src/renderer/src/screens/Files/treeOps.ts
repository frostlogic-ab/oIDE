/**
 * Pure helpers for managing files from the tree (new, rename, copy / cut / paste, delete): name
 * validation for the inline name field and path arithmetic. Paths are relative to a checkout root
 * with `/` separators; '' is the root itself.
 */

export const parentDir = (path: string): string => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
export const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1);
export const joinRel = (dir: string, name: string): string => (dir ? `${dir}/${name}` : name);

/** True when `path` is `base` or inside it. */
export const isUnder = (path: string, base: string): boolean => path === base || path.startsWith(`${base}/`);

/** `path` moved from under `from` to under `to` (unchanged when it is not under `from`). */
export function remapPath(path: string, from: string, to: string): string {
  if (path === from) return to;
  return path.startsWith(`${from}/`) ? to + path.slice(from.length) : path;
}

// Windows refuses these in names; refusing them everywhere keeps a checkout usable on every OS.
const BAD_CHARS = /[<>:"|?*\u0000-\u001f]/;
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/**
 * Why `input` cannot be used as a new name in folder `dir` (undefined when it can). `/` makes
 * missing folders ("utils/helpers.ts"); `siblings` are the names already in `dir` (case-insensitive,
 * as on Windows and macOS); `self` is the entry being renamed, which may keep its name in another case.
 */
export function validateName(input: string, siblings: readonly string[], self?: string): string | undefined {
  const name = input.replace(/\\/g, '/');
  if (!name.trim()) return 'A file or folder name must be provided.';
  if (name !== name.trim()) return 'Leading or trailing whitespace is not allowed in file and folder names.';
  if (name.startsWith('/')) return 'A file or folder name cannot start with a slash.';
  const parts = name.split('/');
  for (const [i, p] of parts.entries()) {
    if (!p) return i === parts.length - 1 ? 'A file or folder name must be provided.' : 'A file or folder name cannot contain an empty folder name.';
    if (p === '.' || p === '..') return `The name ${p} is not valid as a file or folder name.`;
    if (p === '.git') return 'The .git folder is managed by git.';
    if (BAD_CHARS.test(p)) return `The name ${p} contains a character that is not allowed in file names.`;
    if (RESERVED.test(p)) return `${p} is a reserved name on Windows.`;
    if (/[. ]$/.test(p)) return `The name ${p} cannot end with a dot or a space.`;
  }
  const first = parts[0]!.toLowerCase();
  if (self !== undefined && first === self.toLowerCase()) return undefined;
  if (siblings.some((s) => s.toLowerCase() === first)) return `A file or folder ${parts[0]} already exists at this location. Choose a different name.`;
  return undefined;
}

/** Characters of `name` to select when renaming: the stem of a file ("index" of "index.ts"), all of a folder. */
export function stemLength(name: string, kind: 'file' | 'dir'): number {
  if (kind === 'dir') return name.length;
  const dot = name.lastIndexOf('.');
  return dot > 0 ? dot : name.length;
}
