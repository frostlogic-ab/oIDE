import { CommitInfo } from '@oide/protocol';
import { toGit, type Repo } from './git.js';

/** The trailer oIDE agents put on their commits. */
export const AGENT_TRAILER = 'Oide-Agent';

const US = '\x1f';
/** sha, author, author time, Oide-Agent trailer values, subject, body. Records end with NUL (`-z`). */
const FORMAT = ['%H', '%an', '%at', `%(trailers:key=${AGENT_TRAILER},valueonly,separator=%x1e)`, '%s', '%b'].join('%x1f');

export function parseLog(text: string): CommitInfo[] {
  const out: CommitInfo[] = [];
  for (const rec of text.split('\0')) {
    const trimmed = rec.replace(/^\n+/, '');
    if (!trimmed) continue;
    const f = trimmed.split(US);
    if (f.length < 6) continue;
    const [sha, author, at, trailer, subject] = f;
    const body = f.slice(5).join(US).trim();
    const agent = (trailer ?? '').split('\x1e')[0]?.trim() || undefined;
    out.push(
      CommitInfo.parse({
        sha: sha!.trim(),
        message: subject ?? '',
        body: body || undefined,
        author: author ?? '',
        agent,
        ts: Number(at) * 1000,
      }),
    );
  }
  return out;
}

/** Recent commits on `ref` (default HEAD), newest first. Empty for an unborn branch. */
export async function log(repo: Repo, ref = 'HEAD', limit = 20): Promise<CommitInfo[]> {
  const git = toGit(repo);
  if (!(await git.revParse(ref))) return [];
  const out = await git.out(['log', '-z', `-n${Math.max(1, Math.floor(limit))}`, `--format=${FORMAT}`, ref, '--']);
  return parseLog(out);
}

/** History of one file, following renames, newest first. */
export async function fileHistory(repo: Repo, path: string, limit = 50): Promise<CommitInfo[]> {
  const git = toGit(repo);
  if (!(await git.revParse('HEAD'))) return [];
  const out = await git.out(['log', '-z', '--follow', `-n${Math.max(1, Math.floor(limit))}`, `--format=${FORMAT}`, 'HEAD', '--', path]);
  return parseLog(out);
}
