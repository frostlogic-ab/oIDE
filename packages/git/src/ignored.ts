import { toGit, type Repo } from './git.js';

/**
 * Which of `paths` (relative to the repo's cwd, `/` separators) the checkout's ignore rules
 * (`.gitignore`, `.git/info/exclude`, `core.excludesFile`) exclude, for the Files tree's greyed-out
 * rows (VS Code explorer style). Uses `git check-ignore`, so:
 *
 * - a tracked file is never reported, even when a pattern matches it (git does not ignore it);
 * - anything inside an ignored folder is reported too;
 * - outside a git checkout (an artifact folder) nothing is ignored, and a failing git never throws.
 */
export async function ignoredPaths(repo: Repo, paths: readonly string[]): Promise<Set<string>> {
  const out = new Set<string>();
  const want = paths.filter((p) => p && !p.includes('\0'));
  if (!want.length) return out;
  try {
    const r = await toGit(repo).run(['check-ignore', '-z', '--stdin'], {
      input: want.map((p) => `${p}\0`).join(''),
      // 1 = nothing ignored, 128 = not a git checkout.
      okExitCodes: [0, 1, 128],
      env: { GIT_OPTIONAL_LOCKS: '0' },
      timeoutMs: 10_000,
    });
    if (r.exitCode !== 0) return out;
    for (const p of r.stdout.split('\0')) if (p) out.add(p.replace(/\\/g, '/'));
  } catch {
    // git missing or timed out: show nothing as ignored rather than failing the listing.
  }
  return out;
}
