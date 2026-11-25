import { z } from 'zod';

/**
 * New project (the "New project" dialog): open a folder, initialise git in a plain folder, clone a
 * repository, or create a new one. Shared by the renderer (live validation) and main (the IPC
 * contract), so both refuse the same input.
 */

/** Windows device names that cannot be folder names (case-insensitive, with or without extension). */
const RESERVED = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\..*)?$/i;

/** Why a new folder name is refused, or undefined when it is fine. Same rules on every OS (repos travel). */
export function folderNameProblem(name: string): string | undefined {
  if (!name.trim()) return 'Enter a folder name.';
  if (name.length > 255) return 'Use at most 255 characters.';
  if (name === '.' || name === '..') return 'Choose another name.';
  // `.git` in any spelling git or the file system treats as it (case, trailing dots/spaces, the NTFS short name).
  if (/^(?:\.git|git~1)[. ]*$/i.test(name)) return 'A project folder cannot be named .git.';
  // eslint-disable-next-line no-control-regex
  if (/[\\/:*?"<>|\x00-\x1f]/.test(name)) return 'A folder name cannot contain \\ / : * ? " < > | or control characters.';
  if (/[. ]$/.test(name)) return 'A folder name cannot end with a dot or a space.';
  if (/^\s/.test(name)) return 'A folder name cannot start with a space.';
  if (name.startsWith('-')) return 'A folder name cannot start with "-".';
  if (RESERVED.test(name)) return `"${name}" is reserved on Windows. Choose another name.`;
  return undefined;
}

export const FolderName = z.string().superRefine((v, ctx) => {
  const p = folderNameProblem(v);
  if (p) ctx.addIssue({ code: 'custom', message: p });
});

const HOST = '[A-Za-z0-9](?:[A-Za-z0-9-]{0,62})(?:\\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}))*|\\[[0-9A-Fa-f:.]{2,45}\\]';
const URL_FORMS: RegExp[] = [
  // https://host[:port]/path, http://, git://, ssh://[user@]host[:port]/path
  new RegExp(`^(?:https?|git)://(?:[^@/\\s]{1,200}@)?(?:${HOST})(?::\\d{1,5})?/[^\\s]+$`),
  new RegExp(`^ssh://(?:[A-Za-z0-9_][A-Za-z0-9._~-]{0,63}@)?(?:${HOST})(?::\\d{1,5})?/[^\\s]+$`),
  // scp-like: user@host:path (the user part is required, so `C:\repo` never matches)
  new RegExp(`^[A-Za-z0-9_][A-Za-z0-9._~-]{0,63}@(?:${HOST}):(?!/)(?!-)[^\\s]+$`),
];

/**
 * Why a clone URL is refused, or undefined when it is fine. Only network transports that cannot
 * run a command: https, http, git, ssh (also `user@host:path`). Never an `ext::` or other remote
 * helper, never an option (`-…`), never whitespace, and never a local path or `file://` URL (SEC-08:
 * the renderer must not be able to copy any repository on disk into a folder it can then read; a
 * local repository is opened with Open folder instead).
 */
export function cloneUrlProblem(url: string): string | undefined {
  const u = url.trim();
  if (!u) return 'Enter the repository URL.';
  if (u.length > 2048) return 'That URL is too long.';
  if (u.startsWith('-')) return 'That is not a repository URL.';
  // eslint-disable-next-line no-control-regex
  if (/[\s\x00-\x1f\\]/.test(u)) return 'A repository URL cannot contain spaces or backslashes.';
  if (/^[A-Za-z][A-Za-z0-9+.-]*::/.test(u)) return 'Remote helpers (like ext::) are not supported. Use an https or ssh URL.';
  if (URL_FORMS.some((re) => re.test(u))) return undefined;
  return 'Use an https or ssh URL, like https://github.com/owner/repo.git or git@github.com:owner/repo.git.';
}

export const CloneUrl = z
  .string()
  .max(2048)
  .transform((s) => s.trim())
  .superRefine((v, ctx) => {
    const p = cloneUrlProblem(v);
    if (p) ctx.addIssue({ code: 'custom', message: p });
  });

/**
 * What the user typed in "Repository" → a clone URL. `owner/repo` (GitHub shorthand) becomes
 * `https://github.com/owner/repo.git`; a github.com page link (`…/owner/repo/tree/main`) becomes
 * its clone URL; anything else is returned trimmed.
 */
export function normalizeCloneInput(input: string): string {
  const s = input.trim();
  if (/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/.test(s) && !s.endsWith('.')) {
    const [owner, repo] = s.split('/') as [string, string];
    return `https://github.com/${owner}/${repo.replace(/\.git$/i, '')}.git`;
  }
  const gh = /^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?(?:\/(?:tree|blob|pulls?|issues|commits?|actions)(?:\/.*)?)?\/?(?:[?#].*)?$/i.exec(s);
  if (gh) return `https://github.com/${gh[1]}/${gh[2]}.git`;
  return s;
}

/** The folder name a clone gets by default: the last path segment without `.git`. */
export function repoNameFromUrl(url: string): string {
  const s = url.trim().replace(/[?#].*$/, '').replace(/[/\\]+$/, '');
  const last = s.split(/[/:\\]/).pop() ?? '';
  const name = last.replace(/\.git$/i, '');
  return folderNameProblem(name) ? '' : name;
}

/** `projects.cloneProgress`: what git is doing and, when it says, how far it is. */
export const CloneProgress = z.object({
  /** `Receiving objects`, `Resolving deltas`, `Updating files`, … (git's own phase names). */
  phase: z.string().max(80),
  percent: z.number().min(0).max(100).optional(),
});
export type CloneProgress = z.infer<typeof CloneProgress>;

/** One of the user's GitHub repositories (`gh repo list`), for Clone › From GitHub. */
export const GithubRepo = z.object({
  nameWithOwner: z.string(),
  description: z.string().optional(),
  isPrivate: z.boolean().default(false),
  /** What to clone: https or ssh, following `gh config get git_protocol`. */
  cloneUrl: z.string(),
  updatedAt: z.string().optional(),
});
export type GithubRepo = z.infer<typeof GithubRepo>;
