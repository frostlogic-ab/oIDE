import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Security round 2, SEC-34 (medium). Every workflow used third-party actions by moving tag
 * (`pnpm/action-setup@v4`, `actions/*@v4`, `github/codeql-action/*@v3`). The release job runs with
 * `contents: write` and the Windows/macOS signing secrets in its env; a re-pointed tag (a hijacked
 * maintainer account, as with tj-actions/changed-files in 2025) would run attacker code there and
 * could sign and publish a backdoored installer that auto-update then offers. The release jobs also
 * restored the pnpm store from the Actions cache, which any workflow on main can write.
 * Secure behaviour: every `uses:` is pinned to a full commit SHA (Dependabot's github-actions
 * ecosystem keeps the pins and their `# vN` comments current), release jobs use no dependency
 * cache, nothing uses `pull_request_target`, and no `run:` step expands `github.event.*` or
 * `github.head_ref` (PR titles, branch names) into the shell; only the integer PR number may appear.
 */
const dir = join(import.meta.dirname, '..', '..', '.github', 'workflows');
const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));
const read = (f: string) => readFileSync(join(dir, f), 'utf8');

/**
 * True when a `${{ }}` expression reads `github.head_ref` or a `github.event.*` field. Integer
 * fields (the PR number) cannot carry shell syntax, so they are allowed; anything with
 * attacker-chosen text (titles, bodies, branch names, labels) is not.
 */
function expandsUntrustedEventField(text: string): boolean {
  const masked = text.replace(/github\.event\.pull_request\.number\b/g, 'SAFE_INT');
  return /\$\{\{[^}]*github\.(event\.|head_ref)/.test(masked);
}

describe('SEC-34 GitHub workflows', () => {
  it('pins every action to a commit SHA', () => {
    const loose: string[] = [];
    for (const f of files) {
      for (const m of read(f).matchAll(/^\s*-?\s*uses:\s*([^\s#]+)/gm)) {
        const ref = m[1]!;
        if (ref.startsWith('./')) continue;
        if (!/@[0-9a-f]{40}$/.test(ref)) loose.push(`${f}: ${ref}`);
      }
    }
    expect(loose).toEqual([]);
  });

  it('release builds use no dependency cache', () => {
    expect(read('release.yml')).not.toMatch(/^\s*cache:/m);
  });

  it('never runs fork code with secrets or expands untrusted event fields in run steps', () => {
    for (const f of files) {
      const t = read(f);
      expect(t, f).not.toMatch(/pull_request_target|workflow_run/);
      expect(expandsUntrustedEventField(t), f).toBe(false);
    }
  });

  it('allows integer event fields but flags text fields, even in a larger expression', () => {
    expect(expandsUntrustedEventField('group: ci-${{ github.event.pull_request.number || github.sha }}')).toBe(false);
    expect(expandsUntrustedEventField('run: echo ${{ github.event.pull_request.title }}')).toBe(true);
    expect(expandsUntrustedEventField('run: echo ${{ github.head_ref }}')).toBe(true);
    expect(
      expandsUntrustedEventField('x: ${{ github.event.pull_request.number || github.event.pull_request.title }}'),
    ).toBe(true);
  });
});
