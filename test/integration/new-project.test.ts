import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { GhCli } from '../../packages/git/src/index.js';
import { cleanup, git, makeRepo, startHarness, tempDir, type Harness } from './harness.js';

/**
 * New project (the renderer's New project dialog) through the real IPC router: create a repository,
 * initialise git in a folder, clone, and the GitHub list. Git config is isolated so the first
 * commit's identity never depends on the developer's machine.
 */

const saved = { global: process.env.GIT_CONFIG_GLOBAL, nosystem: process.env.GIT_CONFIG_NOSYSTEM, xdg: process.env.XDG_CONFIG_HOME };
let withIdentity = '';
let noIdentity = '';
beforeAll(() => {
  const home = tempDir('oide-np-home-');
  withIdentity = join(home, 'with');
  noIdentity = join(home, 'without');
  writeFileSync(withIdentity, '[user]\n\tname = oIDE Test\n\temail = test@oide.invalid\n[commit]\n\tgpgsign = false\n[core]\n\tautocrlf = false\n');
  writeFileSync(noIdentity, '[commit]\n\tgpgsign = false\n');
  process.env.GIT_CONFIG_GLOBAL = withIdentity;
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  process.env.XDG_CONFIG_HOME = home;
  dirs.push(home);
});
afterAll(() => {
  for (const [k, v] of [['GIT_CONFIG_GLOBAL', saved.global], ['GIT_CONFIG_NOSYSTEM', saved.nosystem], ['XDG_CONFIG_HOME', saved.xdg]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const open: Harness[] = [];
const dirs: string[] = [];
afterEach(async () => {
  process.env.GIT_CONFIG_GLOBAL = withIdentity;
  while (open.length) await open.pop()!.close().catch(() => undefined);
  cleanup(...dirs.splice(1));
});
afterAll(() => cleanup(...dirs.splice(0)));

async function harness(opts: Parameters<typeof startHarness>[0] = {}): Promise<Harness> {
  const h = await startHarness(opts);
  open.push(h);
  dirs.push(h.userData);
  return h;
}

function place(): string {
  const d = tempDir('oide-np-');
  dirs.push(d);
  return d;
}

const commits = (repo: string) => git(repo, 'rev-list', '--count', 'HEAD');

describe('projects.create', () => {
  it('only in a picked location, then a trusted repo on main with a README commit', async () => {
    const h = await harness();
    const parent = place();
    expect(await h.fails('projects.create', { parent, name: 'fresh' })).toBe('forbidden_path');
    expect(existsSync(join(parent, 'fresh'))).toBe(false);

    h.allowOpen(parent);
    const p = await h.call('projects.create', { parent, name: 'fresh' });
    const dir = join(parent, 'fresh');
    expect(p.name).toBe('fresh');
    expect(p.trusted).toBe(true);
    expect(readFileSync(join(dir, 'README.md'), 'utf8')).toBe('# fresh\n');
    expect(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
    expect(commits(dir)).toBe('1');
    expect(git(dir, 'status', '--porcelain')).toBe('');
    expect((await h.call('projects.list', undefined)).map((x) => x.id)).toContain(p.id);

    // The folder that holds an open project is a known location: no new pick needed.
    const bare = await h.call('projects.create', { parent, name: 'bare', readme: false });
    expect(readdirSync(join(parent, 'bare'))).toEqual(['.git']);
    expect(commits(join(parent, 'bare'))).toBe('1');
    expect(bare.trusted).toBe(true);
  });

  it('refuses a folder that exists with files, reuses an empty one', async () => {
    const h = await harness();
    const parent = place();
    h.allowOpen(parent);
    mkdirSync(join(parent, 'taken'));
    writeFileSync(join(parent, 'taken', 'mine.txt'), 'x');
    expect(await h.fails('projects.create', { parent, name: 'taken' })).toBe('conflict');
    expect(readdirSync(join(parent, 'taken'))).toEqual(['mine.txt']);

    mkdirSync(join(parent, 'empty'));
    await h.call('projects.create', { parent, name: 'empty' });
    expect(commits(join(parent, 'empty'))).toBe('1');
  });

  it('refuses names that are not one folder, and .git', async () => {
    const h = await harness();
    const parent = place();
    h.allowOpen(parent);
    for (const name of ['../up', 'a/b', '.git', 'GIT~1', 'CON']) expect(await h.fails('projects.create', { parent, name })).toBe('invalid_input');
  });

  it('says how to set a git identity before it creates anything', async () => {
    const h = await harness();
    const parent = place();
    h.allowOpen(parent);
    process.env.GIT_CONFIG_GLOBAL = noIdentity;
    expect(await h.fails('projects.create', { parent, name: 'who' })).toBe('unavailable');
    expect(existsSync(join(parent, 'who'))).toBe(false);
  });
});

describe('projects.initFolder', () => {
  it('Open folder on a plain folder says not_a_repo; Initialize git commits its files (not the ignored ones)', async () => {
    const h = await harness();
    const dir = place();
    writeFileSync(join(dir, 'app.js'), 'console.log(1);\n');
    writeFileSync(join(dir, '.gitignore'), 'secret.env\n');
    writeFileSync(join(dir, 'secret.env'), 'TOKEN=x\n');
    expect(await h.fails('projects.initFolder', { path: dir })).toBe('forbidden_path');
    h.allowOpen(dir);
    expect(await h.fails('projects.open', { path: dir })).toBe('not_a_repo');

    const p = await h.call('projects.initFolder', { path: dir });
    expect(p.path.toLowerCase()).toBe(dir.toLowerCase());
    expect(git(dir, 'ls-files').split('\n').sort()).toEqual(['.gitignore', 'app.js']);
    expect(git(dir, 'status', '--porcelain')).toBe('');
  });

  it('commitFiles: false makes an empty first commit and leaves the files untracked', async () => {
    const h = await harness();
    const dir = place();
    writeFileSync(join(dir, 'notes.md'), 'hi\n');
    h.allowOpen(dir);
    await h.call('projects.initFolder', { path: dir, commitFiles: false });
    expect(commits(dir)).toBe('1');
    expect(git(dir, 'ls-files')).toBe('');
    expect(git(dir, 'status', '--porcelain')).toBe('?? notes.md');
  });

  it('a folder that already is a repository just opens', async () => {
    const h = await harness();
    const repo = makeRepo();
    dirs.push(repo);
    h.allowOpen(repo);
    const p = await h.call('projects.initFolder', { path: repo });
    expect(commits(repo)).toBe('1');
    expect((await h.call('projects.list', undefined)).map((x) => x.id)).toEqual([p.id]);
  });

  it('leaves no .git behind when the first commit cannot be made', async () => {
    const h = await harness();
    const dir = place();
    writeFileSync(join(dir, 'a.txt'), 'a');
    h.allowOpen(dir);
    process.env.GIT_CONFIG_GLOBAL = noIdentity;
    expect(await h.fails('projects.initFolder', { path: dir })).toBe('unavailable');
    expect(existsSync(join(dir, '.git'))).toBe(false);
  });
});

describe('projects.clone', () => {
  it('refuses URLs that could run a command or read local repositories', async () => {
    const h = await harness();
    const parent = place();
    h.allowOpen(parent);
    for (const url of ['ext::sh -c touch% /tmp/x', '--upload-pack=touch x', 'file:///C:/repo', makeRepoPath(), 'fd::3']) {
      expect(await h.fails('projects.clone', { url, parent, name: 'x' })).toBe('invalid_input');
    }
    expect(readdirSync(parent)).toEqual([]);
  });

  it('clones, streams progress and asks for trust', async () => {
    let asked = 0;
    const h = await harness({ platform: { confirmTrust: async () => (asked++, false) } });
    const src = makeRepo();
    dirs.push(src);
    const parent = place();
    h.allowOpen(parent);
    // Local sources never pass the IPC schema; the service itself is what the schema guards.
    const p = (await h.services.projects.clone(src, parent, 'copy'))!;
    expect(p.name).toBe('copy');
    expect(p.trusted).toBe(false);
    expect(asked).toBe(1);
    expect(readFileSync(join(parent, 'copy', 'README.md'), 'utf8')).toBe('# fixture\n');
    expect(h.eventsOf('projects.cloneProgress')[0]).toEqual({ phase: 'Connecting' });
  });

  it('a failed clone leaves no folder behind, and an empty folder stays empty', async () => {
    const h = await harness();
    const parent = place();
    h.allowOpen(parent);
    await expect(h.services.projects.clone(join(parent, 'nowhere'), parent, 'copy')).rejects.toMatchObject({ code: 'clone_failed', reason: 'not_found' });
    expect(existsSync(join(parent, 'copy'))).toBe(false);
    mkdirSync(join(parent, 'kept'));
    await expect(h.services.projects.clone(join(parent, 'nowhere'), parent, 'kept')).rejects.toMatchObject({ code: 'clone_failed' });
    expect(readdirSync(join(parent, 'kept'))).toEqual([]);
    expect(await h.call('projects.list', undefined)).toEqual([]);
    expect(await h.call('projects.cancelClone', undefined)).toEqual({ ok: true });
  });

  it('needs a picked location', async () => {
    const h = await harness();
    const parent = place();
    expect(await h.fails('projects.clone', { url: 'https://github.com/o/r.git', parent, name: 'r' })).toBe('forbidden_path');
  });
});

describe('projects.githubRepos', () => {
  it('lists the repos from the user’s gh, or says why not', async () => {
    const repos = [{ nameWithOwner: 'o/r', isPrivate: true, cloneUrl: 'https://github.com/o/r.git' }];
    const gh = { listRepos: async () => repos, available: async () => true, prLookup: async () => ({ unavailable: true }), refresh: () => {} } as unknown as GhCli;
    const h = await harness({ gh });
    expect(await h.call('projects.githubRepos', undefined)).toEqual({ available: true, repos });

    const off = { listRepos: async () => undefined, available: async () => false, prLookup: async () => ({ unavailable: true }), refresh: () => {} } as unknown as GhCli;
    const h2 = await harness({ gh: off });
    const r = await h2.call('projects.githubRepos', undefined);
    expect(r.available).toBe(false);
    expect(r.reason).toMatch(/gh auth login/);
  });
});

function makeRepoPath(): string {
  return process.platform === 'win32' ? 'C:\\repos\\local' : '/srv/repos/local';
}
