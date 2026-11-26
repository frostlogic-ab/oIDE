import { afterAll, describe, expect, it } from 'vitest';
import {
  branchSubjects,
  composePr,
  conventionalTitle,
  fillTemplate,
  findPrTemplate,
  historyIsConventional,
  parseConventional,
  readPrConventions,
} from '../src/pr-draft.js';
import { cleanup, commitAll, makeRepo, sh, tempDir, write } from './helpers.js';

afterAll(cleanup);

const TEMPLATE = [
  '## Summary',
  '',
  '<!-- What changes for the user, and why. -->',
  '',
  '## How I tested it',
  '',
  '<!-- Unit tests, e2e, manual steps. -->',
  '',
  '## Checklist',
  '',
  '- [ ] Tests pass',
  '- [ ] Wiki updated',
  '',
].join('\n');

describe('PR templates', () => {
  it("finds GitHub's template locations, in GitHub's order, case-insensitively", async () => {
    const root = tempDir();
    expect(await findPrTemplate(root)).toBeUndefined();
    write(root, 'docs/pull_request_template.md', 'docs one');
    expect(await findPrTemplate(root)).toEqual({ path: 'docs/pull_request_template.md', text: 'docs one' });
    write(root, 'PULL_REQUEST_TEMPLATE.md', 'root one');
    expect((await findPrTemplate(root))?.path).toBe('PULL_REQUEST_TEMPLATE.md');
    write(root, '.github/PULL_REQUEST_TEMPLATE.md', 'github one\r\nline');
    expect(await findPrTemplate(root)).toEqual({ path: '.github/PULL_REQUEST_TEMPLATE.md', text: 'github one\nline' });
  });

  it('takes the default file of a template folder, else the first', async () => {
    const root = tempDir();
    write(root, '.github/PULL_REQUEST_TEMPLATE/feature.md', 'feature');
    write(root, '.github/PULL_REQUEST_TEMPLATE/bug.md', 'bug');
    expect((await findPrTemplate(root))?.text).toBe('bug');
    write(root, '.github/PULL_REQUEST_TEMPLATE/default.md', 'default');
    expect((await findPrTemplate(root))?.text).toBe('default');
  });

  it("fills the summary and checks under the template's own headings and keeps the rest", () => {
    const body = fillTemplate(TEMPLATE, 'Tiles can be filtered.', [
      { name: 'pnpm test', status: 'passed' },
      { name: 'pnpm e2e', status: 'skipped', detail: 'no display' },
    ]);
    expect(body).toBe(
      [
        '## Summary',
        '',
        '<!-- What changes for the user, and why. -->',
        '',
        'Tiles can be filtered.',
        '',
        '## How I tested it',
        '',
        '<!-- Unit tests, e2e, manual steps. -->',
        '',
        '- [x] pnpm test',
        '- [ ] skipped pnpm e2e: no display',
        '',
        '## Checklist',
        '',
        '- [ ] Tests pass',
        '- [ ] Wiki updated',
        '',
      ].join('\n'),
    );
  });

  it('puts the summary on top and the checks at the end when the template has no such headings', () => {
    const body = fillTemplate('- [ ] I read CONTRIBUTING.md\n', 'Did it.', [{ name: 'lint', status: 'failed' }]);
    expect(body).toBe('Did it.\n\n- [ ] I read CONTRIBUTING.md\n\nChecks the agent ran:\n- [ ] FAILED lint\n');
  });

  it('handles a multi-line guidance comment and a "Description" / "Testing" template', () => {
    const t = '# Description\n<!--\nDescribe it.\n-->\n\n# Testing\n';
    expect(fillTemplate(t, 'Sum.', [{ name: 'test', status: 'passed' }])).toBe('# Description\n<!--\nDescribe it.\n-->\n\nSum.\n\n# Testing\n\n- [x] test\n');
  });
});

describe('Conventional Commits titles', () => {
  it('parses conventional subjects', () => {
    expect(parseConventional('feat(wall): add tile filters')).toEqual({ type: 'feat', scope: 'wall', breaking: false, subject: 'add tile filters' });
    expect(parseConventional('fix!: drop the old flag')).toMatchObject({ type: 'fix', breaking: true });
    expect(parseConventional('Add tile filters')).toBeUndefined();
    expect(parseConventional('note: not a type')).toBeUndefined();
  });

  it('keeps a title that already follows the convention', () => {
    expect(conventionalTitle('fix(git): keep changes on merge')).toBe('fix(git): keep changes on merge');
  });

  it("types the title from the branch's commits: strongest type, shared scope, breaking", () => {
    expect(conventionalTitle('Add tile filters', ['fix(wall): tidy', 'feat(wall): filters', 'test(wall): cover it'])).toBe('feat(wall): add tile filters');
    expect(conventionalTitle('Add tile filters', ['fix(wall): a', 'feat(git): b'])).toBe('feat: add tile filters');
    expect(conventionalTitle('Drop the v1 API', ['refactor!: drop v1'])).toBe('refactor!: drop the v1 API');
  });

  it("falls back to the title's words, and keeps acronyms and brand names", () => {
    expect(conventionalTitle('Fix crash on quit.')).toBe('fix: fix crash on quit');
    expect(conventionalTitle('Update the wiki page for Files')).toBe('docs: update the wiki page for Files');
    expect(conventionalTitle('CI cache for pnpm')).toBe('ci: CI cache for pnpm');
    expect(conventionalTitle('GitHub sign-in hint')).toBe('feat: GitHub sign-in hint');
    expect(conventionalTitle('Tile filters')).toBe('feat: tile filters');
  });

  it('reads the history as conventional only when most of enough recent subjects are', () => {
    expect(historyIsConventional(['feat: a', 'fix: b', 'docs: c', 'chore: d', 'Merge branch x', 'Tidy'])).toBe(true);
    expect(historyIsConventional(['feat: a', 'fix: b'])).toBe(false);
    expect(historyIsConventional(['Add a', 'Fix b', 'Docs c', 'feat: d', 'Tidy e'])).toBe(false);
  });
});

describe('readPrConventions', () => {
  it('detects Conventional Commits from config files, workflows, package.json or history', async () => {
    const plain = makeRepo();
    expect(await readPrConventions(plain)).toEqual({ conventional: false });

    const rp = tempDir();
    write(rp, 'release-please-config.json', '{}');
    expect(await readPrConventions(rp)).toEqual({ conventional: true, conventionalSource: 'release-please' });

    const cl = tempDir();
    write(cl, 'commitlint.config.mjs', 'export default {}');
    expect((await readPrConventions(cl)).conventionalSource).toBe('commitlint');

    const pkg = tempDir();
    write(pkg, 'package.json', JSON.stringify({ name: 'x', commitlint: { extends: [] } }));
    expect((await readPrConventions(pkg)).conventionalSource).toBe('commitlint');

    const wf = tempDir();
    write(wf, '.github/workflows/pr.yml', 'steps:\n  - uses: amannn/action-semantic-pull-request@v5\n');
    write(wf, '.github/pull_request_template.md', '## Summary\n');
    expect(await readPrConventions(wf)).toEqual({ template: { path: '.github/pull_request_template.md', text: '## Summary\n' }, conventional: true, conventionalSource: 'workflow' });

    const hist = makeRepo();
    for (const m of ['feat: a', 'fix: b', 'docs: c', 'chore: d', 'feat(x): e']) {
      write(hist, `${m.length}-${Math.random()}.txt`, m);
      commitAll(hist, m);
    }
    expect((await readPrConventions(hist, { baseRef: 'main' })).conventionalSource).toBe('history');
  });

  it("lists the branch's own commit subjects", async () => {
    const repo = makeRepo();
    sh(repo, 'checkout', '-q', '-b', 'oide/x');
    write(repo, 'a.txt', 'a');
    commitAll(repo, 'feat(wall): filters');
    expect(await branchSubjects(repo, 'main', 'oide/x')).toEqual(['feat(wall): filters']);
    expect(await branchSubjects(repo, '--evil', 'oide/x')).toEqual([]);
  });
});

describe('composePr', () => {
  const conventions = { conventional: true, template: { path: '.github/pull_request_template.md', text: TEMPLATE } };

  it("uses the agent's draft as written (typing the title only if it breaks the title rule)", () => {
    expect(composePr({ title: 'x', agentDraft: { title: 'feat(wall): filters', body: 'B' }, conventions })).toEqual({ title: 'feat(wall): filters', body: 'B', source: 'agent' });
    expect(composePr({ title: 'x', agentDraft: { title: 'Filters', body: 'B' }, conventions }).title).toBe('feat: filters');
  });

  it('fills the template, else joins the summary and checks', () => {
    expect(composePr({ title: 'Tile filters', summary: 'S', conventions })).toMatchObject({ title: 'feat: tile filters', source: 'template' });
    expect(composePr({ title: 'Tile filters', summary: 'S', checks: [{ name: 't', status: 'passed' }], conventions: { conventional: false } })).toEqual({
      title: 'Tile filters',
      body: 'S\n\nChecks the agent ran:\n- [x] t',
      source: 'plain',
    });
  });
});
